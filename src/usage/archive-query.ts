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
  segmentNameOfTotals,
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
  uncountedCoverage,
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

/**
 * A counted segment as the listing knows it: name, path, mtime, its actual length in `bytes` (which a
 * totals file must match, whatever the name says), and its totals file's revision when one exists.
 */
export interface ArchiveSegmentEntry extends ArchiveSegmentName {
  path: string;
  mtimeMs: number;
  /** The segment file's revision when listed (`archiveFileRevision`); a read checks it again. */
  segmentRevision: string;
  totalsRevision: string | undefined;
}

export interface ArchiveListing {
  /** Segments counted once each, oldest first by the first-row time in their name. */
  segments: ArchiveSegmentEntry[];
  /** Segments that cannot be told apart from a copy of other rows (`countedArchiveSegments`): read only to report them. */
  ambiguous: ArchiveSegmentEntry[];
  /** Totals files whose segment is gone: their rows are missing from the archive, not absent from it. */
  missing: ArchiveMissingSegment[];
  /** The live ledger's first timed row, where the archive's coverage ends. */
  liveLedgerSince: number | null;
  /** Whether a live ledger exists; with no timed head row it cannot show where the archive ends. */
  liveLedgerPresent: boolean;
}

/** A totals file left without its segment, by the segment name it describes. */
export interface ArchiveMissingSegment {
  segment: string;
  totalsPath: string;
}

/** What a read keeps of a built totals file once its buckets are summed: never the buckets. */
export interface ArchiveSegmentBuilt {
  firstRowAt: number | null;
  lastRowAt: number | null;
  hourOffsets: ArchiveHourOffset[];
  /** Where rows the totals did not count were stamped (`uncountedCoverage`). */
  uncounted: ReturnType<typeof uncountedCoverage>;
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
  entries: ArchiveSegmentEntry[];
  missing: ArchiveMissingSegment[];
}
let listingCache: ListingCache | null = null;

/** Drop the cached listing so the next read lists the directory again: one of its files changed. */
function invalidateListing(): void {
  listingCache = null;
}

async function listDirectory(directory: string, directoryMtimeMs: number, now: number, signal?: AbortSignal): Promise<ListingCache> {
  const generation = archiveChangeGeneration();
  const names = await readdir(directory);
  const present = new Set(names);
  const entries: ListingCache["entries"] = [];
  for (const segment of names.flatMap(name => parseArchiveSegmentName(name) ?? [])) {
    // A caller past its deadline starts no further I/O; the partial listing is discarded, never cached.
    signal?.throwIfAborted();
    const path = join(directory, segment.name);
    try {
      const segmentStat = await stat(path, { bigint: true });
      signal?.throwIfAborted();
      const totalsName = archiveTotalsName(segment.name);
      const totalsRevisionNow = present.has(totalsName) ? await totalsRevision(join(directory, totalsName)) : undefined;
      entries.push({
        ...segment, bytes: Number(segmentStat.size), path, mtimeMs: Number(segmentStat.mtimeMs),
        segmentRevision: `${segmentStat.dev}:${segmentStat.ino}:${segmentStat.size}:${segmentStat.mtimeNs}:${segmentStat.ctimeNs}`,
        totalsRevision: totalsRevisionNow,
      });
    } catch (error) {
      // Pruned between the listing and its stat: it holds nothing to count any more.
      if (!isMissing(error)) throw error;
    }
  }
  const listed = new Set(entries.map(entry => entry.name));
  const missing = names.flatMap(name => {
    const segment = segmentNameOfTotals(name);
    return segment !== undefined && parseArchiveSegmentName(segment) && !listed.has(segment) ? [{ segment, totalsPath: join(directory, name) }] : [];
  });
  // Forget parsed totals and spans of files that are gone, so neither cache outlives the archive.
  const totalsPaths = new Set(entries.map(entry => totalsPathOf(entry)));
  for (const key of [...totalsCache.keys()]) {
    if (key.startsWith(directory) && !totalsPaths.has(key)) {
      cachedBuckets -= totalsCache.get(key)!.totals.buckets.length;
      totalsCache.delete(key);
    }
  }
  for (const key of [...spanCache.keys()]) if (key.startsWith(directory) && !totalsPaths.has(key)) spanCache.delete(key);
  for (const key of [...unusableTotals.keys()]) if (key.startsWith(directory) && !totalsPaths.has(key)) unusableTotals.delete(key);
  return { directory, generation, directoryMtimeMs, checkedAt: now, listedAt: now, entries, missing };
}

const totalsPathOf = (entry: { path: string; name: string }): string => join(dirname(entry.path), archiveTotalsName(entry.name));

/**
 * The archive's counted segments, from a listing at most a few seconds old. With `signal`, no new I/O
 * starts once it aborts: the call throws its reason and caches nothing.
 */
