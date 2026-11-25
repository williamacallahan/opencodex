import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { archiveRow, archiveRows, jsonl, writeSegment } from "../helpers/usage-archive-rows";
import {
  archiveTotalsBuildFailure, buildArchiveTotals, BUILD_GAP_MS, buildArchiveTotalsInBackground, MAX_BUCKETS_PER_SEGMENT,
  readArchiveTotals, scheduleArchiveTotalsBuild,
} from "../../src/usage/archive-totals";
import { OVERFLOW_KEY, RETAINED_KEYS } from "../../src/usage/attribution-breakdown";
import { normalizeUsageEntryForTest, type PersistedUsageEntry } from "../../src/usage/log";
import { computeEntryCost } from "../../src/usage/summary";

let home: string;
let previousHome: string | undefined;
const archiveDirectory = (): string => join(home, "usage-archive");

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-archive-bounds-"));
  process.env.OPENCODEX_HOME = home;
  mkdirSync(archiveDirectory());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("usage archive totals bounds", () => {
  test("a priced row's estimatedCostUsd equals the live summary's cost for the same row", async () => {
    const rows = archiveRows(4).map(row => ({ ...row, provider: "anthropic", model: "claude-3-haiku-20240307" }));
    const totals = await buildArchiveTotals(writeSegment(archiveDirectory(), "701", jsonl(rows)));
    const expected = rows.reduce((sum, row) => sum + computeEntryCost(normalizeUsageEntryForTest(row as unknown as PersistedUsageEntry)).costTotal, 0);
    const actual = totals!.buckets.reduce((sum, bucket) => sum + bucket.estimatedCostUsd, 0);
    expect(expected).toBeGreaterThan(0);
    expect(actual).toBeCloseTo(expected, 12);
    expect(totals!.buckets.reduce((sum, bucket) => sum + bucket.pricedRequests, 0)).toBe(4);
  });

  test("an empty usage, an out-of-range timestamp, a fractional one, and an oversized row are unparsable, and the file is still served", async () => {
    const good = archiveRows(3);
    const content = jsonl([
      ...good,
      { ...archiveRow(10), usage: {} },
      { ...archiveRow(11), timestamp: 1e17 },
      { ...archiveRow(12), timestamp: good[0]!.timestamp + 0.5 },
      { ...archiveRow(13), padding: "x".repeat(1024 * 1024 + 10) },
    ]);
    const path = writeSegment(archiveDirectory(), "702", content);
    const totals = await buildArchiveTotals(path);
    expect(totals).toMatchObject({ rows: 3, unparsableRows: 4, lastRowAt: good.at(-1)!.timestamp });
    // No NaN reached the file, so the reader accepts it instead of rebuilding it forever.
    expect(await readArchiveTotals(path, statSync(path).size)).toEqual(totals!);
  });

  test(`each dimension keeps ${RETAINED_KEYS} distinct keys and counts the rest as ${OVERFLOW_KEY}`, async () => {
    const rows = Array.from({ length: RETAINED_KEYS + 100 }, (_, index) => ({ ...archiveRow(0, 0), requestId: `host-${index}`, clientHost: `host-${index}` }));
    const totals = await buildArchiveTotals(writeSegment(archiveDirectory(), "703", jsonl(rows)));
    expect(totals!.overflowRows.clientHost).toBe(100);
    expect(new Set(totals!.buckets.map(bucket => bucket.clientHost)).size).toBe(RETAINED_KEYS + 1);
    expect(totals!.buckets.find(bucket => bucket.clientHost === OVERFLOW_KEY)?.requests).toBe(100);
    expect(totals!.buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(rows.length);
  });

  test(`a segment keeps at most ${MAX_BUCKETS_PER_SEGMENT} buckets and folds further combinations into its hour's all-${OVERFLOW_KEY} bucket`, async () => {
    const extra = 300;
    const rows = Array.from({ length: MAX_BUCKETS_PER_SEGMENT + extra }, (_, index) => ({
      ...archiveRow(0, 0), requestId: `combo-${index}`, clientHost: `host-${index % 900}`, model: `model-${Math.floor(index / 900)}`,
    }));
    const totals = await buildArchiveTotals(writeSegment(archiveDirectory(), "704", jsonl(rows)));
    expect(totals!.buckets).toHaveLength(MAX_BUCKETS_PER_SEGMENT + 1);
    expect(totals!.foldedRows).toBe(extra);
    const folded = totals!.buckets.find(bucket => bucket.provider === OVERFLOW_KEY && bucket.clientHost === OVERFLOW_KEY);
    expect(folded?.requests).toBe(extra);
    expect(totals!.buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(rows.length);
  });

  test("queued builds run one at a time with an idle gap between them", async () => {
    const first = writeSegment(archiveDirectory(), "705", jsonl(archiveRows(5)));
    const second = writeSegment(archiveDirectory(), "706", jsonl(archiveRows(5)));
    const finished: number[] = [];
    await Promise.all([first, second].map(path => scheduleArchiveTotalsBuild(path).then(() => finished.push(performance.now()))));
    expect(finished[1]! - finished[0]!).toBeGreaterThanOrEqual(BUILD_GAP_MS - 5);
  });

  test("a build that fails is remembered with its reason and not queued again", async () => {
    // Root reads any file whatever its mode, and Windows does not map POSIX modes.
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const path = writeSegment(archiveDirectory(), "707", jsonl(archiveRows(5)));
    chmodSync(path, 0o000);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await scheduleArchiveTotalsBuild(path).catch(() => undefined);
      expect(archiveTotalsBuildFailure(path)).toEqual({ reason: "io-error", code: "EACCES" });
      chmodSync(path, 0o600);
      buildArchiveTotalsInBackground(path);
      await Bun.sleep(BUILD_GAP_MS * 2);
      expect(await readArchiveTotals(path, statSync(path).size)).toBeUndefined();
    } finally {
      warn.mockRestore();
      chmodSync(path, 0o600);
    }
  });
});
