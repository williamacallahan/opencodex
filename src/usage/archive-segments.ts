/**
 * Names and identity of the usage archive's files: the segments a ledger trim writes, and the
 * hourly totals file built beside each one.
 *
 * A segment is `<first row UTC>_<ledger inode>-<cut offset>.jsonl` and holds bytes `[0, cut)` of the
 * ledger file that inode named. A completed trim publishes the new ledger through a rename, so every
 * published segment comes from a different file and covers rows no other published segment holds.
 * The only overlaps are the leftovers `src/usage/ledger-retention.ts` cleans up and can fail to:
 * a segment of the same file and the same first row is a byte prefix of the larger one, and a
 * segment named with the live ledger's inode and first row is a trim that never published, whose
 * rows are still at the head of `usage.jsonl`. {@link countedArchiveSegments} applies that rule.
 */
import { readSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";

const ROW_READ_CHUNK_BYTES = 1024 * 1024;
const SEGMENT_SUFFIX = ".jsonl";
const TOTALS_SUFFIX = ".hourly.json";
const SEGMENT_NAME = /^([^_/\\]+)_(\d+)-(\d+)\.jsonl$/;
const TIME_LABEL = /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z)$/;
/** Names a segment whose cut span holds no row with a usable timestamp, in place of the row time. */
const UNTIMED_SEGMENT_MARKER = "untimed";
/** Rows read for a timestamp before the segment is named from the trim time instead. */
const MAX_TIMESTAMP_SCAN_ROWS = 64;

export interface ArchiveSegmentName {
  name: string;
  /** The first timed row's UTC time with `:` replaced by `-`, or `untimed-<trim time>`. */
  label: string;
  /** Exact decimal inode of the ledger file the segment was cut from. */
  ino: string;
  /** The cut offset, which is also the segment's byte length. */
  bytes: number;
}

export function usageArchiveDirectory(configDir = getConfigDir()): string {
  return join(configDir, "usage-archive");
}

export function parseArchiveSegmentName(name: string): ArchiveSegmentName | undefined {
  const match = SEGMENT_NAME.exec(name);
  if (!match) return undefined;
  const bytes = Number(match[3]);
  return Number.isSafeInteger(bytes) ? { name, label: match[1]!, ino: match[2]!, bytes } : undefined;
}

export function archiveSegmentName(label: string, ino: string, bytes: number): string {
  return `${label}_${ino}-${bytes}${SEGMENT_SUFFIX}`;
}

/** The hourly totals file that belongs to a segment: the same name with `.hourly.json` for `.jsonl`. */
export function archiveTotalsName(segmentName: string): string {
  return `${segmentName.slice(0, -SEGMENT_SUFFIX.length)}${TOTALS_SUFFIX}`;
}

/** The segment a totals file belongs to, or undefined when the name is not a totals file. */
export function segmentNameOfTotals(name: string): string | undefined {
  return name.endsWith(TOTALS_SUFFIX) ? `${name.slice(0, -TOTALS_SUFFIX.length)}${SEGMENT_SUFFIX}` : undefined;
}

/** The instant a time label names, or undefined for an untimed label. */
export function archiveLabelTime(label: string): number | undefined {
  const match = TIME_LABEL.exec(label);
  if (!match) return undefined;
  const at = Date.parse(`${match[1]}${match[2]}:${match[3]}:${match[4]}`);
  return Number.isNaN(at) ? undefined : at;
}

function timeLabel(at: Date): string {
  return at.toISOString().replaceAll(":", "-");
}

/**
 * The first LF at or after `from`, so a span starts on a row boundary.
 *
 * Any nonempty suffix that is not LF-terminated is uncommitted by the scanner's definition, even
 * if it happens to parse. Starting anywhere but after an LF would publish half a row as a whole
 * one, which is the shape that makes a ledger unreadable rather than merely shorter.
 */
export function firstRowBoundary(fd: number, from: number, end: number): number | null {
  const buffer = Buffer.allocUnsafe(ROW_READ_CHUNK_BYTES);
  for (let position = from; position < end;) {
    const read = readSync(fd, buffer, 0, Math.min(buffer.byteLength, end - position), position);
    if (read <= 0) return null;
    const index = buffer.subarray(0, read).indexOf(0x0a);
    if (index >= 0) return position + index + 1;
    position += read;
  }
  return null;
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

/** The timestamp of the first of the span's first 64 rows that parses with a numeric one. */
export function firstTimedRow(fd: number, end: number): Date | undefined {
  for (let position = 0, rows = 0; position < end && rows < MAX_TIMESTAMP_SCAN_ROWS; rows++) {
    const rowEnd = firstRowBoundary(fd, position, end);
    if (rowEnd === null) break;
    const at = rowTimestamp(readRange(fd, position, rowEnd - 1));
    if (at) return at;
    position = rowEnd;
  }
  return undefined;
}

/**
 * The name prefix of the segment archiving `[0, end)`: the timestamp of the first row in that span
 * that parses with a numeric one, else the marker plus the trim time. A row that cannot name it
 * never stops the trim, which would otherwise leave the ledger growing past its limit for good.
 */
export function segmentTimeLabel(fd: number, end: number, now: Date): string {
  const at = firstTimedRow(fd, end);
  return at ? timeLabel(at) : `${UNTIMED_SEGMENT_MARKER}-${timeLabel(now)}`;
}

/** The label a segment cut from the head of this ledger would carry, when its first rows name one. */
export function ledgerHeadLabel(fd: number, size: number): string | undefined {
  const at = firstTimedRow(fd, size);
  return at ? timeLabel(at) : undefined;
}

/** The live ledger's inode and head label, which identify a segment of it that never published. */
export interface LiveLedgerHead {
  ino: string;
  label: string | undefined;
}

/**
 * Which segments to count so every archived row is counted once.
 *
 * Segments of the same ledger file (inode) that start at the same row (label) are prefixes of one
 * another, so only the longest counts. A segment carrying the live ledger's inode and head label is a
 * trim that stopped before its rename: its rows are still in `usage.jsonl`, so it is not counted.
 */
export function countedArchiveSegments(
  segments: readonly ArchiveSegmentName[],
  live: LiveLedgerHead | null,
): { counted: ArchiveSegmentName[]; skipped: ArchiveSegmentName[] } {
  const longest = new Map<string, ArchiveSegmentName>();
  const skipped: ArchiveSegmentName[] = [];
  for (const segment of segments) {
    if (live && live.label !== undefined && segment.ino === live.ino && segment.label === live.label) {
      skipped.push(segment);
      continue;
    }
    const key = `${segment.ino}\0${segment.label}`;
    const current = longest.get(key);
    if (!current) longest.set(key, segment);
    else if (segment.bytes > current.bytes) {
      skipped.push(current);
      longest.set(key, segment);
    } else skipped.push(segment);
  }
  return { counted: [...longest.values()], skipped };
}
