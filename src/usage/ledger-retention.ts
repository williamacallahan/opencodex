/**
 * Opt-in size limit for the canonical usage ledger (#5063).
 *
 * Retention on usage.jsonl is the right architecture -- the alternative is a projection that
 * deletes rows the ledger still has, which is a second retention policy. What #5063's version
 * could not promise is that a row appended by another writer between its size snapshot and its
 * rename survived: it captured a size, copied a suffix, and renamed over whatever was there.
 *
 * Two things close that here. This runs synchronously in one turn, with no await between the
 * size snapshot and the publication, so no in-process append can interleave. And `validateBeforeRename` re-opens the target immediately before the rename and
 * refuses unless its identity, size and revision metadata are byte-for-byte what was copied --
 * so an append from anywhere else aborts the replacement instead of losing the row. The original
 * file and that append both survive; the next append retries from a fresh revision.
 *
 * Trimmed rows are not discarded. Before the rewrite, the span being cut is copied byte for byte
 * into `usage-archive/` beside the ledger, so the segment followed by the new ledger is exactly the
 * old ledger; a trim whose archive cannot be written does not run, and segments age out after
 * `USAGE_ARCHIVE_RETENTION_DAYS`.
 *
 * What remains outside the contract: a program that ignores the OpenCodex ledger owner entirely
 * can still write between the final comparison and the rename. No portable conditional rename
 * exists to prevent that, and the honest claim is that the race is closed for every cooperating
 * writer and detected up to the last possible moment for anything else.
 */
import { closeSync, fstatSync, openSync, readdirSync, readSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config";
import { atomicWriteFileStreamed } from "../config/atomic-write";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import {
  archiveSegmentName,
  archiveTotalsName,
  firstRowBoundary,
  noteArchiveChanged,
  parseArchiveSegmentName,
  segmentNameOfTotals,
  segmentTimeLabel,
  usageArchiveDirectory,
} from "./archive-segments";
import {
  currentUsageLogRevision,
  exactFileIdentity,
  usageLogIdentityKey,
  usageLogPath,
  usageLogRevisionKey,
  type UsageLogRevision,
} from "./log";
import {
  MIN_USAGE_LEDGER_MAX_BYTES,
  USAGE_ARCHIVE_RETENTION_DAYS,
  USAGE_LEDGER_RETENTION_TARGET_RATIO,
} from "./retention-contract";

/** Bounded copy buffer. Matches the ledger scanner's chunk so one storage policy governs both. */
const COPY_CHUNK_BYTES = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export class UsageLedgerRevisionChangedError extends Error {
  readonly code = "usage_ledger_revision_changed";

  constructor() {
    super("usage ledger changed while its retained span was being published");
    this.name = "UsageLedgerRevisionChangedError";
  }
}

export type UsageLedgerRetentionResult =
  | { kind: "disabled" }
  | { kind: "unchanged"; currentBytes: number }
  | { kind: "replaced"; currentBytes: number; removedBytes: number; archivePath: string }
  | { kind: "deferred"; currentBytes: number; reason: "revision-changed" | "no-boundary" };

function copyRange(sourceFd: number, targetFd: number, from: number, to: number): void {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  for (let position = from; position < to;) {
    const read = readSync(sourceFd, buffer, 0, Math.min(buffer.byteLength, to - position), position);
    if (read <= 0) throw new Error("usage ledger shrank while its retained span was copied");
    let written = 0;
    while (written < read) written += writeSync(targetFd, buffer, written, read - written);
    position += read;
  }
}

/** A segment this young may belong to a trim still running in another process, short of its rename. */
const UNPUBLISHED_SEGMENT_MIN_AGE_MS = 5 * 60 * 1000;

/** The temp name `atomicWriteFileStreamed` gives a segment while it copies: `<segment>.ocx.<pid>.<sequence>.tmp`. */
const SEGMENT_TEMP = /^(.+\.jsonl)\.ocx\.\d+\.\d+\.tmp$/;

interface Leftover {
  name: string;
  /** A crashed writer's temp file, which has no totals file of its own. */
  temp: boolean;
}

/** Segments of the ledger file with this inode, and with `temps` their writers' temp files; totals files never match. */
function leftoversOf(directory: string, ino: string, temps: boolean): Leftover[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry): Leftover[] => {
    if (!entry.isFile()) return [];
    if (parseArchiveSegmentName(entry.name)?.ino === ino) return [{ name: entry.name, temp: false }];
    const segment = temps ? SEGMENT_TEMP.exec(entry.name)?.[1] : undefined;
    return segment !== undefined && parseArchiveSegmentName(segment)?.ino === ino ? [{ name: entry.name, temp: true }] : [];
  });
}

