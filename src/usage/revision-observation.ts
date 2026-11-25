import { usageLogIdentityKey, usageLogRevisionKey, type UsageLogRevision } from "./log";

/**
 * The last ledger revision a cached usage answer was checked against.
 *
 * `usage.jsonl` is append-only, so a cached answer stays valid while the file only grows: it is then
 * dated, not wrong. A different file, a shrink, or a change that does not grow it (a same-length
 * rewrite) means rows the answer counted may be gone or different, so it must not be served. The
 * comparison is against the last OBSERVED revision, not the one the answer was built from: after
 * observing growth to 510 bytes, a rewrite down to 340 bytes is a shrink even though 340 is still
 * larger than the 170 bytes the answer read.
 */
export interface ObservedUsageRevision {
  identityKey: string;
  size: number;
  revisionKey: string;
}

export function observedUsageRevision(revision: UsageLogRevision | null): ObservedUsageRevision {
  return { identityKey: usageLogIdentityKey(revision), size: revision?.size ?? 0, revisionKey: usageLogRevisionKey(revision) };
}

/**
 * Compares `current` with `last` and records it in `last` when it only grew. `rewritten` means the
 * cached answer must be dropped.
 */
export function observeUsageRevision(last: ObservedUsageRevision, current: UsageLogRevision | null): "same" | "grown" | "rewritten" {
  const next = observedUsageRevision(current);
  if (next.identityKey !== last.identityKey || next.size < last.size) return "rewritten";
  if (next.size === last.size) return next.revisionKey === last.revisionKey ? "same" : "rewritten";
  last.size = next.size;
  last.revisionKey = next.revisionKey;
  return "grown";
}
