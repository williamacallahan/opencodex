/**
 * Hourly totals for one usage archive segment, so a question about any window in the last 31 days is
 * answered from a few thousand additive buckets instead of gigabytes of rows.
 *
 * The file beside `<segment>.jsonl` is `<segment>.hourly.json`. A segment never changes after its
 * trim publishes it, so its totals stay valid while the file's `version` is current and its `bytes`
 * equal the segment's length; anything else is rebuilt. A build reads the segment through the ledger
 * scanner (the same 1 MiB row ceiling, torn-row rule, and cooperative yields as every ledger read),
 * keeps only the buckets in memory, and publishes through the atomic writer.
 *
 * Every dimension is caller-influenced (a data-plane caller declares its own machine name and
 * workload), so the builder bounds the file: each dimension keeps the live summary's 1,000 distinct
 * keys per segment and folds the rest into `(other)`, and a segment keeps at most
 * {@link MAX_BUCKETS_PER_SEGMENT} buckets, folding any further combination into one all-`(other)`
 * bucket for its hour. Builds run one at a time, in the background, each started from a timer at
 * least {@link BUILD_GAP_MS} after the previous one finished, and never on a request.
 */
import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteFileStreamed } from "../config/atomic-write";
import { rowWorkloadSource } from "../server/request-attribution";
import { archiveTotalsName, noteArchiveChanged } from "./archive-segments";
import { OVERFLOW_KEY, RETAINED_KEYS } from "./attribution-breakdown";
import { scanUsageLedgerCooperatively, UsageLedgerRebuildRequiredError } from "./ledger-scanner";
import type { PersistedUsageEntry } from "./log";
import { addEstimatedCost, cacheTokensFromUsage, computeEntryCost } from "./summary";
import { usageDisplayTotalTokens } from "./totals";

/** Bump when a bucket's key or sums change meaning; every older file is then rebuilt. */
export const ARCHIVE_TOTALS_FORMAT_VERSION = 3;
const HOUR_MS = 60 * 60 * 1000;
/** About 350 bytes of JSON per bucket, so a totals file stays under 2 MB. */
export const MAX_BUCKETS_PER_SEGMENT = 5_000;
/** Idle time between two builds, so a backlog of segments never runs back to back. */
export const BUILD_GAP_MS = 250;
/** The largest instant a `Date` can hold; a row stamped outside `[0, this]` is treated as untimed. */
export const MAX_DATE_MS = 8_640_000_000_000_000;

/** The dimensions a bucket is keyed by. A row that lacks one stores `""`, never drops it. */
export const ARCHIVE_DIMENSIONS = [
  "provider", "model", "harness", "workloadLauncher", "workloadSource", "clientHost", "clientAddress", "account",
] as const;
export type ArchiveDimension = typeof ARCHIVE_DIMENSIONS[number];

/** One value per dimension, built in one place so the set is listed once. */
export function perArchiveDimension<T>(make: (dimension: ArchiveDimension) => T): { [dimension in ArchiveDimension]: T } {
  return {
    provider: make("provider"), model: make("model"), harness: make("harness"), workloadLauncher: make("workloadLauncher"),
    workloadSource: make("workloadSource"), clientHost: make("clientHost"), clientAddress: make("clientAddress"), account: make("account"),
  };
}

export const ARCHIVE_SUMS = [
  "requests", "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "totalTokens",
  "estimatedCostUsd", "pricedRequests", "unpricedRequests", "unmeteredRequests",
] as const;
export type ArchiveSums = { [sum in typeof ARCHIVE_SUMS[number]]: number };

export type ArchiveHourBucket = { hour: number } & { [dimension in ArchiveDimension]: string } & ArchiveSums;

export interface ArchiveTotalsFile {
  version: typeof ARCHIVE_TOTALS_FORMAT_VERSION;
  segment: string;
  /** The segment's byte length when the totals were built. */
  bytes: number;
  /** Rows counted into the buckets. */
  rows: number;
  /**
   * Rows that did not parse, failed the row schema, exceeded the row ceiling, had no timestamp in
   * `[0, 8.64e15]`, or carried a non-finite or negative token or cost or a non-string dimension.
   */
  unparsableRows: number;
  firstRowAt: number | null;
  lastRowAt: number | null;
  buckets: ArchiveHourBucket[];
  /**
   * For each UTC hour with rows, the byte offset of the first row (in file order) stamped in that
   * hour, in file order. A row read seeks here instead of scanning the segment from its start.
   */
  hourOffsets: ArchiveHourOffset[];
  /** Per dimension, the rows whose value arrived after 1,000 distinct ones and were counted as `(other)`. */
  overflowRows: { [dimension in ArchiveDimension]: number };
  /** Rows counted in their hour's all-`(other)` bucket because the segment already held its bucket cap. */
  foldedRows: number;
}