function errorCode(error: unknown): string {
  const detail = error instanceof Error ? error : undefined;
  return detail && "code" in detail && typeof detail.code === "string" ? detail.code : detail?.name ?? "unknown";
}

/**
 * Run one entry's step; a failure warns once with the entry's path and error code and lets the loop go
 * on, so one unreadable or vanished file never stops the cleanup of the others or the trim itself.
 */
function eachEntry(path: string, what: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    console.warn(`[usage-retention] ${what} could not be removed (${errorCode(error)}): ${path}`);
  }
}

/** Delete a leftover, then its totals file in its own step, so a totals file that will not go never keeps the segment. */
function removeLeftover(directory: string, leftover: Leftover, what: string): void {
  unlinkSync(join(directory, leftover.name));
  if (leftover.temp) return;
  const totals = join(directory, archiveTotalsName(leftover.name));
  eachEntry(totals, `the hourly totals of ${what}`, () => rmSync(totals, { force: true }));
}

/**
 * Delete a segment an earlier trim of THIS ledger file wrote before it was stopped short of the
 * rename. A completed trim publishes a new file through a rename, so the live ledger's inode in a
 * segment name means that trim never published; its rows are still at the head of the ledger and
 * the coming segment archives them again. The inode alone is not proof, since a filesystem may
 * reuse a retired ledger's inode for a later one, so a segment is deleted only when its bytes are
 * still the ledger's own prefix, and never while it is young enough to be another process's trim
 * that has not reached its rename yet. A crashed writer's `.tmp` copy of such a segment goes by the
 * same rule: the age check is what spares a temp another process is still writing.
 */
function removeUnpublishedSegments(directory: string, sourceFd: number, sourceIno: string, sourceSize: number, now: number): void {
  for (const leftover of leftoversOf(directory, sourceIno, true)) {
    const path = join(directory, leftover.name);
    eachEntry(path, "an unpublished archive leftover", () => {
      const stat = statSync(path);
      if (stat.size > sourceSize || now - stat.mtimeMs < UNPUBLISHED_SEGMENT_MIN_AGE_MS) return;
      if (isPrefixOf(path, stat.size, sourceFd)) removeLeftover(directory, leftover, "an unpublished archive leftover");
    });
  }
}

/**
 * After a publish, delete every other segment named with the replaced ledger's inode that shares its
 * bytes with the segment just written, the shorter being the longer's prefix: it is the leftover of an
 * earlier trim of that same file that never published, and every row it holds is now in the new segment
 * or, past that segment's end, in the ledger just published. A young leftover goes too: once this trim
 * replaced the file, no trim of the old file can publish any more. Temp files are left alone here:
 * a young one may still be another writer's, and the next trim's age rule removes a crashed one.
 */
function removeSupersededSegments(archivePath: string, sourceIno: string): void {
  const directory = dirname(archivePath);
  const archiveFd = openSync(archivePath, "r");
  try {
    const archiveSize = Number(fstatSync(archiveFd).size);
    for (const leftover of leftoversOf(directory, sourceIno, false)) {
      const path = join(directory, leftover.name);
      if (path === archivePath) continue;
      eachEntry(path, "a superseded archive segment", () => {
        // Shorter: every row it holds is in the new segment. Longer, with the new segment its prefix (a
        // trim killed before its rename, then a smaller cut after the limit was raised): the rows past the
        // new segment's end are in the ledger just published. Either way the shorter is the longer's prefix.
        const size = Math.min(statSync(path).size, archiveSize);
        if (isPrefixOf(path, size, archiveFd)) removeLeftover(directory, leftover, "a superseded archive segment");
      });
    }
  } finally {
    closeSync(archiveFd);
  }
}