export async function readArchiveListing(configDir = getConfigDir(), signal?: AbortSignal): Promise<ArchiveListing> {
  signal?.throwIfAborted();
  const directory = usageArchiveDirectory(configDir);
  const live = liveLedgerHead();
  const now = Date.now();
  let cache = listingCache?.directory === directory && listingCache.generation === archiveChangeGeneration() ? listingCache : null;
  if (!cache || now - cache.checkedAt >= LISTING_TTL_MS) {
    let directoryMtimeMs: number;
    try {
      directoryMtimeMs = (await stat(directory)).mtimeMs;
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!isMissing(error)) throw error;
      listingCache = null;
      return { segments: [], ambiguous: [], missing: [], liveLedgerSince: live?.since ?? null, liveLedgerPresent: live !== null };
    }
    if (cache && cache.directoryMtimeMs === directoryMtimeMs && now - cache.listedAt < LISTING_MAX_AGE_MS) cache.checkedAt = now;
    else cache = await listDirectory(directory, directoryMtimeMs, now, signal);
    signal?.throwIfAborted();
    listingCache = cache;
  }
  const { counted, ambiguous } = countedArchiveSegments(cache.entries, live?.head ?? null);
  const byLabelTime = (left: ArchiveSegmentEntry, right: ArchiveSegmentEntry): number =>
    (archiveLabelTime(left.label) ?? Number.NEGATIVE_INFINITY) - (archiveLabelTime(right.label) ?? Number.NEGATIVE_INFINITY);
  return {
    segments: counted.sort(byLabelTime), ambiguous: ambiguous.sort(byLabelTime), missing: cache.missing,
    liveLedgerSince: live?.since ?? null, liveLedgerPresent: live !== null,
  };
}

/**
 * The span a segment's rows can occupy, counted or not, from its totals: the counted rows' span joined
 * with where its uncounted rows were stamped, or `null` (unknown) when those could be anywhere. Kept
 * apart from the buckets so overlap decisions stay exact.
 */
export function rowCoverage(totals: Pick<ArchiveTotalsFile, "firstRowAt" | "lastRowAt"> & { uncounted: ReturnType<typeof uncountedCoverage> }): { firstRowAt: number | null; lastRowAt: number | null } | null {
  if (totals.uncounted === "anywhere") return null;
  if (totals.uncounted === "exact") return { firstRowAt: totals.firstRowAt, lastRowAt: totals.lastRowAt };
  return {
    firstRowAt: Math.min(totals.firstRowAt ?? totals.uncounted.firstAt, totals.uncounted.firstAt),
    lastRowAt: Math.max(totals.lastRowAt ?? totals.uncounted.lastAt, totals.uncounted.lastAt),
  };
}

const spanCache = new Map<string, { segmentRevision: string; totalsRevision: string; span: { firstRowAt: number | null; lastRowAt: number | null } | null }>();

/**
 * The span a segment's rows can occupy, once its current totals file has been read: `null` when its
 * totals cannot say (uncounted rows could be anywhere), undefined when they have not been read.
 */
export function knownSpan(entry: ArchiveSegmentEntry): { firstRowAt: number | null; lastRowAt: number | null } | null | undefined {
  const known = spanCache.get(totalsPathOf(entry));
  return known !== undefined && known.segmentRevision === entry.segmentRevision && known.totalsRevision === entry.totalsRevision
    ? known.span : undefined;
}

const spanReaches = (span: { firstRowAt: number | null; lastRowAt: number | null }, since: number, until: number): boolean =>
  span.firstRowAt !== null && span.lastRowAt !== null && span.firstRowAt < until && span.lastRowAt >= since;

/**
 * Whether a segment may hold rows in `[since, until)`: decided by its exact span once its totals have
 * been read, and otherwise always yes. A name's first-row label and a file's mtime are not a
 * trustworthy span (a request stamped before the label can be appended after it, and an mtime can be
 * changed), so a segment without read totals is never dropped by them; its totals are read, or it is
 * reported pending or failed so the answer says it is incomplete.
 */
export function entryMayOverlap(entry: ArchiveSegmentEntry, since: number, until: number): boolean {
  const span = knownSpan(entry);
  return span ? spanReaches(span, since, until) : true;
}

/**
 * Whether both of a listed segment's files are still the revisions the listing recorded. A changed one
 * drops the listing, so the next read relists; until then its span and totals prove nothing.
 */
export async function listedRevisionsCurrent(entry: ArchiveSegmentEntry): Promise<boolean> {
  const current = await archiveFileRevision(entry.path) === entry.segmentRevision
    && await archiveFileRevision(totalsPathOf(entry)) === entry.totalsRevision;
  if (!current) invalidateListing();
  return current;
}