export interface ArchiveHourOffset {
  hour: number;
  offset: number;
}

export function blankArchiveSums(): ArchiveSums {
  return {
    requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0,
    estimatedCostUsd: 0, pricedRequests: 0, unpricedRequests: 0, unmeteredRequests: 0,
  };
}

export function addArchiveSums(into: ArchiveSums, from: ArchiveSums): void {
  for (const sum of ARCHIVE_SUMS) into[sum] += from[sum];
}

/** The part of the workload before its first `:`: the launcher or product that named the session. */
export function workloadLauncher(workload: string | undefined): string {
  return typeof workload === "string" ? workload.split(":", 1)[0]! : "";
}

/** The value a row holds for every dimension, as buckets key it and filters compare it. */
export function archiveDimensionValues(entry: PersistedUsageEntry): { [dimension in ArchiveDimension]: string } {
  return {
    provider: entry.provider,
    model: entry.model ?? "",
    harness: entry.client ?? "",
    workloadLauncher: workloadLauncher(entry.workload),
    workloadSource: rowWorkloadSource(entry) ?? "",
    clientHost: entry.clientHost ?? "",
    clientAddress: entry.clientAddress ?? "",
    account: entry.accountLogLabel ?? "",
  };
}

/** Whether a row's timestamp can name an hour: an integer instant a `Date` can hold. */
export function isArchiveTimestamp(timestamp: unknown): timestamp is number {
  return typeof timestamp === "number" && Number.isInteger(timestamp) && timestamp >= 0 && timestamp <= MAX_DATE_MS;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * One row's contribution, with the same token and cost rules the live usage summary applies, or
 * undefined when any sum is not a finite non-negative number (a `usage: {}` row sums to NaN), so a
 * hand-edited row can never write a value the reader would reject.
 */
function rowContribution(entry: PersistedUsageEntry): ArchiveSums | undefined {
  const sums = blankArchiveSums();
  sums.requests = 1;
  if (entry.usage) {
    sums.inputTokens = entry.usage.inputTokens;
    sums.outputTokens = entry.usage.outputTokens;
    const { read, creation } = cacheTokensFromUsage(entry.usage);
    if (read !== undefined) sums.cacheReadInputTokens = read;
    if (creation !== undefined) sums.cacheCreationInputTokens = creation;
    sums.totalTokens = usageDisplayTotalTokens(entry.usage, entry.totalTokens) ?? 0;
  }
  addEstimatedCost(sums, entry, computeEntryCost(entry));
  return ARCHIVE_SUMS.every(sum => isCount(sums[sum])) ? sums : undefined;
}

export interface ArchiveTotalsBuildOptions {
  /** Test seam for the scanner's read size; production always uses its 1 MiB default. */
  chunkBytes?: number;
}

/** Read the whole segment once and publish its totals file. A segment that vanished publishes nothing. */
export async function buildArchiveTotals(segmentPath: string, options: ArchiveTotalsBuildOptions = {}): Promise<ArchiveTotalsFile | null> {
  const buckets = new Map<string, ArchiveHourBucket>();
  const hourOffsets = new Map<number, number>();
  const seen = perArchiveDimension(() => new Set<string>());
  const overflowRows = perArchiveDimension(() => 0);
  let foldedRows = 0;
  let rows = 0;
  let rejectedRows = 0;
  let firstRowAt: number | null = null;
  let lastRowAt: number | null = null;
  const scan = await scanUsageLedgerCooperatively({
    path: segmentPath,
    ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}),
    onEntry: (entry, rowStartBytes) => {
      const values = archiveDimensionValues(entry);
      const sums = isArchiveTimestamp(entry.timestamp) && ARCHIVE_DIMENSIONS.every(dimension => typeof values[dimension] === "string")
        ? rowContribution(entry)
        : undefined;
      if (!sums) {
        rejectedRows += 1;
        return;
      }
      rows += 1;
      firstRowAt = firstRowAt === null ? entry.timestamp : Math.min(firstRowAt, entry.timestamp);
      lastRowAt = lastRowAt === null ? entry.timestamp : Math.max(lastRowAt, entry.timestamp);
      const hour = Math.floor(entry.timestamp / HOUR_MS) * HOUR_MS;
      if (!hourOffsets.has(hour)) hourOffsets.set(hour, rowStartBytes);
      const keys = perArchiveDimension(dimension => {
        const value = values[dimension];
        if (seen[dimension].has(value)) return value;
        if (seen[dimension].size < RETAINED_KEYS) {
          seen[dimension].add(value);
          return value;
        }
        overflowRows[dimension] += 1;
        return OVERFLOW_KEY;
      });
      let key = JSON.stringify([hour, ...ARCHIVE_DIMENSIONS.map(dimension => keys[dimension])]);
      let bucket = buckets.get(key);
      if (!bucket && buckets.size >= MAX_BUCKETS_PER_SEGMENT) {
        foldedRows += 1;
        const folded = perArchiveDimension(() => OVERFLOW_KEY);
        key = JSON.stringify([hour, ...ARCHIVE_DIMENSIONS.map(dimension => folded[dimension])]);
        bucket = buckets.get(key);
        if (!bucket) {
          bucket = { hour, ...folded, ...blankArchiveSums() };
          buckets.set(key, bucket);
        }
      } else if (!bucket) {
        bucket = { hour, ...keys, ...blankArchiveSums() };
        buckets.set(key, bucket);
      }
      addArchiveSums(bucket, sums);
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
    buckets: [...buckets.values()],
    hourOffsets: [...hourOffsets].map(([hour, offset]) => ({ hour, offset })),
    overflowRows,
    foldedRows,
  };
  const text = JSON.stringify(totals);
  atomicWriteFileStreamed(archiveTotalsPath(segmentPath), descriptor => writeFileSync(descriptor, text), {}, { recordOwnership: false });
  noteArchiveChanged();
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
    && ARCHIVE_SUMS.every(sum => isCount(bucket[sum]));
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
 * The read is asynchronous; parsing and validating are bounded by the per-segment bucket cap.
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
    || !Array.isArray(file.hourOffsets) || !file.hourOffsets.every(isHourOffset)
    || !isOverflowCounts(file.overflowRows) || !isCount(file.foldedRows)) return undefined;
  return parsed as ArchiveTotalsFile;
}