/** Whether the file's `size` bytes equal the first `size` bytes of the file open on `fd`, compared one chunk at a time. */
function isPrefixOf(path: string, size: number, ledgerFd: number): boolean {
  const segmentFd = openSync(path, "r");
  try {
    const segment = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    const ledger = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    for (let position = 0; position < size;) {
      const length = Math.min(COPY_CHUNK_BYTES, size - position);
      const segmentRead = readSync(segmentFd, segment, 0, length, position);
      const ledgerRead = readSync(ledgerFd, ledger, 0, length, position);
      if (segmentRead !== length || ledgerRead !== length || !segment.subarray(0, length).equals(ledger.subarray(0, length))) return false;
      position += length;
    }
    return true;
  } finally {
    closeSync(segmentFd);
  }
}

/**
 * Delete archive files last written more than {@link USAGE_ARCHIVE_RETENTION_DAYS} ago.
 *
 * Age is the file's modification time, not the timestamp in its name: the name carries the
 * segment's OLDEST row, while the file is written by the trim, after every row it holds was
 * appended, so its mtime is never earlier than any of them. An expired mtime therefore proves
 * every row in the file is past the floor. Any file counts, so a temp a crash left behind ages out too.
 * A totals file is built after its segment, so its own mtime says nothing; it goes with its segment.
 */
function pruneUsageArchive(directory: string, now: number): void {
  const cutoff = now - USAGE_ARCHIVE_RETENTION_DAYS * DAY_MS;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    eachEntry(path, "an expired archive file", () => {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    });
  }
  const names = new Set(readdirSync(directory));
  for (const name of names) {
    const segment = segmentNameOfTotals(name);
    if (segment === undefined || names.has(segment)) continue;
    const path = join(directory, name);
    eachEntry(path, "the hourly totals of a removed archive segment", () => rmSync(path, { force: true }));
  }
}

/**
 * Copy the span a trim is about to discard, byte for byte, into its own flushed archive file.
 *
 * The directory is never created here. In the container image it is a named volume's mount point,
 * and creating it on demand would put the archive in the container's own layer, where the next
 * redeploy deletes it without a word. A missing or unwritable directory throws, and no trim runs.
 */
