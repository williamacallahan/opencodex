/**
 * Hourly totals for one usage archive segment, so a question about any window in the last 31 days is
 * answered from a few thousand additive buckets instead of gigabytes of rows.
 *
 * The file beside `<segment>.jsonl` is `<segment>.hourly.json`. A segment never changes after its
 * trim publishes it, so its totals stay valid while the file's `version` is current and its `bytes`
 * equal the segment's length; anything else is rebuilt. A build reads the segment through the ledger
 * scanner (the same 1 MiB row ceiling, torn-row rule, and cooperative yields as every ledger read),
 * keeps only the buckets in memory, and publishes through the atomic writer. Builds run one at a
 * time, in the background, and never on a request.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteFileStreamed } from "../config/atomic-write";
import { rowWorkloadSource } from "../server/request-attribution";
import { archiveTotalsName } from "./archive-segments";
import { scanUsageLedgerCooperatively } from "./ledger-scanner";
import type { PersistedUsageEntry } from "./log";
import { addEstimatedCost, cacheTokensFromUsage, computeEntryCost } from "./summary";
import { usageDisplayTotalTokens } from "./totals";

/** Bump when a bucket's key or sums change meaning; every older file is then rebuilt. */
export const ARCHIVE_TOTALS_FORMAT_VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;

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
  /** Rows that did not parse, failed the row schema, exceeded the row ceiling, or had no usable timestamp. */
  unparsableRows: number;
  firstRowAt: number | null;
  lastRowAt: number | null;
  buckets: ArchiveHourBucket[];
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
  return workload === undefined ? "" : workload.split(":", 1)[0]!;
}

function bucketKeys(entry: PersistedUsageEntry): { [dimension in ArchiveDimension]: string } {
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

/** One row's contribution, with the same token and cost rules the live usage summary applies. */
function addRow(sums: ArchiveSums, entry: PersistedUsageEntry): void {
  sums.requests += 1;
  if (entry.usage) {
    sums.inputTokens += entry.usage.inputTokens;
    sums.outputTokens += entry.usage.outputTokens;
    const { read, creation } = cacheTokensFromUsage(entry.usage);
    if (typeof read === "number") sums.cacheReadInputTokens += read;
    if (typeof creation === "number") sums.cacheCreationInputTokens += creation;
    sums.totalTokens += usageDisplayTotalTokens(entry.usage, entry.totalTokens) ?? 0;
  }
  addEstimatedCost(sums, entry, computeEntryCost(entry));
}

export interface ArchiveTotalsBuildOptions {
  /** Test seam for the scanner's read size; production always uses its 1 MiB default. */
  chunkBytes?: number;
}

/** Read the whole segment once and publish its totals file. A segment that vanished publishes nothing. */
export async function buildArchiveTotals(segmentPath: string, options: ArchiveTotalsBuildOptions = {}): Promise<ArchiveTotalsFile | null> {
  const buckets = new Map<string, ArchiveHourBucket>();
  let rows = 0;
  let untimedRows = 0;
  let firstRowAt: number | null = null;
  let lastRowAt: number | null = null;
  const scan = await scanUsageLedgerCooperatively({
    path: segmentPath,
    ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}),
    onEntry: entry => {
      if (!Number.isFinite(entry.timestamp)) {
        untimedRows += 1;
        return;
      }
      rows += 1;
      firstRowAt = firstRowAt === null ? entry.timestamp : Math.min(firstRowAt, entry.timestamp);
      lastRowAt = lastRowAt === null ? entry.timestamp : Math.max(lastRowAt, entry.timestamp);
      const keys = { hour: Math.floor(entry.timestamp / HOUR_MS) * HOUR_MS, ...bucketKeys(entry) };
      const key = JSON.stringify(keys);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { ...keys, ...blankArchiveSums() };
        buckets.set(key, bucket);
      }
      addRow(bucket, entry);
    },
  });
  if (!scan.revision) return null;
  const totals: ArchiveTotalsFile = {
    version: ARCHIVE_TOTALS_FORMAT_VERSION,
    segment: basename(segmentPath),
    bytes: scan.revision.size,
    rows,
    unparsableRows: scan.invalidRows + scan.oversizedRows + untimedRows,
    firstRowAt,
    lastRowAt,
    buckets: [...buckets.values()],
  };
  const text = JSON.stringify(totals);
  atomicWriteFileStreamed(archiveTotalsPath(segmentPath), descriptor => writeFileSync(descriptor, text), {}, { recordOwnership: false });
  return totals;
}

export function archiveTotalsPath(segmentPath: string): string {
  return join(dirname(segmentPath), archiveTotalsName(basename(segmentPath)));
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isInstant = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isFinite(value));

function isBucket(value: unknown): value is ArchiveHourBucket {
  if (typeof value !== "object" || value === null) return false;
  const bucket = value as Record<string, unknown>;
  return typeof bucket.hour === "number" && Number.isFinite(bucket.hour)
    && ARCHIVE_DIMENSIONS.every(dimension => typeof bucket[dimension] === "string")
    && ARCHIVE_SUMS.every(sum => isCount(bucket[sum]));
}

/**
 * The totals file for a segment of `segmentBytes`, or undefined when it is missing, unreadable, from
 * another format version, or built from a different length: each of those means it must be rebuilt.
 */
export function readArchiveTotals(segmentPath: string, segmentBytes: number): ArchiveTotalsFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(archiveTotalsPath(segmentPath), "utf8"));
  } catch {
    // Missing or torn: the build that rewrites it is the handling.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const file = parsed as Record<string, unknown>;
  if (file.version !== ARCHIVE_TOTALS_FORMAT_VERSION || file.bytes !== segmentBytes
    || !isCount(file.rows) || !isCount(file.unparsableRows) || !isInstant(file.firstRowAt) || !isInstant(file.lastRowAt)
    || !Array.isArray(file.buckets) || !file.buckets.every(isBucket)) return undefined;
  return parsed as ArchiveTotalsFile;
}

const scheduled = new Map<string, Promise<ArchiveTotalsFile | null>>();
let queueTail: Promise<unknown> = Promise.resolve();

/**
 * Queue a background build of one segment's totals. Builds run one at a time in arrival order, and a
 * segment already queued is not queued twice. The returned promise rejects when the build fails.
 */
export function scheduleArchiveTotalsBuild(segmentPath: string, options: ArchiveTotalsBuildOptions = {}): Promise<ArchiveTotalsFile | null> {
  const existing = scheduled.get(segmentPath);
  if (existing) return existing;
  const run = queueTail.then(() => buildArchiveTotals(segmentPath, options)).finally(() => scheduled.delete(segmentPath));
  queueTail = run.catch(() => undefined);
  scheduled.set(segmentPath, run);
  return run;
}

/** Queue a build whose failure is reported as one warning instead of a rejection. */
export function buildArchiveTotalsInBackground(segmentPath: string): void {
  scheduleArchiveTotalsBuild(segmentPath).catch(error => {
    console.warn(`[usage-archive] hourly totals for ${basename(segmentPath)} could not be built: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** Whether a segment's totals build is queued or running. */
export function archiveTotalsBuildQueued(segmentPath: string): boolean {
  return scheduled.has(segmentPath);
}
