import { usageLogIdentityKey, usageLogRevisionKey, type UsageLogRevision } from "./log";

/**
 * The last ledger revision a cached usage answer was checked against.
 *
 * `usage.jsonl` is append-only, so a cached answer stays valid while the file only grows: it is then
 * dated, not wrong. A different file, a shrink, or a change that does not grow it (a same-length
 * rewrite) means rows the answer counted may be gone or different, so it must not be served.
 *
 * Two observations guard that. Each answer keeps the revision last observed with it. And every
 * observation, by any cache, is recorded against the largest revision this process has seen for the
 * file: a revision below that mark, or equal in length but different, is destructive and advances
 * the file's destructive `epoch`. An answer whose epoch is older is dropped wherever it is next read,
 * even by a cache that never saw the larger revision itself, and a build that started under an older
 * epoch never publishes.
 */
export interface ObservedUsageRevision {
  identityKey: string;
  size: number;
  revisionKey: string;
  epoch: number;
}

const highWater = new Map<string, { size: number; revisionKey: string; epoch: number }>();
/**
 * Told of every destructive observation, so a durable consumer can record it for other processes.
 * The filter index registers here (`src/usage/filter-index.ts`) instead of being imported.
 */
let destructiveListener: ((revision: UsageLogRevision | null) => void) | null = null;

export function setDestructiveUsageRevisionListener(listener: ((revision: UsageLogRevision | null) => void) | null): void {
  destructiveListener = listener;
}
/** Distinct ledger files remembered; each mark is a few strings. */
const MAX_TRACKED_FILES = 64;

/** The destructive epoch of `revision`'s file, without recording anything. */
export function usageRevisionEpoch(revision: UsageLogRevision | null): number {
  return highWater.get(usageLogIdentityKey(revision))?.epoch ?? 0;
}

/**
 * Record an observation of the live file against its high-water mark and return its destructive
 * epoch. Only a revision read from the file now may be noted: a build's opening revision is older
 * than what has been observed since, and would look like a shrink.
 */
export function noteUsageRevision(revision: UsageLogRevision | null): number {
  const identityKey = usageLogIdentityKey(revision);
  const size = revision?.size ?? 0;
  const revisionKey = usageLogRevisionKey(revision);
  const mark = highWater.get(identityKey);
  if (!mark) {
    highWater.set(identityKey, { size, revisionKey, epoch: 0 });
    while (highWater.size > MAX_TRACKED_FILES) highWater.delete(highWater.keys().next().value!);
    return 0;
  }
  if (size < mark.size || (size === mark.size && revisionKey !== mark.revisionKey)) {
    mark.epoch += 1;
    mark.size = size;
    mark.revisionKey = revisionKey;
    destructiveListener?.(revision);
  } else if (size > mark.size) {
    mark.size = size;
    mark.revisionKey = revisionKey;
  }
  return mark.epoch;
}

/** Whether `revision` is destructive against its file's mark, recording nothing; for read-only paths. */
export function usageRevisionIsDestructive(revision: UsageLogRevision | null): boolean {
  const mark = highWater.get(usageLogIdentityKey(revision));
  const size = revision?.size ?? 0;
  return mark !== undefined && (size < mark.size || (size === mark.size && usageLogRevisionKey(revision) !== mark.revisionKey));
}

/** An answer's observation; `epoch` is the one its build started under. */
export function observedUsageRevision(revision: UsageLogRevision | null, epoch: number = usageRevisionEpoch(revision)): ObservedUsageRevision {
  return { identityKey: usageLogIdentityKey(revision), size: revision?.size ?? 0, revisionKey: usageLogRevisionKey(revision), epoch };
}

/**
 * Compares the live revision `current` with `last` and records it in `last` when it only grew.
 * `rewritten` means the cached answer must be dropped.
 */
export function observeUsageRevision(last: ObservedUsageRevision, current: UsageLogRevision | null): "same" | "grown" | "rewritten" {
  const epoch = noteUsageRevision(current);
  const next = observedUsageRevision(current, epoch);
  if (next.identityKey !== last.identityKey || epoch !== last.epoch || next.size < last.size) return "rewritten";
  if (next.size === last.size) return next.revisionKey === last.revisionKey ? "same" : "rewritten";
  last.size = next.size;
  last.revisionKey = next.revisionKey;
  return "grown";
}

/** Advance `last` to a larger revision of the same file without recording an observation. */
export function advanceObservedUsageRevision(last: ObservedUsageRevision, revision: UsageLogRevision | null): void {
  const next = observedUsageRevision(revision, last.epoch);
  if (next.identityKey === last.identityKey && next.size > last.size) {
    last.size = next.size;
    last.revisionKey = next.revisionKey;
  }
}

export function resetUsageRevisionObservationsForTests(): void {
  highWater.clear();
}