/**
 * {@link entryMayOverlap} for a decision that skips a segment: a span only rules a segment out while
 * both of its files are the revisions the span was learned from.
 */
export async function segmentMayOverlapNow(entry: ArchiveSegmentEntry, since: number, until: number): Promise<boolean> {
  return entryMayOverlap(entry, since, until) || !await listedRevisionsCurrent(entry);
}

export function segmentOverlaps(state: ArchiveSegmentState, since: number, until: number): boolean {
  if (!state.built) return entryMayOverlap(state, since, until);
  const span = rowCoverage(state.built);
  return span ? spanReaches(span, since, until) : true;
}

/**
 * Whether a counted segment may hold rows the live ledger also holds. A published segment's rows all
 * precede the live ledger's first row, so one whose rows reach that row or later (or whose span is not
 * known, or a live ledger with no timed head to compare) may be a copy a restore put back: its
 * disjointness from the live ledger is not established, whatever its label says.
 */
export function mayDuplicateLiveLedger(state: ArchiveSegmentState, listing: ArchiveListing): boolean {
  if (!listing.liveLedgerPresent) return false;
  if (listing.liveLedgerSince === null || !state.built) return true;
  const span = rowCoverage(state.built);
  return span === null || span.lastRowAt === null || span.lastRowAt >= listing.liveLedgerSince;
}

/** Whether rows the segment's totals did not count may lie in `[since, until)`. */
export function uncountedMayOverlap(built: ArchiveSegmentBuilt, since: number, until: number): boolean {
  if (built.uncounted === "exact") return false;
  return built.uncounted === "anywhere" || (built.uncounted.firstAt < until && built.uncounted.lastAt >= since);
}

/** Least-recently-used parsed totals, keyed by totals path and bounded by their bucket count. */
const totalsCache = new Map<string, { segmentRevision: string; totalsRevision: string; totals: ArchiveTotalsFile }>();
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

/** Totals files last observed unreadable or incompatible, by the file's observed revision and the segment length they were checked against. */
const unusableTotals = new Map<string, { revision: string; bytes: number }>();

