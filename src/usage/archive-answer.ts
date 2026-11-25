/**
 * Usage totals for a window of the archive, summed one segment at a time from the hourly totals files.
 *
 * A request never holds more than one segment's buckets beyond the totals cache's own bound: each
 * segment's totals are loaded, folded into the running sums, and dropped before the next is loaded,
 * keeping only its span and hour index. The sums follow the live summary: a provider, model or account
 * figure is the sum of that attribution's attempts, and a total over rows (the summary, `byHour`, and
 * the row's own dimensions) is the rows' own usage, except under a provider, model or account filter,
 * where, like the live projection to matching attempts, it is the matching attempts' usage. Requests
 * are counted once per row in every total, using the overlap records for rows that touch several
 * buckets. The final selection of each breakdown's top keys yields as it goes.
 */
import { ATTRIBUTION_DIMENSIONS } from "./archive-row-attribution";
import {
  archiveSpan, entryMayOverlap, loadTotals, segmentOverlaps, segmentState, yieldToEventLoop,
  type ArchiveListing, type ArchiveSegmentEntry, type ArchiveSegmentState,
} from "./archive-query";
import {
  ARCHIVE_DIMENSIONS, perArchiveDimension, type ArchiveDimension, type ArchiveHourBucket, type ArchiveTotalsFile,
} from "./archive-totals";

export const ARCHIVE_BREAKDOWN_ROWS = 200;
/** Buckets summed, or breakdown keys ranked, between two yields to the event loop. */
const SLICE = 2_000;

export const ARCHIVE_SUMS = [
  "requests", "attemptCount", "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens",
  "totalTokens", "estimatedCostUsd", "pricedRequests", "unpricedRequests", "unmeteredRequests",
] as const;
export type ArchiveSums = { [sum in typeof ARCHIVE_SUMS[number]]: number };

export function blankArchiveSums(): ArchiveSums {
  return {
    requests: 0, attemptCount: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    totalTokens: 0, estimatedCostUsd: 0, pricedRequests: 0, unpricedRequests: 0, unmeteredRequests: 0,
  };
}

/** A bucket as an attribution's figures: its attempts' tokens and cost. */
function attemptView(bucket: ArchiveHourBucket): ArchiveSums {
  return {
    requests: bucket.requests, attemptCount: bucket.attemptCount, inputTokens: bucket.inputTokens, outputTokens: bucket.outputTokens,
    cacheReadInputTokens: bucket.cacheReadInputTokens, cacheCreationInputTokens: bucket.cacheCreationInputTokens,
    totalTokens: bucket.totalTokens, estimatedCostUsd: bucket.estimatedCostUsd, pricedRequests: bucket.pricedRequests,
    unpricedRequests: bucket.unpricedRequests, unmeteredRequests: bucket.unmeteredRequests,
  };
}

/** A bucket as rows' figures: the usage and cost of the rows whose final attempt it holds. */
function rowView(bucket: ArchiveHourBucket): ArchiveSums {
  return {
    requests: bucket.requests, attemptCount: bucket.attemptCount, inputTokens: bucket.rowInputTokens, outputTokens: bucket.rowOutputTokens,
    cacheReadInputTokens: bucket.rowCacheReadInputTokens, cacheCreationInputTokens: bucket.rowCacheCreationInputTokens,
    totalTokens: bucket.rowTotalTokens, estimatedCostUsd: bucket.rowEstimatedCostUsd, pricedRequests: bucket.pricedRequests,
    unpricedRequests: bucket.unpricedRequests, unmeteredRequests: bucket.unmeteredRequests,
  };
}

function addSums(into: ArchiveSums, from: ArchiveSums): void {
  for (const sum of ARCHIVE_SUMS) into[sum] += from[sum];
}

function tally<K>(map: Map<K, ArchiveSums>, key: K, sums: ArchiveSums): void {
  let current = map.get(key);
  if (!current) {
    current = blankArchiveSums();
    map.set(key, current);
  }
  addSums(current, sums);
}

