/**
 * Hourly totals for one usage archive segment, so a question about any window in the last 31 days is
 * answered from a few thousand additive buckets instead of gigabytes of rows.
 *
 * The file beside `<segment>.jsonl` is `<segment>.hourly.json`. A segment never changes after its
 * trim publishes it, so its totals stay valid while the file's `version` is current and its `bytes`
 * equal the segment's length; anything else is rebuilt. A build reads the segment through the ledger
 * scanner (the same 1 MiB row ceiling, torn-row rule, and cooperative yields as every ledger read),
 * and keeps only the buckets in memory. While the archive's trim is suspended no totals file is
 * published: every queued build is refused (`ArchiveTotalsPublishingSuspendedError`), and existing
 * files are only read.
 *
 * Rows are attributed per attempt, as `src/usage/archive-row-attribution.ts` describes: a bucket is
 * keyed by hour, the row's own dimensions, and one attribution's provider, model and account. Its
 * `requests` counts each row once per bucket it touches; a row touching several buckets is recorded
 * once more in `overlaps`, so a reader can count it once in any total those buckets share.
 *
 * Every dimension is caller-influenced (a data-plane caller declares its own machine name and
 * workload), so the builder bounds the file: each dimension keeps the live summary's 1,000 distinct
 * keys per segment and folds the rest into `(other)`, a segment keeps at most
 * {@link MAX_BUCKETS_PER_SEGMENT} buckets, folding any further combination into one all-`(other)`
 * bucket for its hour, across at most {@link MAX_HOURS_PER_SEGMENT} hours, and at most
 * {@link MAX_OVERLAPS_PER_SEGMENT} overlap records.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { archiveTotalsName } from "./archive-segments";
import {
  ATTEMPT_SUMS, ATTRIBUTION_DIMENSIONS, ROW_DIMENSIONS, ROW_SUMS, archiveRowAttribution,
  type AttemptSums, type AttributionDimension, type RowDimension, type RowSums,
} from "./archive-row-attribution";
import { OVERFLOW_KEY, RETAINED_KEYS } from "./attribution-breakdown";
import { scanUsageLedgerCooperatively } from "./ledger-scanner";

/** Bump when a bucket's key or sums change meaning; every older file is then rebuilt. */
export const ARCHIVE_TOTALS_FORMAT_VERSION = 4;
const HOUR_MS = 60 * 60 * 1000;
/** About 600 bytes of JSON per bucket, so with the folded hour buckets a totals file stays near 3.5 MB. */
export const MAX_BUCKETS_PER_SEGMENT = 5_000;
/** Hours one segment may span: the 31-day retention window. Bounds `hourOffsets` and the folded buckets. */
export const MAX_HOURS_PER_SEGMENT = 31 * 24;
/** Distinct multi-bucket row shapes kept per segment; beyond it a shared total may count such a row twice. */
export const MAX_OVERLAPS_PER_SEGMENT = 5_000;
/** The largest instant a `Date` can hold; a row stamped outside `[0, this]` is treated as untimed. */
export const MAX_DATE_MS = 8_640_000_000_000_000;

/** The dimensions a bucket is keyed by. A row that lacks one stores `""`, never drops it. */
export const ARCHIVE_DIMENSIONS = [...ATTRIBUTION_DIMENSIONS, ...ROW_DIMENSIONS] as const;
export type ArchiveDimension = AttributionDimension | RowDimension;

/** One value per dimension, built in one place so the set is listed once. */
export function perArchiveDimension<T>(make: (dimension: ArchiveDimension) => T): { [dimension in ArchiveDimension]: T } {
  return {
    provider: make("provider"), model: make("model"), account: make("account"), harness: make("harness"),
    workloadLauncher: make("workloadLauncher"), workloadSource: make("workloadSource"), clientHost: make("clientHost"),
    clientAddress: make("clientAddress"),
  };
}

export const ARCHIVE_BUCKET_SUMS = ["requests", ...ATTEMPT_SUMS, ...ROW_SUMS] as const;
export type ArchiveBucketSums = { requests: number } & AttemptSums & RowSums;
export type ArchiveHourBucket = { hour: number } & { [dimension in ArchiveDimension]: string } & ArchiveBucketSums;

export interface ArchiveOverlap {
  /** Indices into `buckets` of every bucket one row touched, ascending. */
  buckets: number[];
  /** Rows with exactly that set of buckets. */
  count: number;
}

