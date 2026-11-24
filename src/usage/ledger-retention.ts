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
import { join } from "node:path";
import { getConfigDir } from "../config";
import { atomicWriteFileStreamed } from "../config/atomic-write";
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

/** The `timestamp` of the ledger's first row, which names the segment that archives it. */
function firstRowTimestamp(fd: number, end: number): Date {
  const rowEnd = firstRowBoundary(fd, 0, end);
  if (rowEnd === null) throw new Error("the first ledger row has no line ending");
  const bytes = Buffer.allocUnsafe(rowEnd - 1);
  for (let position = 0; position < bytes.byteLength;) {
    const read = readSync(fd, bytes, position, bytes.byteLength - position, position);
    if (read <= 0) throw new Error("usage ledger shrank while its first row was read");
    position += read;
  }
  let row: unknown;
  try {
    row = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw new Error("the first ledger row is not JSON", { cause });
  }
  const at = typeof row === "object" && row !== null && "timestamp" in row && typeof row.timestamp === "number"
    ? new Date(row.timestamp)
    : null;
  if (at === null || Number.isNaN(at.getTime())) throw new Error("the first ledger row has no numeric timestamp");
  return at;
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
function archiveTrimmedSpan(sourceFd: number, start: number, sourceIno: string): string {
  const directory = join(getConfigDir(), "usage-archive");
  try {
    pruneUsageArchive(directory, Date.now());
    const firstRowAt = firstRowTimestamp(sourceFd, start).toISOString().replaceAll(":", "-");
    const path = join(directory, `${firstRowAt}_${sourceIno}-${start}.jsonl`);
    atomicWriteFileStreamed(path, descriptor => copyRange(sourceFd, descriptor, 0, start));
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
    const archivePath = archiveTrimmedSpan(sourceFd, start, captured.ino);
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
      // The ledger still holds these rows, so keeping the segment would archive them twice.
      rmSync(archivePath, { force: true });
      throw error;
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
