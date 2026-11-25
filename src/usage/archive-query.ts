/**
 * The archive as reads see it: its counted segments, which of them may overlap a window, and their
 * totals files, loaded one at a time.
 *
 * The hub serves inference on the same event loop, so no request turn here is proportional to the
 * archive's size. The directory listing is cached for a few seconds and re-listed only when the
 * directory's mtime moved; only segments that may overlap the window have their totals loaded,
 * asynchronously and one file per turn; and parsed totals sit in a cache bounded by bucket count with
 * least-recently-used eviction. A read keeps a segment's span and hour index, never its buckets.
 * Reading never builds: a segment without current totals is queued, and one whose build failed is left.
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
  archiveTotalsBuildFailure,
  buildArchiveTotalsInBackground,
  readArchiveTotals,
  type ArchiveBuildFailure,
  type ArchiveHourOffset,
  type ArchiveTotalsFile,
} from "./archive-totals";
import { exactFileIdentity, usageLogPath } from "./log";

/** A listing this young is served without looking at the directory again. */
const LISTING_TTL_MS = 5_000;
/** Even with an unchanged directory mtime (coarse on some filesystems), re-list at least this often. */
const LISTING_MAX_AGE_MS = 60_000;
/** Parsed buckets kept across requests: twenty segments at their bucket cap, a few tens of MB of heap. */
export const TOTALS_CACHE_MAX_BUCKETS = 100_000;

export const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

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

/** What a read keeps of a built totals file once its buckets are summed: never the buckets. */
export interface ArchiveSegmentBuilt {
  firstRowAt: number | null;
  lastRowAt: number | null;
  hourOffsets: ArchiveHourOffset[];
}

/** A segment in a window: its span and hour index when its totals are built and current. */
export interface ArchiveSegmentState extends ArchiveSegmentEntry {
  built: ArchiveSegmentBuilt | undefined;
  failure: ArchiveBuildFailure | undefined;
}

/**
 * How long before its first row's timestamp a row can be appended. A row is stamped when its request
 * starts and appended when it completes, so a segment named by its first row can hold rows stamped
 * earlier. No hub setting bounds a request's total duration (streams are bounded by idle and connect
 * timeouts, not wall clock), so this is one hour, the slack the row reads already allow.
 */
export const ARCHIVE_APPEND_SLACK_MS = 60 * 60 * 1000;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

let liveHeadCache: { key: string; head: LiveLedgerHead; since: number | null } | null = null;

/**
 * The live ledger's inode and head row, read again when the ledger file was replaced. The key is the
 * ledger identity `usageLogIdentityKey` uses (device, inode, birth time), since a filesystem can give
 * a new ledger a retired one's inode, and the cache is also dropped on every in-process archive write,
 * which every trim makes: a stale head label would mark a published segment as unpublished.
 */
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
    const opened = fstatSync(fd);
    const size = Number(opened.size);
    const key = `${identity.dev}\0${identity.ino}\0${Number(opened.birthtimeMs)}\0${archiveChangeGeneration()}`;
    // An empty ledger can still gain a head row, so only a found one is kept.
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

/** First and last row of every totals file read, kept apart from the buckets so coverage stays exact. */
const spanCache = new Map<string, { totalsMtimeMs: number; firstRowAt: number | null; lastRowAt: number | null }>();

/** The exact span of a segment whose current totals file has been read, else undefined. */
export function knownSpan(entry: ArchiveSegmentEntry): { firstRowAt: number | null; lastRowAt: number | null } | undefined {
  const known = spanCache.get(totalsPathOf(entry));
  return known !== undefined && known.totalsMtimeMs === entry.totalsMtimeMs ? known : undefined;
}

/**
 * Whether a segment may hold rows in `[since, until)`, from what is known without reading its
 * buckets: the exact span once its totals have been read; otherwise the first-row time in its name
 * less {@link ARCHIVE_APPEND_SLACK_MS} (an untimed name gives no lower bound), and its mtime, the trim
 * time, as the last row's upper bound.
 */
export function entryMayOverlap(entry: ArchiveSegmentEntry, since: number, until: number): boolean {
  const span = knownSpan(entry);
  if (span) return span.firstRowAt !== null && span.lastRowAt !== null && span.firstRowAt < until && span.lastRowAt >= since;
  const labelled = archiveLabelTime(entry.label);
  const lowerBound = labelled === undefined ? Number.NEGATIVE_INFINITY : labelled - ARCHIVE_APPEND_SLACK_MS;
  return lowerBound < until && entry.mtimeMs >= since;
}

