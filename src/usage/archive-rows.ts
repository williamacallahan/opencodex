/**
 * Individual archived rows for a short window, for forensic questions the hourly totals cannot
 * answer (which request, which session).
 *
 * Bounded four ways: the route caps the window and the row count; each segment is read from the
 * first-row offset its totals file records for the hour before `since`, not from its start; the read
 * stops once it is past the index's first-row offset of the first hour an hour or more after `until`;
 * and an overall deadline, combined with the request's own signal, stops it with what it has. Rows
 * are appended in arrival order but a retry can log one slightly out of time order, which is what the
 * hour of slack on each side absorbs; every row is still filtered by its own timestamp. A segment
 * without current totals has no offsets, so it is reported pending rather than scanned from its start.
 * Segments are read oldest first under the totals' counting rule, so a row is returned once.
 */
import { segmentOverlaps, type ArchiveSegmentBuilt, type ArchiveSegmentState } from "./archive-query";
import type { ArchiveFilter } from "./archive-answer";
import { ATTRIBUTION_DIMENSIONS, ROW_DIMENSIONS, rowAttributionKeys, rowDimensionValues } from "./archive-row-attribution";
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
 * Why a read stopped. `window-end`: it passed the window's end in the hour index; `segment-end`: the
 * segment ended first; `limit`: more rows matched than the limit; `deadline`: it ran out of time or the
 * request was abandoned.
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

/**
 * Whether a row is in the window and matches the filter: its own dimensions exactly, and, like the
 * live projection to matching attempts, at least one attribution matching every provider, model and
 * account filter (provider and model case-insensitively).
 */
function matches(entry: PersistedUsageEntry, query: ArchivedRowsQuery): boolean {
  if (!Number.isFinite(entry.timestamp) || entry.timestamp < query.since || entry.timestamp >= query.until) return false;
  if (query.workload !== undefined && (entry.workload ?? "") !== query.workload) return false;
  const row = rowDimensionValues(entry);
  if (!ROW_DIMENSIONS.every(dimension => query.filter[dimension] === undefined || row[dimension] === query.filter[dimension])) return false;
  if (!ATTRIBUTION_DIMENSIONS.some(dimension => query.filter[dimension] !== undefined)) return true;
  const same = (dimension: typeof ATTRIBUTION_DIMENSIONS[number], value: string): boolean => {
    const wanted = query.filter[dimension];
    if (wanted === undefined) return true;
    return dimension === "account" ? value === wanted : value.toLowerCase() === wanted.toLowerCase();
  };
  return rowAttributionKeys(entry).some(keys => ATTRIBUTION_DIMENSIONS.every(dimension => same(dimension, keys[dimension])));
}

/**
 * Where to start reading: the earliest offset of any hour at or after the hour before `since`'s hour.
 * Taking the minimum over those hours, not the offset of one, also catches a later-stamped row
 * appended before that hour's first row. Undefined when the segment has no row that late.
 */
export function archiveSeekOffset(built: ArchiveSegmentBuilt, since: number): number | undefined {
  const fromHour = Math.floor(since / HOUR_MS) * HOUR_MS - OUT_OF_ORDER_SLACK_MS;
  let offset: number | undefined;
  for (const entry of built.hourOffsets) {
    if (entry.hour >= fromHour) offset = Math.min(offset ?? entry.offset, entry.offset);
  }
  return offset;
}

/**
 * Where reading may stop: the first-row offset of an hour starting an hour or more past `until` that
 * lies after the first rows of every hour the read covers. Taken from the index rather than from one
 * row, so a stray row stamped far ahead and appended early cannot end the read before the window's own
 * rows. Undefined when no such hour exists: the segment is then read to its end.
 */
export function archiveStopOffset(built: ArchiveSegmentBuilt, since: number, until: number): number | undefined {
  const fromHour = Math.floor(since / HOUR_MS) * HOUR_MS - OUT_OF_ORDER_SLACK_MS;
  const stopHour = until + OUT_OF_ORDER_SLACK_MS;
  let latestInside = -1;
  for (const entry of built.hourOffsets) {
    if (entry.hour >= fromHour && entry.hour < stopHour) latestInside = Math.max(latestInside, entry.offset);
  }
  let stop: number | undefined;
  for (const entry of built.hourOffsets) {
    if (entry.hour >= stopHour && entry.offset > latestInside) stop = Math.min(stop ?? entry.offset, entry.offset);
  }
  return stop;
}

let rowsReadTail: Promise<void> = Promise.resolve();

/**
 * Run row reads one at a time. A caller that waits longer than `waitMs` for its turn, or whose
 * `signal` aborts while it waits, gets `busy` without reading; its place in the line is released as
 * soon as the read ahead of it ends. A read that throws releases its turn like one that returns.
 */
export async function inArchiveRowsReadQueue<T>(
  waitMs: number,
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<{ kind: "read"; value: T } | { kind: "busy" }> {
  const ahead = rowsReadTail;
  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });
  rowsReadTail = ahead.then(() => mine);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const turn = await Promise.race([
    ahead.then(() => true),
    new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), waitMs);
      onAbort = () => resolve(false);
      if (signal?.aborted) resolve(false);
      else signal?.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
  clearTimeout(timer);
  if (onAbort) signal?.removeEventListener("abort", onAbort);
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
  let outOfTime = false;
  for (const state of states) {
    if (!segmentOverlaps(state, query.since, query.until)) continue;
    if (!state.built) {
      pending.push(state);
      continue;
    }
    if (full.signal.aborted) continue;
    if (deadline.aborted) {
      outOfTime = true;
      continue;
    }
    const fromByte = archiveSeekOffset(state.built, query.since);
    if (fromByte === undefined) continue;
    const stopByte = archiveStopOffset(state.built, query.since, query.until);
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
        onEntry: (entry, rowStartBytes) => {
          if (full.signal.aborted || pastWindow.signal.aborted) return;
          if (stopByte !== undefined && rowStartBytes >= stopByte) {
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
