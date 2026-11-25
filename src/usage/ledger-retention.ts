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
  | { kind: "replaced"; currentBytes: number; removedBytes: number }
  | { kind: "deferred"; currentBytes: number; reason: "revision-changed" | "no-boundary" };

/**
 * The first LF at or after `from`, so the retained span starts on a row boundary.
 *
 * Any nonempty suffix that is not LF-terminated is uncommitted by the scanner's definition, even
 * if it happens to parse. Starting anywhere but after an LF would publish half a row as a whole
 * one, which is the shape that makes a ledger unreadable rather than merely shorter.
 */
function firstRowBoundary(fd: number, from: number, end: number): number | null {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  for (let position = from; position < end;) {
    const read = readSync(fd, buffer, 0, Math.min(buffer.byteLength, end - position), position);
    if (read <= 0) return null;
    const index = buffer.subarray(0, read).indexOf(0x0a);
    if (index >= 0) return position + index + 1;
    position += read;
  }
  return null;
}

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

function readRange(fd: number, from: number, to: number): Buffer {
  const bytes = Buffer.allocUnsafe(to - from);
  for (let offset = 0; offset < bytes.byteLength;) {
    const read = readSync(fd, bytes, offset, bytes.byteLength - offset, from + offset);
    if (read <= 0) throw new Error("usage ledger shrank while it was read");
    offset += read;
  }
  return bytes;
}

function rowTimestamp(line: Buffer): Date | undefined {
  let row: unknown;
  try {
    row = JSON.parse(line.toString("utf8"));
  } catch {
    // A hand-edited or torn row cannot name the segment; the next row may.
    return undefined;
  }
  const at = typeof row === "object" && row !== null && "timestamp" in row && typeof row.timestamp === "number"
    ? new Date(row.timestamp)
    : undefined;
  return at && !Number.isNaN(at.getTime()) ? at : undefined;
}

/** Names a segment whose cut span holds no row with a usable timestamp, in place of the row time. */
const UNTIMED_SEGMENT_MARKER = "untimed";
/** Rows read for a timestamp before the segment is named from the trim time instead. */
const MAX_TIMESTAMP_SCAN_ROWS = 64;
/** A segment this young may belong to a trim still running in another process, short of its rename. */
const UNPUBLISHED_SEGMENT_MIN_AGE_MS = 5 * 60 * 1000;

/**
 * The name prefix of the segment archiving `[0, end)`: the timestamp of the first row in that span
 * that parses with a numeric one, else the marker plus the trim time. A row that cannot name it
 * never stops the trim, which would otherwise leave the ledger growing past its limit for good.
 */
function segmentTimeLabel(fd: number, end: number, now: Date): string {
  for (let position = 0, rows = 0; position < end && rows < MAX_TIMESTAMP_SCAN_ROWS; rows++) {
    const rowEnd = firstRowBoundary(fd, position, end);
    if (rowEnd === null) break;
    const at = rowTimestamp(readRange(fd, position, rowEnd - 1));
    if (at) return at.toISOString().replaceAll(":", "-");
    position = rowEnd;
  }
  return `${UNTIMED_SEGMENT_MARKER}-${now.toISOString().replaceAll(":", "-")}`;
}

/**
 * Delete a segment an earlier trim of THIS ledger file wrote before it was stopped short of the
 * rename. A completed trim publishes a new file through a rename, so the live ledger's inode in a
 * segment name means that trim never published; its rows are still at the head of the ledger and
 * the coming segment archives them again. The inode alone is not proof, since a filesystem may
 * reuse a retired ledger's inode for a later one, so a segment is deleted only when its bytes are
 * still the ledger's own prefix, and never while it is young enough to be another process's trim
 * that has not reached its rename yet.
 */
/** Another writer's temp file, named by `atomicWriteFileStreamed` while it copies; its rename is still ahead. */
const isInFlightTemp = (name: string): boolean => name.endsWith(".tmp");

function removeUnpublishedSegments(directory: string, sourceFd: number, sourceIno: string, sourceSize: number, now: number): void {
  const marker = `_${sourceIno}-`;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.includes(marker) || isInFlightTemp(entry.name)) continue;
    const path = join(directory, entry.name);
    const stat = statSync(path);
    if (stat.size > sourceSize || now - stat.mtimeMs < UNPUBLISHED_SEGMENT_MIN_AGE_MS) continue;
    if (isPrefixOf(path, stat.size, sourceFd)) unlinkSync(path);
  }
}

/**
 * After a publish, delete every other segment named with the replaced ledger's inode whose bytes are a
 * prefix of the segment just written: it is the leftover of an earlier trim of that same file that never
 * published, and every row it holds is now in the new segment. A young leftover goes too: once this trim
 * replaced the file, no trim of the old file can publish any more.
 */
function removeSupersededSegments(archivePath: string, sourceIno: string): void {
  const directory = dirname(archivePath);
  const marker = `_${sourceIno}-`;
  const archiveFd = openSync(archivePath, "r");
  try {
    const archiveSize = Number(fstatSync(archiveFd).size);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (!entry.isFile() || !entry.name.includes(marker) || isInFlightTemp(entry.name) || path === archivePath) continue;
      const size = statSync(path).size;
      if (size <= archiveSize && isPrefixOf(path, size, archiveFd)) unlinkSync(path);
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
 */
function pruneUsageArchive(directory: string, now: number): void {
  const cutoff = now - USAGE_ARCHIVE_RETENTION_DAYS * DAY_MS;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
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
  const directory = join(configDir, "usage-archive");
  try {
    const now = new Date();
    pruneUsageArchive(directory, now.getTime());
    removeUnpublishedSegments(directory, sourceFd, source.ino, source.size, now.getTime());
    const path = join(directory, `${segmentTimeLabel(sourceFd, start, now)}_${source.ino}-${start}.jsonl`);
    // Uninstall removes an owned directory with everything in it, so one manifest entry covers
    // every segment; one entry per segment would fill the capped manifest in about a year.
    recordOwnedConfigPath(configDir, directory);
    atomicWriteFileStreamed(path, descriptor => copyRange(sourceFd, descriptor, 0, start), {}, { recordOwnership: false });
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
    // trim stays published and the caller still invalidates its readers.
    try {
      removeSupersededSegments(archivePath, captured.ino);
    } catch (error) {
      const detail = error instanceof Error ? error : undefined;
      const code = detail && "code" in detail && typeof detail.code === "string" ? detail.code : detail?.name ?? "unknown";
      const failedPath = detail && "path" in detail && typeof detail.path === "string" ? detail.path : archivePath;
      console.warn(`[usage-retention] the ledger was trimmed but a superseded archive segment could not be removed (${code}): ${failedPath}`);
    }
    return { kind: "replaced", currentBytes: captured.size - start, removedBytes: start };
  } catch (error) {
    if (error instanceof UsageLedgerRevisionChangedError) {
      return { kind: "deferred", currentBytes: captured.size, reason: "revision-changed" };
    }
    throw error;
  } finally {
    if (!sourceClosed) closeSync(sourceFd);
  }
}