export interface ArchiveTotalsFile {
  version: typeof ARCHIVE_TOTALS_FORMAT_VERSION;
  segment: string;
  /** The segment's byte length when the totals were built. */
  bytes: number;
  /** Rows counted into the buckets. */
  rows: number;
  /**
   * Rows that did not parse, failed the row schema, exceeded the row ceiling, had no integer timestamp
   * in `[0, 8.64e15]`, would open an hour past {@link MAX_HOURS_PER_SEGMENT}, or carried a non-finite
   * or negative token or cost or a non-string dimension.
   */
  unparsableRows: number;
  firstRowAt: number | null;
  lastRowAt: number | null;
  buckets: ArchiveHourBucket[];
  overlaps: ArchiveOverlap[];
  /** Multi-bucket rows not recorded in `overlaps` because the segment held its overlap cap. */
  overlapRowsDropped: number;
  /**
   * For each UTC hour with rows, the byte offset of the first row (in file order) stamped in that
   * hour, in file order. A row read seeks here instead of scanning the segment from its start.
   */
  hourOffsets: ArchiveHourOffset[];
  /** Per dimension, the attributions whose value arrived after 1,000 distinct ones and were counted as `(other)`. */
  overflowRows: { [dimension in ArchiveDimension]: number };
  /** Attributions counted in their hour's all-`(other)` bucket because the segment already held its bucket cap. */
  foldedRows: number;
}

export interface ArchiveHourOffset {
  hour: number;
  offset: number;
}

export function blankBucketSums(): ArchiveBucketSums {
  return {
    requests: 0, attemptCount: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    totalTokens: 0, estimatedCostUsd: 0, rowInputTokens: 0, rowOutputTokens: 0, rowCacheReadInputTokens: 0,
    rowCacheCreationInputTokens: 0, rowTotalTokens: 0, rowEstimatedCostUsd: 0, pricedRequests: 0, unpricedRequests: 0,
    unmeteredRequests: 0,
  };
}

