/**
 * Individual archived rows for a short window, for forensic questions the hourly totals cannot
 * answer (which request, which session).
 *
 * Bounded four ways: the route caps the window and the row count; each segment is read from the
 * first-row offset its totals file records for the hour before `since`, not from its start; the read
 * stops an hour past `until`; and an overall deadline stops it with what it has. Rows are appended
 * in arrival order but a retry can log one slightly out of time order, which is what the hour of
 * slack on each side absorbs; every row is still filtered by its own timestamp. A segment without
 * current totals has no offsets, so it is reported pending rather than scanned from its start.
 * Segments are read oldest first under the totals' counting rule, so a row is returned once.
 */
import { segmentOverlaps, type ArchiveFilter, type ArchiveSegmentState } from "./archive-query";
import { ARCHIVE_DIMENSIONS, archiveDimensionValues, type ArchiveTotalsFile } from "./archive-totals";
import { scanUsageLedgerCooperatively, UsageLedgerRebuildRequiredError } from "./ledger-scanner";
import type { PersistedUsageEntry } from "./log";

const HOUR_MS = 60 * 60 * 1000;
/** How far out of time order an appended row may be and still be found. */
const OUT_OF_ORDER_SLACK_MS = HOUR_MS;

export interface ArchivedRowsQuery {
  since: number;
  /** Exclusive. */
  until: number;
  filter: ArchiveFilter;
  /** Exact `workload`, which the totals do not key by. */
  workload?: string;
  limit: number;
}

/**
 * Why a read stopped. `window-end`: it passed `until` plus the slack; `segment-end`: the segment
 * ended first; `limit`: more rows matched than the limit; `deadline`: it ran out of time.
 */
export type ArchiveReadEnd = "window-end" | "segment-end" | "limit" | "deadline";

export interface ArchiveSegmentRead {
  segment: string;
  fromByte: number;
  endedBy: ArchiveReadEnd;
}

export interface ArchivedRowsResult {
  rows: PersistedUsageEntry[];
  /** `limit` and `deadline` mean rows may be missing; `window-end` means every segment was read through the window. */
  endedBy: Exclude<ArchiveReadEnd, "segment-end">;
  segments: ArchiveSegmentRead[];
  /** Segments in the window whose totals, and so their offsets, are not built yet. */
  pending: ArchiveSegmentState[];
}

function matches(entry: PersistedUsageEntry, query: ArchivedRowsQuery): boolean {
  if (!Number.isFinite(entry.timestamp) || entry.timestamp < query.since || entry.timestamp >= query.until) return false;
  if (query.workload !== undefined && (entry.workload ?? "") !== query.workload) return false;
  const values = archiveDimensionValues(entry);
  return ARCHIVE_DIMENSIONS.every(dimension => query.filter[dimension] === undefined || values[dimension] === query.filter[dimension]);
}

/**
 * Where to start reading: the earliest offset of any hour at or after the hour before `since`'s hour.
 * Taking the minimum over those hours, not the offset of one, also catches a later-stamped row
 * appended before that hour's first row. Undefined when the segment has no row that late.
 */
export function archiveSeekOffset(totals: ArchiveTotalsFile, since: number): number | undefined {
  const fromHour = Math.floor(since / HOUR_MS) * HOUR_MS - OUT_OF_ORDER_SLACK_MS;
  let offset: number | undefined;
  for (const entry of totals.hourOffsets) {
    if (entry.hour >= fromHour) offset = Math.min(offset ?? entry.offset, entry.offset);
  }
  return offset;
}

let rowsReadTail: Promise<void> = Promise.resolve();

/**
 * Run row reads one at a time. A caller that waits longer than `waitMs` for its turn gets `busy`
 * without reading; its place in the line is released as soon as the read ahead of it ends.
 */
export async function inArchiveRowsReadQueue<T>(waitMs: number, read: () => Promise<T>): Promise<{ kind: "read"; value: T } | { kind: "busy" }> {
  const ahead = rowsReadTail;
  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });
  rowsReadTail = ahead.then(() => mine);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const turn = await Promise.race([
    ahead.then(() => true),
    new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), waitMs); }),
  ]);
  clearTimeout(timer);
  if (!turn) {
    void ahead.then(release);
    return { kind: "busy" };
  }
  try {
    return { kind: "read", value: await read() };
  } finally {
    release();
  }
}

/** Read matching rows until `limit` is exceeded, every overlapping segment is read through the window, or `deadline` aborts. */
export async function readArchivedRows(
  states: readonly ArchiveSegmentState[],
  query: ArchivedRowsQuery,
  deadline: AbortSignal,
  options: { chunkBytes?: number } = {},
): Promise<ArchivedRowsResult> {
  const rows: PersistedUsageEntry[] = [];
  const segments: ArchiveSegmentRead[] = [];
  const pending: ArchiveSegmentState[] = [];
  const full = new AbortController();
  const stopAt = query.until + OUT_OF_ORDER_SLACK_MS;
  let outOfTime = false;
  for (const state of states) {
    if (!segmentOverlaps(state, query.since, query.until)) continue;
    if (!state.totals) {
      pending.push(state);
      continue;
    }
    if (full.signal.aborted) continue;
    if (deadline.aborted) {
      outOfTime = true;
      continue;
    }
    const fromByte = archiveSeekOffset(state.totals, query.since);
    if (fromByte === undefined) continue;
    const pastWindow = new AbortController();
    const read: ArchiveSegmentRead = { segment: state.name, fromByte, endedBy: "segment-end" };
    segments.push(read);
    let stopped = false;
    try {
      await scanUsageLedgerCooperatively({
        path: state.path,
        startAtBytes: fromByte,
        signal: AbortSignal.any([deadline, full.signal, pastWindow.signal]),
        ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}),
        onEntry: entry => {
          if (full.signal.aborted || pastWindow.signal.aborted) return;
          if (entry.timestamp >= stopAt) {
            pastWindow.abort();
            return;
          }
          if (!matches(entry, query)) return;
          rows.push(entry);
          if (rows.length > query.limit) full.abort();
        },
      });
    } catch (error) {
      stopped = true;
      // Pruned or replaced while it was read: the rows already read are still archived rows.
      if (!(error instanceof UsageLedgerRebuildRequiredError) && !deadline.aborted && !full.signal.aborted && !pastWindow.signal.aborted) throw error;
    }
    // The limit and the window end are decided in onEntry; only a thrown scan can mean the deadline.
    read.endedBy = full.signal.aborted ? "limit" : pastWindow.signal.aborted ? "window-end" : stopped && deadline.aborted ? "deadline" : "segment-end";
    outOfTime ||= read.endedBy === "deadline";
  }
  if (full.signal.aborted) return { rows: rows.slice(0, query.limit), endedBy: "limit", segments, pending };
  return { rows, endedBy: outOfTime ? "deadline" : "window-end", segments, pending };
}
