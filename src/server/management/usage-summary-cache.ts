import { enforceAppOwnedMemoryBudgetIfNeeded, type RetainedStoreSnapshot } from "../../lib/app-owned-memory";
import type { ObservedUsageRevision } from "../../usage/revision-observation";
import type { UsageSummary } from "../../usage/summary";

export type CachedUsageSummary = UsageSummary & {
  usageIncomplete?: true;
  usageIncompleteReason?: "oversized_rows";
  historyTruncated: boolean;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
  snapshotWindowStart: number | null;
  snapshotWindowEnd: number | null;
};

export interface UsageSummaryCacheEntry {
  revisionKey: string;
  /** path/dev/ino/birthtime only; appends keep this stable. */
  identityKey: string;
  maxReadBytes: number;
  /** userCostOverlayVersion() when the summary was computed; overlay edits invalidate the entry. */
  overlayVersion: number;
  /** Local calendar zone used to build day/range buckets. */
  timeZone: string;
  expiresAt: number;
  /** Generation freshness: ignore size/mtime until this instant. */
  freshUntil: number;
  /** The ledger revision last observed with this summary; a shrink or non-growing change drops it. */
  observed: ObservedUsageRevision;
  summary: CachedUsageSummary;
  revisionReadAt: number;
  sizeBytes: number;
}

const usageSummaryCache = new Map<string, UsageSummaryCacheEntry>();
let usageSummaryCacheBytes = 0;
let oldestUsageSummaryKey: string | undefined;
let oldestUsageSummaryAt: number | null = null;

function recomputeOldestUsageSummary(): void {
  oldestUsageSummaryKey = undefined;
  oldestUsageSummaryAt = null;
  for (const [key, entry] of usageSummaryCache) {
    const readAt = entry.revisionReadAt;
    if (oldestUsageSummaryAt !== null && readAt >= oldestUsageSummaryAt) continue;
    oldestUsageSummaryKey = key;
    oldestUsageSummaryAt = readAt;
  }
}

function deleteUsageSummaryCacheEntry(key: string): number {
  const entry = usageSummaryCache.get(key);
  if (!entry) return 0;
  usageSummaryCache.delete(key);
  usageSummaryCacheBytes = Math.max(0, usageSummaryCacheBytes - entry.sizeBytes);
  if (oldestUsageSummaryKey === key) recomputeOldestUsageSummary();
  return entry.sizeBytes;
}

export function getUsageSummaryCacheEntry(key: string): UsageSummaryCacheEntry | undefined {
  return usageSummaryCache.get(key);
}

export function discardUsageSummaryCacheEntry(key: string): number {
  return deleteUsageSummaryCacheEntry(key);
}

export function setUsageSummaryCacheEntry(
  key: string,
  entry: Omit<UsageSummaryCacheEntry, "sizeBytes">,
): void {
  deleteUsageSummaryCacheEntry(key);
  const sizeBytes = Buffer.byteLength(JSON.stringify({ key, ...entry }), "utf8");
  usageSummaryCache.set(key, { ...entry, sizeBytes });
  usageSummaryCacheBytes += sizeBytes;
  if (oldestUsageSummaryAt === null || entry.revisionReadAt < oldestUsageSummaryAt) {
    oldestUsageSummaryKey = key;
    oldestUsageSummaryAt = entry.revisionReadAt;
  }
  enforceAppOwnedMemoryBudgetIfNeeded();
}

/**
 * The summary a background rebuild published for the request that started it, kept for that
 * request's retry even when the memory budget evicts the cache above: without it a full budget turns
 * every completed rebuild into another 503 and another scan of the same revision. Bounded by count
 * and by one retry interval, so it never grows with usage history.
 */
const HELD_SUMMARY_MS = 15_000;
const MAX_HELD_SUMMARIES = 8;
const heldSummaries = new Map<string, { entry: Omit<UsageSummaryCacheEntry, "sizeBytes">; until: number }>();

export function holdUsageSummaryForRetry(key: string, entry: Omit<UsageSummaryCacheEntry, "sizeBytes">): void {
  heldSummaries.delete(key);
  heldSummaries.set(key, { entry, until: Date.now() + HELD_SUMMARY_MS });
  while (heldSummaries.size > MAX_HELD_SUMMARIES) heldSummaries.delete(heldSummaries.keys().next().value!);
}

export function heldUsageSummary(key: string): Omit<UsageSummaryCacheEntry, "sizeBytes"> | undefined {
  const held = heldSummaries.get(key);
  if (held && Date.now() < held.until) return held.entry;
  heldSummaries.delete(key);
  return undefined;
}

export function usageSummaryRetainedStoreSnapshot(): RetainedStoreSnapshot {
  return {
    count: usageSummaryCache.size,
    bytes: usageSummaryCacheBytes,
    evictableBytes: usageSummaryCacheBytes,
    pinnedBytes: 0,
    oldestAt: oldestUsageSummaryAt,
  };
}

export function evictOldestUsageSummaryForBudget(): number {
  return oldestUsageSummaryKey === undefined ? 0 : deleteUsageSummaryCacheEntry(oldestUsageSummaryKey);
}

export function resetUsageSummaryCacheForTests(): void {
  usageSummaryCache.clear();
  heldSummaries.clear();
  usageSummaryCacheBytes = 0;
  oldestUsageSummaryKey = undefined;
  oldestUsageSummaryAt = null;
}
