/**
 * Usage totals for a window inside the archive, answered only from the hourly totals files.
 *
 * The hub serves inference on the same event loop, so no request turn here is proportional to the
 * archive's size. The directory listing is cached for a few seconds and re-listed only when the
 * directory's mtime moved; only segments that may overlap the window, judged from the first-row time
 * in their name and their mtime, have their totals loaded, asynchronously and one file per turn;
 * parsed totals sit in a cache bounded by bucket count with least-recently-used eviction; and the
 * aggregation yields every few thousand buckets. Reading never builds: a segment without current
 * totals is reported `pending` and queued, and one whose build failed is reported `failed` and left.
 */
import { closeSync, fstatSync, openSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config";
import {
  archiveChangeGeneration,
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
  archiveTotalsBuildFailure,
  blankArchiveSums,
  buildArchiveTotalsInBackground,
  perArchiveDimension,
  readArchiveTotals,
  type ArchiveBuildFailure,
  type ArchiveDimension,
  type ArchiveSums,
  type ArchiveTotalsFile,
} from "./archive-totals";
import { exactFileIdentity, usageLogPath } from "./log";

export const ARCHIVE_BREAKDOWN_ROWS = 200;
/** A listing this young is served without looking at the directory again. */
const LISTING_TTL_MS = 5_000;
/** Even with an unchanged directory mtime (coarse on some filesystems), re-list at least this often. */
const LISTING_MAX_AGE_MS = 60_000;
/** Parsed buckets kept across requests: twenty segments at their bucket cap, a few tens of MB of heap. */
export const TOTALS_CACHE_MAX_BUCKETS = 100_000;
/** Buckets summed between two yields to the event loop. */
const AGGREGATION_SLICE_BUCKETS = 2_000;

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** A counted segment as the listing knows it: name, path, length, mtime, and whether a totals file exists. */
export interface ArchiveSegmentEntry extends ArchiveSegmentName {
  path: string;
  mtimeMs: number;
  totalsMtimeMs: number | undefined;
}

export interface ArchiveListing {
  /** Segments counted once each, oldest first by the first-row time in their name. */
  segments: ArchiveSegmentEntry[];
  /** Leftover duplicates and unpublished trims of the live ledger, never counted. */
  skipped: ArchiveSegmentName[];
  /** The live ledger's first timed row, where the archive's coverage ends. */
  liveLedgerSince: number | null;
}

/** A segment in a window, with its totals when they are built and current. */
export interface ArchiveSegmentState extends ArchiveSegmentEntry {
  totals: ArchiveTotalsFile | undefined;
  failure: ArchiveBuildFailure | undefined;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

let liveHeadCache: { key: string; head: LiveLedgerHead; since: number | null } | null = null;

/** The live ledger's inode and head row, read again only when the ledger file itself was replaced. */
function liveLedgerHead(): { head: LiveLedgerHead; since: number | null } | null {
  let fd: number;
  try {
    fd = openSync(usageLogPath(), "r");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const identity = exactFileIdentity(fd);
    const size = Number(fstatSync(fd).size);
    const key = `${identity.dev}\0${identity.ino}`;
    // A trim replaces the file, so the head changes only with the inode; an empty ledger can still gain one.
    if (liveHeadCache?.key === key && liveHeadCache.since !== null) return liveHeadCache;
    liveHeadCache = { key, head: { ino: identity.ino, label: ledgerHeadLabel(fd, size) }, since: firstTimedRow(fd, size)?.getTime() ?? null };
    return liveHeadCache;
  } finally {
    closeSync(fd);
  }
}

interface ListingCache {
  directory: string;
  generation: number;
  directoryMtimeMs: number;
  checkedAt: number;
  listedAt: number;
  entries: Array<ArchiveSegmentName & { path: string; mtimeMs: number; totalsMtimeMs: number | undefined }>;
}
let listingCache: ListingCache | null = null;

async function listDirectory(directory: string, directoryMtimeMs: number, now: number): Promise<ListingCache> {
  const generation = archiveChangeGeneration();
  const names = await readdir(directory);
  const present = new Set(names);
  const entries: ListingCache["entries"] = [];
  for (const segment of names.flatMap(name => parseArchiveSegmentName(name) ?? [])) {
    const path = join(directory, segment.name);
    try {
      const segmentStat = await stat(path);
      const totalsName = archiveTotalsName(segment.name);
      const totalsMtimeMs = present.has(totalsName) ? (await stat(join(directory, totalsName)).catch(() => undefined))?.mtimeMs : undefined;
      entries.push({ ...segment, path, mtimeMs: segmentStat.mtimeMs, totalsMtimeMs });
    } catch (error) {
      // Pruned between the listing and its stat: it holds nothing to count any more.
      if (!isMissing(error)) throw error;
    }
  }
  // Forget parsed totals and spans of files that are gone, so neither cache outlives the archive.
  const totalsPaths = new Set(entries.map(entry => totalsPathOf(entry)));
  for (const key of [...totalsCache.keys()]) {
    if (key.startsWith(directory) && !totalsPaths.has(key)) {
      cachedBuckets -= totalsCache.get(key)!.totals.buckets.length;
      totalsCache.delete(key);
    }
  }
  for (const key of [...spanCache.keys()]) if (key.startsWith(directory) && !totalsPaths.has(key)) spanCache.delete(key);
  return { directory, generation, directoryMtimeMs, checkedAt: now, listedAt: now, entries };
}

const totalsPathOf = (entry: { path: string; name: string }): string => join(dirname(entry.path), archiveTotalsName(entry.name));

/** The archive's counted segments, from a listing at most a few seconds old. */
export async function readArchiveListing(configDir = getConfigDir()): Promise<ArchiveListing> {
  const directory = usageArchiveDirectory(configDir);
  const live = liveLedgerHead();
  const now = Date.now();
  let cache = listingCache?.directory === directory && listingCache.generation === archiveChangeGeneration() ? listingCache : null;
  if (!cache || now - cache.checkedAt >= LISTING_TTL_MS) {
    let directoryMtimeMs: number;
    try {
      directoryMtimeMs = (await stat(directory)).mtimeMs;
    } catch (error) {
      if (!isMissing(error)) throw error;
      listingCache = null;
      return { segments: [], skipped: [], liveLedgerSince: live?.since ?? null };
    }
    if (cache && cache.directoryMtimeMs === directoryMtimeMs && now - cache.listedAt < LISTING_MAX_AGE_MS) cache.checkedAt = now;
    else cache = await listDirectory(directory, directoryMtimeMs, now);
    listingCache = cache;
  }
  const { counted, skipped } = countedArchiveSegments(cache.entries, live?.head ?? null);
  counted.sort((left, right) => (archiveLabelTime(left.label) ?? Number.NEGATIVE_INFINITY) - (archiveLabelTime(right.label) ?? Number.NEGATIVE_INFINITY));
  return { segments: counted, skipped, liveLedgerSince: live?.since ?? null };
}

/**
 * Whether a segment may hold rows in `[since, until)`, from its listing alone: its first row is in
 * its name (an untimed name gives no lower bound) and its last row is no later than its mtime, the
 * trim time. Totals, once loaded, give the exact span.
 */
function entryMayOverlap(entry: ArchiveSegmentEntry, since: number, until: number): boolean {
  return (archiveLabelTime(entry.label) ?? Number.NEGATIVE_INFINITY) < until && entry.mtimeMs >= since;
}

export function segmentOverlaps(state: ArchiveSegmentState, since: number, until: number): boolean {
  if (!state.totals) return entryMayOverlap(state, since, until);
  const { firstRowAt, lastRowAt } = state.totals;
  return firstRowAt !== null && lastRowAt !== null && firstRowAt < until && lastRowAt >= since;
}

/** Least-recently-used parsed totals, keyed by totals path and bounded by their bucket count. */
const totalsCache = new Map<string, { totalsMtimeMs: number; bytes: number; totals: ArchiveTotalsFile }>();
let cachedBuckets = 0;
/** First and last row of every totals file seen, kept apart from the buckets so coverage stays exact. */
const spanCache = new Map<string, { totalsMtimeMs: number; firstRowAt: number | null; lastRowAt: number | null }>();

/** Test seam: the number of totals files read from disk, to prove a window reads only its own segments. */
export const archiveTotalsReads = { count: 0 };

function evictTotals(): void {
  for (const [key, cached] of totalsCache) {
    if (cachedBuckets <= TOTALS_CACHE_MAX_BUCKETS) break;
    totalsCache.delete(key);
    cachedBuckets -= cached.totals.buckets.length;
  }
}

async function loadTotals(entry: ArchiveSegmentEntry): Promise<ArchiveTotalsFile | undefined> {
  if (entry.totalsMtimeMs === undefined) return undefined;
  const key = totalsPathOf(entry);
  const cached = totalsCache.get(key);
  if (cached && cached.totalsMtimeMs === entry.totalsMtimeMs && cached.bytes === entry.bytes) {
    totalsCache.delete(key);
    totalsCache.set(key, cached);
    return cached.totals;
  }
  if (cached) {
    totalsCache.delete(key);
    cachedBuckets -= cached.totals.buckets.length;
  }
  archiveTotalsReads.count += 1;
  const totals = await readArchiveTotals(entry.path, entry.bytes);
  if (!totals) return undefined;
  spanCache.set(key, { totalsMtimeMs: entry.totalsMtimeMs, firstRowAt: totals.firstRowAt, lastRowAt: totals.lastRowAt });
  totalsCache.set(key, { totalsMtimeMs: entry.totalsMtimeMs, bytes: entry.bytes, totals });
  cachedBuckets += totals.buckets.length;
  evictTotals();
  return totals;
}

/**
 * The counted segments that may overlap `[since, until)`, with their totals loaded: only those files
 * are read, one per event-loop turn.
 */
export async function loadWindowSegments(listing: ArchiveListing, since: number, until: number): Promise<ArchiveSegmentState[]> {
  const states: ArchiveSegmentState[] = [];
  for (const entry of listing.segments) {
    if (!entryMayOverlap(entry, since, until)) continue;
    const totals = await loadTotals(entry);
    states.push({ ...entry, totals, failure: totals ? undefined : archiveTotalsBuildFailure(entry.path) });
    await yieldToEventLoop();
  }
  return states;
}

/** Queue builds for segments without totals, except those whose build already failed in this process. */
export function queueMissingTotals(states: readonly ArchiveSegmentState[]): void {
  for (const state of states) if (!state.totals && !state.failure) buildArchiveTotalsInBackground(state.path);
}

/**
 * Build the totals of every counted segment that lacks current ones, newest first since recent days
 * are asked about most. Each goes through the build queue, which runs one at a time with an idle gap
 * between builds; one that fails is remembered and not queued again until the process restarts.
 */
export async function buildMissingArchiveTotals(configDir = getConfigDir()): Promise<void> {
  const listing = await readArchiveListing(configDir);
  for (const entry of [...listing.segments].reverse()) {
    if (await loadTotals(entry)) continue;
    buildArchiveTotalsInBackground(entry.path);
    await yieldToEventLoop();
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
  failedSegments: ArchiveSegmentState[];
  unparsableRows: number;
  earliestRowAt: number | null;
  latestRowAt: number | null;
  /** Some segment's span came from its name and mtime because its totals have not been read yet. */
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

/** The archive's whole span, exact where a totals file has been read and from names and mtimes where not. */
function archiveSpan(listing: ArchiveListing): { earliestRowAt: number | null; latestRowAt: number | null; approximate: boolean } {
  let earliestRowAt: number | null = null;
  let latestRowAt: number | null = null;
  let approximate = false;
  for (const entry of listing.segments) {
    const known = spanCache.get(totalsPathOf(entry));
    const exact = known !== undefined && known.totalsMtimeMs === entry.totalsMtimeMs;
    const first = exact ? known.firstRowAt : archiveLabelTime(entry.label) ?? null;
    const last = exact ? known.lastRowAt : entry.mtimeMs;
    approximate ||= !exact;
    if (first !== null) earliestRowAt = Math.min(earliestRowAt ?? first, first);
    if (last !== null) latestRowAt = Math.max(latestRowAt ?? last, last);
  }
  return { earliestRowAt, latestRowAt, approximate };
}

/** Sum the buckets of every window segment whose hour lies in `[since, until)` and matches the filter. */
export async function answerArchiveTotals(
  listing: ArchiveListing,
  states: readonly ArchiveSegmentState[],
  since: number,
  until: number,
  filter: ArchiveFilter,
): Promise<ArchiveTotalsAnswer> {
  const summary = blankArchiveSums();
  const byHour = new Map<number, ArchiveSums>();
  const byDimension = perArchiveDimension(() => new Map<string, ArchiveSums>());
  const filters = ARCHIVE_DIMENSIONS.flatMap(dimension => filter[dimension] === undefined ? [] : [[dimension, filter[dimension]!] as const]);
  const pendingSegments: ArchiveSegmentState[] = [];
  const failedSegments: ArchiveSegmentState[] = [];
  let segmentsInRange = 0;
  let unparsableRows = 0;
  let sinceYield = 0;
  for (const state of states) {
    if (!segmentOverlaps(state, since, until)) continue;
    segmentsInRange += 1;
    const totals = state.totals;
    if (!totals) {
      (state.failure ? failedSegments : pendingSegments).push(state);
      continue;
    }
    unparsableRows += totals.unparsableRows;
    for (const bucket of totals.buckets) {
      if (++sinceYield >= AGGREGATION_SLICE_BUCKETS) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
      if (bucket.hour < since || bucket.hour >= until) continue;
      if (filters.some(([dimension, wanted]) => bucket[dimension] !== wanted)) continue;
      addArchiveSums(summary, bucket);
      tally(byHour, bucket.hour, bucket);
      for (const dimension of ARCHIVE_DIMENSIONS) tally(byDimension[dimension], bucket[dimension], bucket);
    }
  }
  const span = archiveSpan(listing);
  return {
    summary,
    segmentsInRange,
    pendingSegments,
    failedSegments,
    unparsableRows,
    earliestRowAt: span.earliestRowAt,
    latestRowAt: span.latestRowAt,
    spanApproximate: span.approximate,
    byHour: [...byHour].sort(([left], [right]) => left - right).map(([hour, sums]) => ({ key: new Date(hour).toISOString(), ...sums })),
    byDimension: perArchiveDimension(dimension => topRows(byDimension[dimension])),
  };
}