/** Whether a row's timestamp can name an hour: an integer instant a `Date` can hold. */
export function isArchiveTimestamp(timestamp: unknown): timestamp is number {
  return typeof timestamp === "number" && Number.isInteger(timestamp) && timestamp >= 0 && timestamp <= MAX_DATE_MS;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export interface ArchiveTotalsBuildOptions {
  /** Test seam for the scanner's read size; production always uses its 1 MiB default. */
  chunkBytes?: number;
}

/** Read the whole segment once and publish its totals file. A segment that vanished publishes nothing. */
export async function buildArchiveTotals(segmentPath: string, options: ArchiveTotalsBuildOptions = {}): Promise<ArchiveTotalsFile | null> {
  const buckets: ArchiveHourBucket[] = [];
  const bucketIndex = new Map<string, number>();
  const overlaps = new Map<string, ArchiveOverlap>();
  const hourOffsets = new Map<number, number>();
  const seen = perArchiveDimension(() => new Set<string>());
  const overflowRows = perArchiveDimension(() => 0);
  let foldedRows = 0;
  let overlapRowsDropped = 0;
  let rows = 0;
  let rejectedRows = 0;
  let firstRowAt: number | null = null;
  let lastRowAt: number | null = null;

  const capped = (dimension: ArchiveDimension, value: string): string => {
    if (seen[dimension].has(value)) return value;
    if (seen[dimension].size < RETAINED_KEYS) {
      seen[dimension].add(value);
      return value;
    }
    overflowRows[dimension] += 1;
    return OVERFLOW_KEY;
  };
  const bucketFor = (hour: number, keys: { [dimension in ArchiveDimension]: string }): number => {
    const key = JSON.stringify([hour, ...ARCHIVE_DIMENSIONS.map(dimension => keys[dimension])]);
    const existing = bucketIndex.get(key);
    if (existing !== undefined) return existing;
    if (buckets.length >= MAX_BUCKETS_PER_SEGMENT) {
      foldedRows += 1;
      const folded = perArchiveDimension(() => OVERFLOW_KEY);
      const foldedKey = JSON.stringify([hour, ...ARCHIVE_DIMENSIONS.map(dimension => folded[dimension])]);
      const foldedIndex = bucketIndex.get(foldedKey);
      if (foldedIndex !== undefined) return foldedIndex;
      bucketIndex.set(foldedKey, buckets.push({ hour, ...folded, ...blankBucketSums() }) - 1);
      return buckets.length - 1;
    }
    bucketIndex.set(key, buckets.push({ hour, ...keys, ...blankBucketSums() }) - 1);
    return buckets.length - 1;
  };

  const scan = await scanUsageLedgerCooperatively({
    path: segmentPath,
    ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}),
    onEntry: (entry, rowStartBytes) => {
      const attributed = isArchiveTimestamp(entry.timestamp) ? archiveRowAttribution(entry) : undefined;
      const hour = attributed ? Math.floor(entry.timestamp / HOUR_MS) * HOUR_MS : 0;
      // A segment cut from a ledger holding at most the retention window spans that many hours; a row
      // that would open one more (a hand-edited or wildly misstamped one) is not counted, so neither
      // the hour index nor the per-hour folded buckets can grow past the ceiling.
      if (!attributed || (!hourOffsets.has(hour) && hourOffsets.size >= MAX_HOURS_PER_SEGMENT)) {
        rejectedRows += 1;
        return;
      }
      rows += 1;
      firstRowAt = firstRowAt === null ? entry.timestamp : Math.min(firstRowAt, entry.timestamp);
      lastRowAt = lastRowAt === null ? entry.timestamp : Math.max(lastRowAt, entry.timestamp);
      if (!hourOffsets.has(hour)) hourOffsets.set(hour, rowStartBytes);
      const row = perArchiveDimension(() => "");
      for (const dimension of ROW_DIMENSIONS) row[dimension] = capped(dimension, attributed.row[dimension]);
      const touched = new Set<number>();
      let last = -1;
      for (const part of attributed.parts) {
        const keys = { ...row };
        for (const dimension of ATTRIBUTION_DIMENSIONS) keys[dimension] = capped(dimension, part.keys[dimension]);
        last = bucketFor(hour, keys);
        touched.add(last);
        const bucket = buckets[last]!;
        for (const sum of ATTEMPT_SUMS) bucket[sum] += part.sums[sum];
      }
      for (const index of touched) buckets[index]!.requests += 1;
      // The row as a whole is counted under the attempt that ended it.
      const final = buckets[last]!;
      for (const sum of ROW_SUMS) final[sum] += attributed.rowSums[sum];
      if (touched.size < 2) return;
      const members = [...touched].sort((left, right) => left - right);
      const signature = members.join(",");
      const overlap = overlaps.get(signature);
      if (overlap) overlap.count += 1;
      else if (overlaps.size < MAX_OVERLAPS_PER_SEGMENT) overlaps.set(signature, { buckets: members, count: 1 });
      else overlapRowsDropped += 1;
    },
  });
  if (!scan.revision) return null;
  const totals: ArchiveTotalsFile = {
    version: ARCHIVE_TOTALS_FORMAT_VERSION,
    segment: basename(segmentPath),
    bytes: scan.revision.size,
    rows,
    unparsableRows: scan.invalidRows + scan.oversizedRows + rejectedRows,
    firstRowAt,
    lastRowAt,
    buckets,
    overlaps: [...overlaps.values()],
    overlapRowsDropped,
    hourOffsets: [...hourOffsets].map(([hour, offset]) => ({ hour, offset })),
    overflowRows,
    foldedRows,
  };
  return totals;
}

export function archiveTotalsPath(segmentPath: string): string {
  return join(dirname(segmentPath), archiveTotalsName(basename(segmentPath)));
}

const isInstant = (value: unknown): value is number | null => value === null || isArchiveTimestamp(value);

function isBucket(value: unknown): value is ArchiveHourBucket {
  if (typeof value !== "object" || value === null) return false;
  const bucket = value as Record<string, unknown>;
  return isArchiveTimestamp(bucket.hour)
    && ARCHIVE_DIMENSIONS.every(dimension => typeof bucket[dimension] === "string")
    && ARCHIVE_BUCKET_SUMS.every(sum => isCount(bucket[sum]));
}

function isOverlap(bucketCount: number): (value: unknown) => value is ArchiveOverlap {
  return (value: unknown): value is ArchiveOverlap => {
    if (typeof value !== "object" || value === null) return false;
    const overlap = value as Record<string, unknown>;
    return isCount(overlap.count) && Array.isArray(overlap.buckets) && overlap.buckets.length >= 2
      && overlap.buckets.every(index => Number.isSafeInteger(index) && index >= 0 && index < bucketCount);
  };
}