function uncount<K>(map: Map<K, ArchiveSums>, key: K, requests: number): void {
  const current = map.get(key);
  if (current) current.requests -= requests;
}

export type ArchiveFilter = Partial<Record<ArchiveDimension, string>>;

export interface ArchiveBreakdown {
  rows: Array<{ key: string } & ArchiveSums>;
  /** Keys left out after the first {@link ARCHIVE_BREAKDOWN_ROWS}. */
  truncated: number;
}

export interface ArchiveTotalsAnswer {
  summary: ArchiveSums;
  /** Every counted segment that may overlap the window, with its span, hour index and build failure. */
  windowSegments: ArchiveSegmentState[];
  segmentsInRange: number;
  pendingSegments: ArchiveSegmentState[];
  failedSegments: ArchiveSegmentState[];
  unparsableRows: number;
  /** Over the segments in the window: attributions counted as `(other)` per dimension, and folded ones. */
  overflowRows: { [dimension in ArchiveDimension]: number };
  foldedRows: number;
  overlapRowsDropped: number;
  earliestRowAt: number | null;
  latestRowAt: number | null;
  /** Some segment's span came from its name and mtime because its totals have not been read yet. */
  spanApproximate: boolean;
  /** Every hour of the window that has rows, oldest first; the window itself bounds its length. */
  byHour: Array<{ key: string } & ArchiveSums>;
  byDimension: { [dimension in ArchiveDimension]: ArchiveBreakdown };
}

const ranksBefore = (left: { key: string } & ArchiveSums, right: { key: string } & ArchiveSums): number =>
  right.requests - left.requests || right.totalTokens - left.totalTokens || left.key.localeCompare(right.key);

/** The top keys of a breakdown, selected a slice at a time so a large one never blocks the loop. */
async function topRows(map: Map<string, ArchiveSums>): Promise<ArchiveBreakdown> {
  const top: Array<{ key: string } & ArchiveSums> = [];
  let seen = 0;
  for (const [key, sums] of map) {
    const row = { key, ...sums };
    if (top.length < ARCHIVE_BREAKDOWN_ROWS || ranksBefore(row, top[top.length - 1]!) < 0) {
      let at = top.length;
      while (at > 0 && ranksBefore(row, top[at - 1]!) < 0) at -= 1;
      top.splice(at, 0, row);
      if (top.length > ARCHIVE_BREAKDOWN_ROWS) top.pop();
    }
    if (++seen % SLICE === 0) await yieldToEventLoop();
  }
  return { rows: top, truncated: Math.max(0, map.size - ARCHIVE_BREAKDOWN_ROWS) };
}

export interface ArchiveAnswerOptions {
  /** Test seam for where totals come from; production reads them through the bounded cache. */
  load?: (entry: ArchiveSegmentEntry) => Promise<ArchiveTotalsFile | undefined>;
}

