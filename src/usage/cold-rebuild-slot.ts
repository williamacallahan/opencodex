/**
 * The one slot a whole-ledger rebuild runs in when a request asked for an answer it did not have.
 *
 * A cold read of usage.jsonl is proportional to the ledger (about 7 s and 5 s of CPU per GiB), longer
 * than a dashboard waits. So a request never awaits or races one: it registers the rebuild here and
 * answers at once, with a dated answer it already holds or "not yet" (`UsageColdReadPendingError`, a
 * 503 with Retry-After at the route). The build starts on the next timer turn, because the scanner
 * reads its first chunk before it first yields and must not do so on the request's turn. Only one
 * rebuild runs at a time and nothing queues behind it: a request for a different answer while the slot
 * is busy is told to retry, so an arbitrary stream of distinct filters cannot line up whole-ledger scans.
 * A finished build publishes its answer into its owner's cache, where the retry finds it.
 */

/** What a route tells the client to wait before asking again. */
export const USAGE_COLD_READ_RETRY_AFTER_SECONDS = 5;

export class UsageColdReadPendingError extends Error {
  readonly retryAfterSeconds = USAGE_COLD_READ_RETRY_AFTER_SECONDS;
  constructor(readonly state: "started" | "running" | "busy") {
    super(`usage rebuild ${state}`);
    this.name = "UsageColdReadPendingError";
  }
}

let running: { key: string; done: Promise<void> } | null = null;
/**
 * A build that failed is answered as that failure for one Retry-After interval, so the retry it asked
 * for learns the outcome instead of starting the same failing scan again. At most one entry per key.
 */
const recentFailures = new Map<string, { at: number; error: unknown }>();
const MAX_REMEMBERED_FAILURES = 16;

function rememberedFailure(key: string): unknown {
  const failure = recentFailures.get(key);
  if (!failure) return undefined;
  if (Date.now() - failure.at >= 0 && Date.now() - failure.at < USAGE_COLD_READ_RETRY_AFTER_SECONDS * 1_000) return failure.error;
  recentFailures.delete(key);
  return undefined;
}

/**
 * Register `build` in the slot unless it is occupied, and start it on the next timer turn. Returns
 * whether this call started it, found a rebuild of the same key, or found the slot busy with another.
 * The build's failure is logged and left for the next request to retry.
 */
export function startUsageColdRebuild(key: string, build: () => Promise<unknown>): "started" | "running" | "busy" {
  if (running) return running.key === key ? "running" : "busy";
  const entry: { key: string; done: Promise<void> } = {
    key,
    done: new Promise<void>(resolve => setTimeout(resolve, 0))
      .then(build)
      .then(
        () => { recentFailures.delete(key); },
        error => {
          console.warn(`[usage] background usage rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
          recentFailures.delete(key);
          recentFailures.set(key, { at: Date.now(), error });
          while (recentFailures.size > MAX_REMEMBERED_FAILURES) recentFailures.delete(recentFailures.keys().next().value!);
        },
      )
      .finally(() => {
        if (running === entry) running = null;
      }),
  };
  running = entry;
  return "started";
}

/**
 * Register the rebuild and throw the pending answer a request returns instead of waiting, or the
 * failure of the same key's build that just finished, which the route reports as a failed read.
 */
export function requestUsageColdRebuild(key: string, build: () => Promise<unknown>): never {
  const failure = rememberedFailure(key);
  if (failure !== undefined) throw failure;
  throw new UsageColdReadPendingError(startUsageColdRebuild(key, build));
}

/** Resolves once the slot is empty; for tests and benchmarks that need the completed answer. */
export async function settleUsageColdRebuildForTests(): Promise<void> {
  while (running) await running.done;
}

export function resetUsageColdRebuildForTests(): void {
  recentFailures.clear();
}
