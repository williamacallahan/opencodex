/**
 * The one slot a whole-ledger rebuild runs in when a request asked for an answer it did not have.
 *
 * A cold read of usage.jsonl is proportional to the ledger (about 6 s and 4 s of CPU per GiB), longer
 * than a dashboard waits. So a request never awaits one: it starts the rebuild here, or finds one
 * already running, and answers "not yet" (`UsageColdReadPendingError`, a 503 with Retry-After at the
 * route, after a short bounded wait) or a dated snapshot it already holds. Only one rebuild runs at a time and nothing queues behind
 * it: a request for a different answer while the slot is busy is told to retry, so an arbitrary stream
 * of distinct filters cannot line up whole-ledger scans.
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

/**
 * How long a request may wait on the slot before it is answered "not yet". A small ledger finishes
 * well inside it, so a fresh install never sees a 503; a large one is answered at this bound, and the
 * request itself reads no ledger bytes either way.
 */
export const USAGE_COLD_READ_WAIT_MS = 500;

let running: { key: string; promise: Promise<unknown> } | null = null;

/**
 * Start `build` in the slot unless it is occupied. Returns whether this call started it, joined a
 * rebuild of the same key, or found the slot busy with another. The build publishes its own result
 * into its owner's cache; its failure is logged and left for the next request to retry.
 */
export function startUsageColdRebuild(key: string, build: () => Promise<unknown>): "started" | "running" | "busy" {
  if (running) return running.key === key ? "running" : "busy";
  const promise = build();
  const entry = { key, promise };
  running = entry;
  promise.then(
    () => undefined,
    error => {
      console.warn(`[usage] background usage rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  ).finally(() => {
    if (running === entry) running = null;
  });
  return "started";
}

/**
 * Start (or join) the rebuild and wait for it at most {@link USAGE_COLD_READ_WAIT_MS}: its result when
 * it finishes in time, otherwise `UsageColdReadPendingError` while it keeps running. A slot busy with
 * another rebuild answers pending at once.
 */
export async function awaitUsageColdRebuild<T>(key: string, build: () => Promise<T>, waitMs = USAGE_COLD_READ_WAIT_MS): Promise<T> {
  const state = startUsageColdRebuild(key, build);
  if (state === "busy" || !running) throw new UsageColdReadPendingError(state);
  const promise = running.promise as Promise<T>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UsageColdReadPendingError(state)), waitMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves once the slot is empty; for tests and benchmarks that need the completed answer. */
export async function settleUsageColdRebuildForTests(): Promise<void> {
  while (running) await running.promise.catch(() => undefined);
}