/** Sum the buckets of every window segment whose hour lies in `[since, until)` and matches the filter. */
export async function answerArchiveTotals(
  listing: ArchiveListing,
  since: number,
  until: number,
  filter: ArchiveFilter,
  options: ArchiveAnswerOptions = {},
): Promise<ArchiveTotalsAnswer> {
  const load = options.load ?? loadTotals;
  const lower = (value: string): string => value.toLowerCase();
  const filters = ARCHIVE_DIMENSIONS.flatMap(dimension => filter[dimension] === undefined ? [] : [[dimension, filter[dimension]!] as const]);
  // The live summary compares provider and model case-insensitively; every other filter is exact.
  const matchesFilter = (bucket: ArchiveHourBucket): boolean => filters.every(([dimension, wanted]) =>
    dimension === "provider" || dimension === "model" ? lower(bucket[dimension]) === lower(wanted) : bucket[dimension] === wanted);
  const attributionFiltered = ATTRIBUTION_DIMENSIONS.some(dimension => filter[dimension] !== undefined);
  const totalView = attributionFiltered ? attemptView : rowView;
  const isAttribution = (dimension: ArchiveDimension): boolean => (ATTRIBUTION_DIMENSIONS as readonly string[]).includes(dimension);

  const summary = blankArchiveSums();
  const byHour = new Map<number, ArchiveSums>();
  const byDimension = perArchiveDimension(() => new Map<string, ArchiveSums>());
  const overflowRows = perArchiveDimension(() => 0);
  const answer = {
    windowSegments: [] as ArchiveSegmentState[], pendingSegments: [] as ArchiveSegmentState[], failedSegments: [] as ArchiveSegmentState[],
    segmentsInRange: 0, unparsableRows: 0, foldedRows: 0, overlapRowsDropped: 0,
  };

  /** Fold one segment and let go of its buckets: only the returned state outlives this call. */
  const foldSegment = async (entry: ArchiveSegmentEntry): Promise<ArchiveSegmentState> => {
    const totals = await load(entry);
    const state = segmentState(entry, totals);
    if (!segmentOverlaps(state, since, until)) return state;
    answer.segmentsInRange += 1;
    if (!totals) {
      (state.failure ? answer.failedSegments : answer.pendingSegments).push(state);
      return state;
    }
    answer.unparsableRows += totals.unparsableRows;
    answer.foldedRows += totals.foldedRows;
    answer.overlapRowsDropped += totals.overlapRowsDropped;
    for (const dimension of ARCHIVE_DIMENSIONS) overflowRows[dimension] += totals.overflowRows[dimension];
    const matched = new Uint8Array(totals.buckets.length);
    for (let index = 0; index < totals.buckets.length; index++) {
      if (index > 0 && index % SLICE === 0) await yieldToEventLoop();
      const bucket = totals.buckets[index]!;
      if (bucket.hour < since || bucket.hour >= until || !matchesFilter(bucket)) continue;
      matched[index] = 1;
      const total = totalView(bucket);
      const attempt = attemptView(bucket);
      addSums(summary, total);
      tally(byHour, bucket.hour, total);
      for (const dimension of ARCHIVE_DIMENSIONS) tally(byDimension[dimension], bucket[dimension], isAttribution(dimension) ? attempt : total);
    }
    // A row that touched several matching buckets was counted once in each; count it once per total.
    for (const overlap of totals.overlaps) {
      const members = overlap.buckets.filter(index => matched[index] === 1).map(index => totals.buckets[index]!);
      if (members.length < 2) continue;
      summary.requests -= overlap.count * (members.length - 1);
      uncount(byHour, members[0]!.hour, overlap.count * (members.length - 1));
      for (const dimension of ARCHIVE_DIMENSIONS) {
        const shared = new Map<string, number>();
        for (const member of members) shared.set(member[dimension], (shared.get(member[dimension]) ?? 0) + 1);
        for (const [value, times] of shared) if (times > 1) uncount(byDimension[dimension], value, overlap.count * (times - 1));
      }
    }
    return state;
  };

  for (const entry of listing.segments) {
    if (!entryMayOverlap(entry, since, until)) continue;
    answer.windowSegments.push(await foldSegment(entry));
    await yieldToEventLoop();
  }
  const span = archiveSpan(listing);
  const breakdowns = perArchiveDimension((): ArchiveBreakdown => ({ rows: [], truncated: 0 }));
  for (const dimension of ARCHIVE_DIMENSIONS) breakdowns[dimension] = await topRows(byDimension[dimension]);
  return {
    ...answer,
    summary,
    overflowRows,
    earliestRowAt: span.earliestRowAt,
    latestRowAt: span.latestRowAt,
    spanApproximate: span.approximate,
    byHour: [...byHour].sort(([left], [right]) => left - right).map(([hour, sums]) => ({ key: new Date(hour).toISOString(), ...sums })),
    byDimension: breakdowns,
  };
}