export function segmentOverlaps(state: ArchiveSegmentState, since: number, until: number): boolean {
  if (!state.built) return entryMayOverlap(state, since, until);
  const { firstRowAt, lastRowAt } = state.built;
  return firstRowAt !== null && lastRowAt !== null && firstRowAt < until && lastRowAt >= since;
}

/** Least-recently-used parsed totals, keyed by totals path and bounded by their bucket count. */
const totalsCache = new Map<string, { totalsMtimeMs: number; bytes: number; totals: ArchiveTotalsFile }>();
let cachedBuckets = 0;

/** Test seam: the number of totals files read from disk, to prove a window reads only its own segments. */
export const archiveTotalsReads = { count: 0 };

function evictTotals(): void {
  for (const [key, cached] of totalsCache) {
    if (cachedBuckets <= TOTALS_CACHE_MAX_BUCKETS) break;
    totalsCache.delete(key);
    cachedBuckets -= cached.totals.buckets.length;
  }
}

/** A segment's current totals, from the cache or one asynchronous read. */
export async function loadTotals(entry: ArchiveSegmentEntry): Promise<ArchiveTotalsFile | undefined> {
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

/** What a read keeps of one segment: its span and hour index, never its buckets. */
export function segmentState(entry: ArchiveSegmentEntry, totals: ArchiveTotalsFile | undefined): ArchiveSegmentState {
  return {
    ...entry,
    built: totals ? { firstRowAt: totals.firstRowAt, lastRowAt: totals.lastRowAt, hourOffsets: totals.hourOffsets } : undefined,
    failure: totals ? undefined : archiveTotalsBuildFailure(entry.path),
  };
}

/**
 * The counted segments that may overlap `[since, until)`, with their spans and hour indexes: only
 * those totals files are read, one per event-loop turn, and no buckets are kept.
 */
export async function loadWindowSegments(listing: ArchiveListing, since: number, until: number): Promise<ArchiveSegmentState[]> {
  const states: ArchiveSegmentState[] = [];
  for (const entry of listing.segments) {
    if (!entryMayOverlap(entry, since, until)) continue;
    states.push(segmentState(entry, await loadTotals(entry)));
    await yieldToEventLoop();
  }
  return states;
}

/** Queue builds for segments without totals, except those whose build already failed in this process. */
export function queueMissingTotals(states: readonly ArchiveSegmentState[]): void {
  for (const state of states) if (!state.built && !state.failure) buildArchiveTotalsInBackground(state.path);
}

/**
 * Build the totals of at most `limit` counted segments that lack current ones, newest first since
 * recent days are asked about most, and wait for them. Each goes through the paced build queue; one
 * that fails is remembered and not queued again until the process restarts. Returns how many
 * segments still lack totals, so a caller can schedule the next pass instead of queueing everything.
 */
export async function buildMissingArchiveTotals(limit: number, configDir = getConfigDir()): Promise<number> {
  const listing = await readArchiveListing(configDir);
  const missing: ArchiveSegmentEntry[] = [];
  for (const entry of [...listing.segments].reverse()) {
    // A totals file that exists is checked against its segment once; spans are then known for coverage.
    if (entry.totalsMtimeMs !== undefined && (knownSpan(entry) || await loadTotals(entry))) continue;
    if (!archiveTotalsBuildFailure(entry.path)) missing.push(entry);
    await yieldToEventLoop();
  }
  const batch = missing.slice(0, limit);
  await Promise.all(batch.map(entry => buildArchiveTotalsInBackground(entry.path)));
  return missing.length - batch.length;
}

/** The archive's whole span, exact where a totals file has been read and from names and mtimes where not. */
export function archiveSpan(listing: ArchiveListing): { earliestRowAt: number | null; latestRowAt: number | null; approximate: boolean } {
  let earliestRowAt: number | null = null;
  let latestRowAt: number | null = null;
  let approximate = false;
  for (const entry of listing.segments) {
    const known = knownSpan(entry);
    const first = known ? known.firstRowAt : archiveLabelTime(entry.label) ?? null;
    const last = known ? known.lastRowAt : entry.mtimeMs;
    approximate ||= !known;
    if (first !== null) earliestRowAt = Math.min(earliestRowAt ?? first, first);
    if (last !== null) latestRowAt = Math.max(latestRowAt ?? last, last);
  }
  return { earliestRowAt, latestRowAt, approximate };
}
