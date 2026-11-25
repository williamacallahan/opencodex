/**
 * Usage totals for a window inside the archive, answered only from the hourly totals files.
 *
 * Reading the archive never builds anything: a counted segment in the window whose totals are missing
 * or stale is reported `pending`, and the route queues its background build. Rows still in
 * `usage.jsonl` are never part of the answer; `liveLedgerSince` says where the live ledger begins so a
 * caller can add `/api/usage` for the rest.
 */
import { closeSync, fstatSync, openSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import {
  archiveLabelTime,
  archiveTotalsName,
  countedArchiveSegments,
  firstTimedRow,
  ledgerHeadLabel,
  parseArchiveSegmentName,
  usageArchiveDirectory,
  type ArchiveSegmentName,
  type LiveLedgerHead,
} from "./archive-segments";
import {
  addArchiveSums,
  ARCHIVE_DIMENSIONS,
  blankArchiveSums,
  perArchiveDimension,
  readArchiveTotals,
  scheduleArchiveTotalsBuild,
  type ArchiveDimension,
  type ArchiveSums,
  type ArchiveTotalsFile,
} from "./archive-totals";
import { exactFileIdentity, usageLogPath } from "./log";

export const ARCHIVE_BREAKDOWN_ROWS = 200;

export interface ArchiveSegmentState {
  segment: ArchiveSegmentName;
  path: string;
  bytes: number;
  mtimeMs: number;
  /** Absent while the totals are missing, stale, or from another format version. */
  totals: ArchiveTotalsFile | undefined;
}

export interface ArchiveListing {
  /** Segments counted once each, oldest first by their first row. */
  segments: ArchiveSegmentState[];
  /** Leftover duplicates and unpublished trims of the live ledger, never counted. */
  skipped: ArchiveSegmentName[];
  /** The live ledger's first timed row, where the archive's coverage ends. */
  liveLedgerSince: number | null;
}

const totalsCache = new Map<string, { mtimeMs: number; bytes: number; totals: ArchiveTotalsFile }>();

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function liveLedgerHead(): { head: LiveLedgerHead; since: number | null } | null {
  let fd: number;
  try {
    fd = openSync(usageLogPath(), "r");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const size = Number(fstatSync(fd).size);
    const since = firstTimedRow(fd, size)?.getTime() ?? null;
    return { head: { ino: exactFileIdentity(fd).ino, label: ledgerHeadLabel(fd, size) }, since };
  } finally {
    closeSync(fd);
  }
}

/** Totals parsed once per totals-file revision; a request re-reads only files that changed. */
function cachedTotals(directory: string, segment: ArchiveSegmentName, segmentPath: string, bytes: number): ArchiveTotalsFile | undefined {
  const totalsPath = join(directory, archiveTotalsName(segment.name));
  let mtimeMs: number;
  try {
    mtimeMs = statSync(totalsPath).mtimeMs;
  } catch (error) {
    if (isMissing(error)) {
      totalsCache.delete(totalsPath);
      return undefined;
    }
    throw error;
  }
  const cached = totalsCache.get(totalsPath);
  if (cached && cached.mtimeMs === mtimeMs && cached.bytes === bytes) return cached.totals;
  const totals = readArchiveTotals(segmentPath, bytes);
  if (totals) totalsCache.set(totalsPath, { mtimeMs, bytes, totals });
  else totalsCache.delete(totalsPath);
  return totals;
}

export function readArchiveListing(configDir = getConfigDir()): ArchiveListing {
  const directory = usageArchiveDirectory(configDir);
  const live = liveLedgerHead();
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if (isMissing(error)) return { segments: [], skipped: [], liveLedgerSince: live?.since ?? null };
    throw error;
  }
  const parsed = names.flatMap(name => parseArchiveSegmentName(name) ?? []);
  const { counted, skipped } = countedArchiveSegments(parsed, live?.head ?? null);
  const segments: ArchiveSegmentState[] = [];
  const seen = new Set<string>();
  for (const segment of counted) {
    const path = join(directory, segment.name);
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      // Pruned between the listing and here: it holds nothing to count any more.
      if (isMissing(error)) continue;
      throw error;
    }
    seen.add(join(directory, archiveTotalsName(segment.name)));
    const bytes = Number(stat.size);
    segments.push({ segment, path, bytes, mtimeMs: stat.mtimeMs, totals: cachedTotals(directory, segment, path, bytes) });
  }
  for (const key of totalsCache.keys()) if (key.startsWith(directory) && !seen.has(key)) totalsCache.delete(key);
  segments.sort((left, right) => segmentFirstRowAt(left) - segmentFirstRowAt(right));
  return { segments, skipped, liveLedgerSince: live?.since ?? null };
}

function segmentFirstRowAt(state: ArchiveSegmentState): number {
  return state.totals?.firstRowAt ?? archiveLabelTime(state.segment.label) ?? Number.NEGATIVE_INFINITY;
}

/**
 * Whether a segment may hold rows in `[since, until)`. Built totals give the exact span; a pending
 * segment's first row is in its name and its last row is no later than its mtime, the trim time.
 */
