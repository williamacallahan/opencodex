/**
 * Opt-in size limit for the canonical usage ledger (#5063), suspended.
 *
 * A trim used to copy the oldest rows into `usage-archive/`, prune that directory by mtime and delete
 * "leftover" segments it inferred from names and inodes, then rename a shorter ledger into place.
 * Those deletions could remove the only copy of rows the operator ordered kept for 30 days, and could
 * delete files the hub never wrote. Until the archive catalog publishes the archived prefix and the
 * new live generation in one durable decision (structure/usage-archive.md, "Suspended trim"), a ledger
 * over its limit is left whole and nothing in the archive directory is written or deleted. The
 * ledger therefore grows past `usageLedgerMaxBytes`, and `usageLedgerRetentionStatus` says so.
 */
import { currentUsageLogRevision } from "./log";
import { MIN_USAGE_LEDGER_MAX_BYTES } from "./retention-contract";

export type UsageLedgerRetentionResult =
  | { kind: "disabled" }
  | { kind: "unchanged"; currentBytes: number }
  | { kind: "deferred"; currentBytes: number; reason: "archive-suspended" };

/** Whether a configured limit is one the ledger would be held to: unset or below the floor is no limit. */
export function usageLedgerLimitApplies(maxBytes: number | undefined): maxBytes is number {
  return maxBytes !== undefined && Number.isSafeInteger(maxBytes) && maxBytes >= MIN_USAGE_LEDGER_MAX_BYTES;
}

/**
 * Report whether the ledger exceeds `maxBytes`. Over the limit the trim defers before it opens the
 * ledger or touches the archive directory, so no segment is written and no archive file is deleted.
 */
export function enforceUsageLedgerSizeLimit(maxBytes: number | undefined): UsageLedgerRetentionResult {
  if (!usageLedgerLimitApplies(maxBytes)) return { kind: "disabled" };
  const captured = currentUsageLogRevision();
  if (!captured) return { kind: "disabled" };
  if (captured.size <= maxBytes) return { kind: "unchanged", currentBytes: captured.size };
  return { kind: "deferred", currentBytes: captured.size, reason: "archive-suspended" };
}
