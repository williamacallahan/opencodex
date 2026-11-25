import { revisionAtPath } from "../usage/ledger-scanner";
import { usageLogIdentityKey, usageLogPath, usageLogRevisionKey, type UsageLogRevision } from "../usage/log";
import { aggregateTelemetryForDay, type DailyTelemetryAggregate } from "./aggregate";

/**
 * The aggregate a dashboard preview shows, without ever making the request wait for it.
 *
 * A day's aggregate scans usage.jsonl from its first byte, which on a large ledger takes longer than
 * the dashboard waits, and the telemetry and profile panels poll. So a request gets a completed
 * aggregate for the same home, ledger file and UTC day; or `pending` while its build runs in the
 * background (or while both build slots are busy); or `unavailable` while a failed build waits out its
 * backoff. A send never reads this: it builds a complete aggregate of its own.
 */
export type TelemetryPreviewAggregate =
  | { status: "ready"; aggregate: DailyTelemetryAggregate }
  | { status: "pending" | "unavailable" };

/** How long a completed aggregate is served, counted from its completion, before a rebuild picks up rows appended since. */
export const TELEMETRY_PREVIEW_FRESH_MS = 10 * 60 * 1000;
/** After a failed build, requests report `unavailable` this long before one tries again. */
const FAILED_BUILD_RETRY_MS = 60 * 1000;
/** The telemetry panel and the profile card can preview different days at once; each keeps its own entry. */
const MAX_PREVIEW_ENTRIES = 2;

interface PreviewEntry {
  path: string;
  identityKey: string;
  day: string;
  running: boolean;
  completed?: { at: number; aggregate: DailyTelemetryAggregate; size: number; revisionKey: string };
  failedAt?: number;
  lastUsedAt: number;
}

const entries = new Map<string, PreviewEntry>();

/**
 * Starts the entry's scan on the next timer turn. The scanner reads its first chunk before it first
 * yields, so starting it here, or in a microtask, would read ledger bytes on the request's turn.
 */
function launch(entry: PreviewEntry): void {
  entry.running = true;
  setTimeout(() => {
    let revision: UsageLogRevision | null = null;
    void aggregateTelemetryForDay(entry.day, {
      path: entry.path,
      expectedIdentityKey: entry.identityKey,
      observeRevision: observed => { revision = observed; },
    }).then(
      aggregate => {
        entry.running = false;
        entry.completed = {
          at: Date.now(),
          aggregate,
          size: revision?.size ?? 0,
          revisionKey: usageLogRevisionKey(revision),
        };
        delete entry.failedAt;
      },
      () => {
        entry.running = false;
        entry.failedAt = Date.now();
      },
    );
  }, 0);
}

/** A file that shrank, or changed without growing, is no longer the file the answer was read from. */
function rewrittenSince(completed: NonNullable<PreviewEntry["completed"]>, revision: UsageLogRevision | null): boolean {
  const size = revision?.size ?? 0;
  return size < completed.size || (size === completed.size && usageLogRevisionKey(revision) !== completed.revisionKey);
}

/** Room for a new key: the least recently used entry whose build has settled. A running build is never evicted. */
function admit(): boolean {
  if (entries.size < MAX_PREVIEW_ENTRIES) return true;
  let victim: [string, PreviewEntry] | null = null;
  for (const candidate of entries) {
    if (!candidate[1].running && (!victim || candidate[1].lastUsedAt < victim[1].lastUsedAt)) victim = candidate;
  }
  if (!victim) return false;
  entries.delete(victim[0]);
  return true;
}

export function telemetryPreviewAggregate(day: string, configDir: string, now: number = Date.now()): TelemetryPreviewAggregate {
  const path = usageLogPath(configDir);
  let revision: UsageLogRevision | null;
  try {
    revision = revisionAtPath(path);
  } catch {
    return { status: "unavailable" };
  }
  const identityKey = usageLogIdentityKey(revision);
  const key = JSON.stringify([configDir, path, identityKey, day]);
  let entry = entries.get(key);
  if (!entry) {
    if (!admit()) return { status: "pending" };
    entry = { path, identityKey, day, running: false, lastUsedAt: now };
    entries.set(key, entry);
    launch(entry);
    return { status: "pending" };
  }
  entry.lastUsedAt = now;
  if (entry.completed && rewrittenSince(entry.completed, revision)) delete entry.completed;
  if (entry.running) return entry.completed ? { status: "ready", aggregate: entry.completed.aggregate } : { status: "pending" };
  if (entry.failedAt !== undefined && now - entry.failedAt >= 0 && now - entry.failedAt < FAILED_BUILD_RETRY_MS) {
    return { status: "unavailable" };
  }
  const completed = entry.completed;
  const fresh = completed !== undefined && now - completed.at >= 0 && now - completed.at < TELEMETRY_PREVIEW_FRESH_MS;
  if (fresh) return { status: "ready", aggregate: completed.aggregate };
  // Cold, retried after backoff, or stale: rebuild. A stale answer for the same file stays served meanwhile.
  launch(entry);
  return completed ? { status: "ready", aggregate: completed.aggregate } : { status: "pending" };
}

/** Resolves once no preview build is scheduled or running; for tests and benchmarks. */
export async function settleTelemetryPreviewBuildForTests(): Promise<void> {
  while ([...entries.values()].some(entry => entry.running)) await new Promise(resolve => setTimeout(resolve, 5));
}

export function resetTelemetryPreviewAggregateForTests(): void {
  entries.clear();
}