/** Why a build failed: the segment changed while read, a filesystem error, or anything else. */
export type ArchiveBuildFailure = { reason: "segment-changed" } | { reason: "io-error"; code: string } | { reason: "build-error" };

function classifyBuildFailure(error: unknown): ArchiveBuildFailure {
  if (error instanceof UsageLedgerRebuildRequiredError) return { reason: "segment-changed" };
  if (error instanceof Error && "code" in error && typeof error.code === "string") return { reason: "io-error", code: error.code };
  return { reason: "build-error" };
}

const scheduled = new Map<string, Promise<ArchiveTotalsFile | null>>();
/**
 * Builds that failed in this process, keyed by segment path (whose name carries its byte length) and
 * format version. They are not queued again automatically until the process restarts, so a segment
 * that always fails never turns every archive read into another full build.
 */
const failed = new Map<string, ArchiveBuildFailure>();
const failureKey = (segmentPath: string): string => `${segmentPath}\0${ARCHIVE_TOTALS_FORMAT_VERSION}`;
let queueTail: Promise<unknown> = Promise.resolve();

/**
 * Queue a background build of one segment's totals. Builds run one at a time in arrival order, each
 * started from a timer {@link BUILD_GAP_MS} after the queue frees, so neither the caller's turn nor
 * the previous build's tail runs the next one. A segment already queued is not queued twice. The
 * returned promise rejects when the build fails, and the failure is remembered.
 */
export function scheduleArchiveTotalsBuild(segmentPath: string, options: ArchiveTotalsBuildOptions = {}): Promise<ArchiveTotalsFile | null> {
  const existing = scheduled.get(segmentPath);
  if (existing) return existing;
  const run = queueTail
    .then(() => new Promise<void>(resolve => setTimeout(resolve, BUILD_GAP_MS)))
    .then(() => buildArchiveTotals(segmentPath, options))
    .then(
      totals => {
        failed.delete(failureKey(segmentPath));
        return totals;
      },
      (error: unknown) => {
        failed.set(failureKey(segmentPath), classifyBuildFailure(error));
        throw error;
      },
    )
    .finally(() => scheduled.delete(segmentPath));
  queueTail = run.catch(() => undefined);
  scheduled.set(segmentPath, run);
  return run;
}

/** The failure of this segment's last build in this process, if it failed. */
export function archiveTotalsBuildFailure(segmentPath: string): ArchiveBuildFailure | undefined {
  return failed.get(failureKey(segmentPath));
}

/** Queue a build unless one is queued or already failed, reporting a failure as one warning. */
export function buildArchiveTotalsInBackground(segmentPath: string): void {
  if (scheduled.has(segmentPath) || failed.has(failureKey(segmentPath))) return;
  scheduleArchiveTotalsBuild(segmentPath).catch(error => {
    console.warn(`[usage-archive] hourly totals for ${basename(segmentPath)} could not be built: ${error instanceof Error ? error.message : String(error)}`);
  });
}
