/**
 * Individual archived rows for a short window, for forensic questions the hourly totals cannot
 * answer (which request, which session).
 *
 * Bounded three ways: the route caps the window and the row count, every segment is read through the
 * cooperative ledger scanner, and an overall deadline stops the read and returns what it has.
 * Segments are read oldest first under the same counting rule as the totals, so a row is returned once.
 */
import { segmentOverlaps, type ArchiveFilter, type ArchiveListing } from "./archive-query";
import { ARCHIVE_DIMENSIONS, archiveDimensionValues } from "./archive-totals";
import { scanUsageLedgerCooperatively, UsageLedgerRebuildRequiredError } from "./ledger-scanner";
import type { PersistedUsageEntry } from "./log";

export interface ArchivedRowsQuery {
  since: number;
  /** Exclusive. */
  until: number;
  filter: ArchiveFilter;
  /** Exact `workload`, which the totals do not key by. */
  workload?: string;
  limit: number;
}

export interface ArchivedRowsResult {
  rows: PersistedUsageEntry[];
  /** `limit`: more rows matched than were returned; `deadline`: the read stopped before every segment was read. */
  truncated: false | "limit" | "deadline";
  segmentsRead: number;
}

function matches(entry: PersistedUsageEntry, query: ArchivedRowsQuery): boolean {
  if (!Number.isFinite(entry.timestamp) || entry.timestamp < query.since || entry.timestamp >= query.until) return false;
  if (query.workload !== undefined && (entry.workload ?? "") !== query.workload) return false;
  const values = archiveDimensionValues(entry);
  return ARCHIVE_DIMENSIONS.every(dimension => query.filter[dimension] === undefined || values[dimension] === query.filter[dimension]);
}

/** Read matching rows until `limit` is exceeded, every overlapping segment is read, or `deadline` aborts. */
export async function readArchivedRows(
  listing: ArchiveListing,
  query: ArchivedRowsQuery,
  deadline: AbortSignal,
  options: { chunkBytes?: number } = {},
): Promise<ArchivedRowsResult> {
  const rows: PersistedUsageEntry[] = [];
  const full = new AbortController();
  const signal = AbortSignal.any([deadline, full.signal]);
  let segmentsRead = 0;
  let outOfTime = false;
  for (const state of listing.segments) {
    if (!segmentOverlaps(state, query.since, query.until)) continue;
    if (signal.aborted) {
      outOfTime = deadline.aborted;
      break;
    }
    segmentsRead += 1;
    try {
      await scanUsageLedgerCooperatively({
        path: state.path,
        signal,
        ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}),
        onEntry: entry => {
          if (rows.length > query.limit || !matches(entry, query)) return;
          rows.push(entry);
          if (rows.length > query.limit) full.abort();
        },
      });
    } catch (error) {
      if (signal.aborted) {
        outOfTime = deadline.aborted && !full.signal.aborted;
        break;
      }
      // Pruned or replaced while it was read: the rows already read are still archived rows.
      if (error instanceof UsageLedgerRebuildRequiredError) continue;
      throw error;
    }
  }
  if (rows.length > query.limit) return { rows: rows.slice(0, query.limit), truncated: "limit", segmentsRead };
  return { rows, truncated: outOfTime ? "deadline" : false, segmentsRead };
}