function isHourOffset(value: unknown): value is ArchiveHourOffset {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return isArchiveTimestamp(entry.hour) && isCount(entry.offset) && Number.isSafeInteger(entry.offset);
}

function isOverflowCounts(value: unknown): value is ArchiveTotalsFile["overflowRows"] {
  if (typeof value !== "object" || value === null) return false;
  const counts = value as Record<string, unknown>;
  return ARCHIVE_DIMENSIONS.every(dimension => isCount(counts[dimension]));
}

/**
 * The totals file for a segment of `segmentBytes`, or undefined when it is missing, unreadable, from
 * another format version, or built from a different length: each of those means it must be rebuilt.
 * The read is asynchronous; parsing and validating are bounded by the per-segment caps.
 */
export async function readArchiveTotals(segmentPath: string, segmentBytes: number): Promise<ArchiveTotalsFile | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(archiveTotalsPath(segmentPath), "utf8"));
  } catch {
    // Missing or torn: the build that rewrites it is the handling.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const file = parsed as Record<string, unknown>;
  if (file.version !== ARCHIVE_TOTALS_FORMAT_VERSION || file.bytes !== segmentBytes
    || !isCount(file.rows) || !isCount(file.unparsableRows) || !isInstant(file.firstRowAt) || !isInstant(file.lastRowAt)
    || !Array.isArray(file.buckets) || !file.buckets.every(isBucket)
    || !Array.isArray(file.overlaps) || !file.overlaps.every(isOverlap(file.buckets.length)) || !isCount(file.overlapRowsDropped)
    || !Array.isArray(file.hourOffsets) || !file.hourOffsets.every(isHourOffset)
    || !isOverflowCounts(file.overflowRows) || !isCount(file.foldedRows)) return undefined;
  return parsed as ArchiveTotalsFile;
}

/** Why a build failed: the segment changed while read, a filesystem error, or anything else. */
export type ArchiveBuildFailure =
  | { reason: "segment-changed" } | { reason: "io-error"; code: string } | { reason: "build-error" } | { reason: "publishing-suspended" };

/**
 * Totals files are not published while the archive's trim is suspended: a build wrote a temp file by
 * name into the legacy archive directory and renamed it over its destination, which is a write into a
 * directory whose files the hub can no longer prove are its own (structure/usage-archive.md,
 * "Suspended trim"). Every queued build, whether a trim, a read or the startup pass asked for it, is
 * refused with this before it reads or writes anything.
 */
export class ArchiveTotalsPublishingSuspendedError extends Error {
  constructor() {
    super("hourly totals are not written into the legacy usage archive while its trim is suspended");
    this.name = "ArchiveTotalsPublishingSuspendedError";
  }
}


/**
 * Builds refused or failed in this process, keyed by segment path (whose name carries its byte length)
 * and format version, so a read can list the segment in `coverage.failed` instead of pending.
 */
const failed = new Map<string, ArchiveBuildFailure>();
const failureKey = (segmentPath: string): string => `${segmentPath}\0${ARCHIVE_TOTALS_FORMAT_VERSION}`;

/** Refuse a build of one segment's totals while publishing is suspended, remembering the refusal. */
export function scheduleArchiveTotalsBuild(segmentPath: string): Promise<ArchiveTotalsFile | null> {
  failed.set(failureKey(segmentPath), { reason: "publishing-suspended" });
  return Promise.reject(new ArchiveTotalsPublishingSuspendedError());
}

/** The failure of this segment's last build in this process, if it failed or was refused. */
export function archiveTotalsBuildFailure(segmentPath: string): ArchiveBuildFailure | undefined {
  return failed.get(failureKey(segmentPath));
}

/** Queue a build unless one is queued or already failed, reporting a failure as one warning. */
export function buildArchiveTotalsInBackground(segmentPath: string): Promise<unknown> | undefined {
  if (failed.has(failureKey(segmentPath))) return undefined;
  return scheduleArchiveTotalsBuild(segmentPath).catch(error => {
    console.warn(`[usage-archive] hourly totals for ${basename(segmentPath)} could not be built: ${error instanceof Error ? error.message : String(error)}`);
  });
}