/** A file's observed revision (device, inode, size, mtime and ctime in nanoseconds), or undefined when it cannot be statted. */
export async function archiveFileRevision(path: string): Promise<string | undefined> {
  try {
    const { dev, ino, size, mtimeNs, ctimeNs } = await stat(path, { bigint: true });
    return `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
  } catch {
    return undefined;
  }
}
const totalsRevision = archiveFileRevision;

/** A segment's current totals, from the cache or one asynchronous read. */
/**
 * The segment identity a totals file must describe: device, inode, size and nanosecond mtime. A
 * version-5 file records it when built; a version-4 file did not, so the identity first seen with it
 * in this process stands in, and any other is a replacement its fields cannot verify.
 */
const sourceIdentity = (segmentRevision: string): string => segmentRevision.split(":").slice(0, 4).join(":");
const firstSeenSource = new Map<string, string>();

function totalsDescribe(entry: ArchiveSegmentEntry, totals: ArchiveTotalsFile): boolean {
  const identity = sourceIdentity(entry.segmentRevision);
  if (totals.source !== undefined) return totals.source === identity;
  const seen = firstSeenSource.get(entry.path);
  if (seen === undefined) firstSeenSource.set(entry.path, identity);
  return seen === undefined || seen === identity;
}

export async function loadTotals(entry: ArchiveSegmentEntry, signal?: AbortSignal): Promise<ArchiveTotalsFile | undefined> {
  if (entry.totalsRevision === undefined || signal?.aborted) return undefined;
  // Checked against the files as they are now, not as the listing saw them: a changed one is judged
  // by its current revision and length, and the listing is dropped so the next read relists.
  const segmentNow = await archiveFileRevision(entry.path);
  if (signal?.aborted) return undefined;
  const totalsNow = await archiveFileRevision(totalsPathOf(entry));
  if (signal?.aborted) return undefined;
  if (segmentNow === undefined || totalsNow === undefined) {
    invalidateListing();
    return undefined;
  }
  if (segmentNow !== entry.segmentRevision || totalsNow !== entry.totalsRevision) {
    invalidateListing();
    entry.segmentRevision = segmentNow;
    entry.totalsRevision = totalsNow;
    entry.bytes = Number(segmentNow.split(":")[2]);
  }
  const key = totalsPathOf(entry);
  const cached = totalsCache.get(key);
  if (cached && cached.segmentRevision === entry.segmentRevision && cached.totalsRevision === entry.totalsRevision) {
    totalsCache.delete(key);
    totalsCache.set(key, cached);
    return cached.totals;
  }
  if (cached) {
    totalsCache.delete(key);
    cachedBuckets -= cached.totals.buckets.length;
  }
  // A corrupt or incompatible totals file is read once per revision, not on every request.
  const revision = totalsNow;
  const unusable = unusableTotals.get(key);
  if (revision !== undefined && unusable?.revision === revision && unusable.bytes === entry.bytes) return undefined;
  archiveTotalsReads.count += 1;
  let totals: ArchiveTotalsFile | undefined;
  try {
    totals = await readArchiveTotals(entry.path, entry.bytes, signal);
  } catch {
    // An I/O error or a cancellation says nothing about the contents, so it is never remembered: the
    // next request reads again.
    unusableTotals.delete(key);
    return undefined;
  }
  if (signal?.aborted) return undefined;
  if (!totals) {
    if (revision !== undefined) unusableTotals.set(key, { revision, bytes: entry.bytes });
    else unusableTotals.delete(key);
    return undefined;
  }
  if (!totalsDescribe(entry, totals) || !await listedRevisionsCurrent(entry)) {
    if (revision !== undefined) unusableTotals.set(key, { revision, bytes: entry.bytes });
    return undefined;
  }
  unusableTotals.delete(key);
  const revisions = { segmentRevision: entry.segmentRevision, totalsRevision: entry.totalsRevision };
  spanCache.set(key, { ...revisions, span: rowCoverage({ ...totals, uncounted: uncountedCoverage(totals) }) });
  totalsCache.set(key, { ...revisions, totals });
  cachedBuckets += totals.buckets.length;
  evictTotals();
  return totals;
}

/** What a read keeps of one segment: its span and hour index, never its buckets. */
export function segmentState(entry: ArchiveSegmentEntry, totals: ArchiveTotalsFile | undefined): ArchiveSegmentState {
  return {
    ...entry,
    built: totals
      ? { firstRowAt: totals.firstRowAt, lastRowAt: totals.lastRowAt, hourOffsets: totals.hourOffsets, uncounted: uncountedCoverage(totals) }
      : undefined,
    failure: totals ? undefined : archiveTotalsBuildFailure(entry.path),
  };
}

/**
 * The counted segments that may overlap `[since, until)`, with their spans and hour indexes: only
 * those totals files are read, one per event-loop turn, and no buckets are kept.
 */
export async function loadWindowSegments(listing: ArchiveListing, since: number, until: number, signal?: AbortSignal): Promise<ArchiveSegmentState[]> {
  const states: ArchiveSegmentState[] = [];
  for (const entry of listing.segments) {
    // A caller past its deadline stops here; its reader reports the deadline.
    if (signal?.aborted) break;
    if (!await segmentMayOverlapNow(entry, since, until)) continue;
    states.push(segmentState(entry, await loadTotals(entry, signal)));
    await yieldToEventLoop();
  }
  return states;
}

/**
 * The ambiguous segments that may hold rows in `[since, until)`: their totals, when present, are read
 * only for their span. A window they reach cannot be answered exactly.
 */
export async function ambiguousWindowSegments(listing: ArchiveListing, since: number, until: number, signal?: AbortSignal): Promise<ArchiveSegmentEntry[]> {
  const reached: ArchiveSegmentEntry[] = [];
  for (const entry of listing.ambiguous) {
    if (signal?.aborted) break;
    if (!await segmentMayOverlapNow(entry, since, until)) continue;
    if (segmentOverlaps(segmentState(entry, await loadTotals(entry, signal)), since, until)) reached.push(entry);
    await yieldToEventLoop();
  }
  return reached;
}

/**
 * The missing segments whose rows may lie in `[since, until)`: a totals file left without its segment
 * is read only for the span it records, and one that cannot say reaches every window.
 */
export async function missingWindowSegments(listing: ArchiveListing, since: number, until: number, signal?: AbortSignal): Promise<ArchiveMissingSegment[]> {
  const reached: ArchiveMissingSegment[] = [];
  for (const missing of listing.missing) {
    if (signal?.aborted) break;
    // Only a sidecar that validates as its own segment's totals (its name, a supported version, the
    // length its name records) with known coverage may rule a window out; any other reaches them all.
    let span: { firstRowAt: number | null; lastRowAt: number | null } | null = null;
    const named = parseArchiveSegmentName(missing.segment);
    try {
      const totals = named ? await readArchiveTotals(join(dirname(missing.totalsPath), missing.segment), named.bytes, signal) : undefined;
      if (totals) span = rowCoverage({ ...totals, uncounted: uncountedCoverage(totals) });
    } catch {
      // Unreadable: it cannot say where its rows were.
    }
    if (!span || spanReaches(span, since, until)) reached.push(missing);
    await yieldToEventLoop();
  }
  return reached;
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
    if (entry.totalsRevision !== undefined && (knownSpan(entry) || await loadTotals(entry))) continue;
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