export function segmentOverlaps(state: ArchiveSegmentState, since: number, until: number): boolean {
  if (state.totals) {
    const { firstRowAt, lastRowAt } = state.totals;
    return firstRowAt !== null && lastRowAt !== null && firstRowAt < until && lastRowAt >= since;
  }
  return segmentFirstRowAt(state) < until && state.mtimeMs >= since;
}

/**
 * Build the totals of every counted segment that lacks current ones, newest first since recent days
 * are asked about most, one at a time through the build queue. A failed segment logs one warning and
 * is left for the next read to queue again; nothing retries in a loop.
 */
export async function buildMissingArchiveTotals(configDir = getConfigDir()): Promise<void> {
  const missing = readArchiveListing(configDir).segments.filter(state => !state.totals).reverse();
  for (const state of missing) {
    try {
      await scheduleArchiveTotalsBuild(state.path);
    } catch (error) {
      console.warn(`[usage-archive] hourly totals for ${state.segment.name} could not be built: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export type ArchiveFilter = Partial<Record<ArchiveDimension, string>>;

export interface ArchiveBreakdown {
  rows: Array<{ key: string } & ArchiveSums>;
  /** Keys left out after the first {@link ARCHIVE_BREAKDOWN_ROWS}. */
  truncated: number;
}

export interface ArchiveTotalsAnswer {
  summary: ArchiveSums;
  segmentsInRange: number;
  pendingSegments: ArchiveSegmentState[];
  unparsableRows: number;
  earliestRowAt: number | null;
  latestRowAt: number | null;
  /** Some segment had no totals, so its first row came from its name and its last from its mtime. */
  spanApproximate: boolean;
  /** Every hour of the window that has rows, oldest first; the window itself bounds its length. */
  byHour: Array<{ key: string } & ArchiveSums>;
  byDimension: { [dimension in ArchiveDimension]: ArchiveBreakdown };
}

function tally<K>(map: Map<K, ArchiveSums>, key: K, sums: ArchiveSums): void {
  let current = map.get(key);
  if (!current) {
    current = blankArchiveSums();
    map.set(key, current);
  }
  addArchiveSums(current, sums);
}

function topRows(map: Map<string, ArchiveSums>): ArchiveBreakdown {
  const rows = [...map].map(([key, sums]) => ({ key, ...sums }))
    .sort((left, right) => right.requests - left.requests || right.totalTokens - left.totalTokens || left.key.localeCompare(right.key));
  return { rows: rows.slice(0, ARCHIVE_BREAKDOWN_ROWS), truncated: Math.max(0, rows.length - ARCHIVE_BREAKDOWN_ROWS) };
}

/** Sum the buckets of every counted segment whose hour lies in `[since, until)` and matches the filter. */
export function answerArchiveTotals(listing: ArchiveListing, since: number, until: number, filter: ArchiveFilter): ArchiveTotalsAnswer {
  const summary = blankArchiveSums();
  const byHour = new Map<number, ArchiveSums>();
  const byDimension = perArchiveDimension(() => new Map<string, ArchiveSums>());
  const filters = ARCHIVE_DIMENSIONS.flatMap(dimension => filter[dimension] === undefined ? [] : [[dimension, filter[dimension]!] as const]);
  const pendingSegments: ArchiveSegmentState[] = [];
  let segmentsInRange = 0;
  let unparsableRows = 0;
  let earliestRowAt: number | null = null;
  let latestRowAt: number | null = null;
  let spanApproximate = false;
  for (const state of listing.segments) {
    const totals = state.totals;
    // Without totals the name gives the first row and the mtime bounds the last, so coverage never
    // understates what the archive holds while builds are pending.
    const first = totals ? totals.firstRowAt : archiveLabelTime(state.segment.label) ?? null;
    const last = totals ? totals.lastRowAt : state.mtimeMs;
    spanApproximate ||= !totals;
    if (first !== null) earliestRowAt = Math.min(earliestRowAt ?? first, first);
    if (last !== null) latestRowAt = Math.max(latestRowAt ?? last, last);
    if (!segmentOverlaps(state, since, until)) continue;
    segmentsInRange += 1;
    if (!totals) {
      pendingSegments.push(state);
      continue;
    }
    unparsableRows += totals.unparsableRows;
    for (const bucket of totals.buckets) {
      if (bucket.hour < since || bucket.hour >= until) continue;
      if (filters.some(([dimension, wanted]) => bucket[dimension] !== wanted)) continue;
      addArchiveSums(summary, bucket);
      tally(byHour, bucket.hour, bucket);
      for (const dimension of ARCHIVE_DIMENSIONS) tally(byDimension[dimension], bucket[dimension], bucket);
    }
  }
  return {
    summary,
    segmentsInRange,
    pendingSegments,
    unparsableRows,
    earliestRowAt,
    latestRowAt,
    spanApproximate,
    byHour: [...byHour].sort(([left], [right]) => left - right).map(([hour, sums]) => ({ key: new Date(hour).toISOString(), ...sums })),
    byDimension: perArchiveDimension(dimension => topRows(byDimension[dimension])),
  };
}