function archiveTrimmedSpan(sourceFd: number, start: number, source: UsageLogRevision): string {
  const configDir = getConfigDir();
  const directory = usageArchiveDirectory(configDir);
  try {
    const now = new Date();
    pruneUsageArchive(directory, now.getTime());
    removeUnpublishedSegments(directory, sourceFd, source.ino, source.size, now.getTime());
    const path = join(directory, archiveSegmentName(segmentTimeLabel(sourceFd, start, now), source.ino, start));
    // Uninstall removes an owned directory with everything in it, so one manifest entry covers
    // every segment; one entry per segment would fill the capped manifest in about a year.
    recordOwnedConfigPath(configDir, directory);
    atomicWriteFileStreamed(path, descriptor => copyRange(sourceFd, descriptor, 0, start), {}, { recordOwnership: false });
    noteArchiveChanged();
    return path;
  } catch (cause) {
    throw new Error(
      `the ledger was not trimmed because its oldest rows could not be archived in ${directory}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

function sameRevision(a: UsageLogRevision | null, b: UsageLogRevision | null): boolean {
  return a !== null && b !== null
    && usageLogIdentityKey(a) === usageLogIdentityKey(b)
    && usageLogRevisionKey(a) === usageLogRevisionKey(b)
    && a.size === b.size;
}

/**
 * Trim the ledger to the newest whole rows when it exceeds `maxBytes`.
 *
 * Rows are copied BYTE FOR BYTE and never parsed or re-serialized. That is what keeps the
 * failure stage and cause, the attempts, the spend record and any field a later build adds
 * intact through a compaction: a retention pass that understood the row shape would silently
 * drop every field it was written before.
 */
export function enforceUsageLedgerSizeLimit(
  maxBytes: number | undefined,
  /**
   * Runs after the retained span is copied and before the pre-rename check.
   *
   * A parameter rather than an exported flag, so the only way to reach this window is to be the
   * caller. The revision guard below is the one piece of this module that cannot be observed
   * from its inputs and outputs, and a contract nothing can drive is a contract nobody has
   * checked.
   */
  options: { onSpanCopied?: () => void } = {},
): UsageLedgerRetentionResult {
  if (maxBytes === undefined || !Number.isSafeInteger(maxBytes) || maxBytes < MIN_USAGE_LEDGER_MAX_BYTES) {
    return { kind: "disabled" };
  }
  const captured = currentUsageLogRevision();
  if (!captured || captured.size <= maxBytes) {
    return captured ? { kind: "unchanged", currentBytes: captured.size } : { kind: "disabled" };
  }
  const path = usageLogPath();
  // Trim below the ceiling rather than to it, so an append does not immediately re-cross the
  // line and make every subsequent append pay for a full rewrite.
  const target = Math.floor(maxBytes * USAGE_LEDGER_RETENTION_TARGET_RATIO);
  let sourceFd: number;
  try {
    sourceFd = openSync(path, "r");
  } catch {
    return { kind: "deferred", currentBytes: captured.size, reason: "revision-changed" };
  }
  let sourceClosed = false;
  try {
    const opened = fstatSync(sourceFd);
    if (Number(opened.size) !== captured.size || exactFileIdentity(sourceFd).ino !== captured.ino) {
      return { kind: "deferred", currentBytes: captured.size, reason: "revision-changed" };
    }
    const start = firstRowBoundary(sourceFd, Math.max(0, captured.size - target), captured.size);
    // No LF in the retained window means one row is larger than the whole target. Deleting it
    // would empty the ledger to satisfy a ceiling it cannot meet, so nothing is done.
    if (start === null || start >= captured.size) {
      return { kind: "deferred", currentBytes: captured.size, reason: "no-boundary" };
    }
    const archivePath = archiveTrimmedSpan(sourceFd, start, captured);
    try {
      atomicWriteFileStreamed(path, descriptor => {
        copyRange(sourceFd, descriptor, start, captured.size);
        // Windows cannot replace a destination held open by this reader. The
        // copied bytes are complete; keep the pathname revision guard below.
        closeSync(sourceFd);
        sourceClosed = true;
        options.onSpanCopied?.();
      }, {
        // The last possible moment. Anything that appended, replaced or rewrote the ledger while
        // the copy ran moves size, inode or revision metadata, and the throw leaves both the
        // original file and that write exactly as they are.
        validateBeforeRename: () => {
          if (!sameRevision(currentUsageLogRevision(), captured)) {
            throw new UsageLedgerRevisionChangedError();
          }
        },
      });
    } catch (error) {
      // While the ledger is still this trim's source it holds these rows, so the segment would archive
      // them twice. Once its inode changed, something else replaced it and these rows may now exist
      // only in the segment, so it stays.
      if (currentUsageLogRevision()?.ino === captured.ino) rmSync(archivePath, { force: true });
      throw error;
    }
    // The ledger is already replaced, so a leftover this cannot delete is only a stale duplicate row range: the
    // trim stays published and the caller still invalidates its readers. Each leftover warns on its own; this
    // catches only the new segment itself failing to open or list its directory.
    try {
      removeSupersededSegments(archivePath, captured.ino);
      noteArchiveChanged();
    } catch (error) {
      console.warn(`[usage-retention] the ledger was trimmed but its superseded archive segments could not be listed (${errorCode(error)}): ${archivePath}`);
    }
    return { kind: "replaced", currentBytes: captured.size - start, removedBytes: start, archivePath };
  } catch (error) {
    if (error instanceof UsageLedgerRevisionChangedError) {
      return { kind: "deferred", currentBytes: captured.size, reason: "revision-changed" };
    }
    throw error;
  } finally {
    if (!sourceClosed) closeSync(sourceFd);
  }
}
