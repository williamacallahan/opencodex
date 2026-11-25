import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { archiveRow, archiveRows, jsonl, writeArchiveTotals, writeSegment } from "../helpers/usage-archive-rows";
import {
  ARCHIVE_TOTALS_FORMAT_VERSION, archiveTotalsBuildFailure, blankBucketSums, buildArchiveTotals,
  MAX_BUCKETS_PER_SEGMENT, MAX_HOURS_PER_SEGMENT, readArchiveTotals, type ArchiveTotalsFile,
} from "../../src/usage/archive-totals";
import { answerArchiveTotals } from "../../src/usage/archive-answer";
import { scheduleArchiveTotalsStartupBuild, stopArchiveTotalsStartupBuild } from "../../src/server/usage-ledger-retention";
import { OVERFLOW_KEY, RETAINED_KEYS } from "../../src/usage/attribution-breakdown";
import { normalizeUsageEntryForTest, type PersistedUsageEntry } from "../../src/usage/log";
import { computeEntryCost } from "../../src/usage/summary";

let home: string;
let previousHome: string | undefined;
const archiveDirectory = (): string => join(home, "usage-archive");

/** A built totals file for one hour: 50 single-row buckets, as a segment's loader would return it. */
function synthesizedTotals(hour: number): ArchiveTotalsFile {
  return {
    version: ARCHIVE_TOTALS_FORMAT_VERSION, segment: "synthesized", bytes: 1, rows: 50, unparsableRows: 0, firstRowAt: hour, lastRowAt: hour,
    buckets: Array.from({ length: 50 }, (_, index) => ({
      hour, provider: "alpha", model: `model-${index}`, account: "", harness: "", workloadLauncher: "", workloadSource: "", clientHost: "",
      clientAddress: "", ...blankBucketSums(), requests: 1, attemptCount: 1,
    })),
    overlaps: [], overlapRowsDropped: 0, hourOffsets: [{ hour, offset: 0 }],
    overflowRows: { provider: 0, model: 0, account: 0, harness: 0, workloadLauncher: 0, workloadSource: 0, clientHost: 0, clientAddress: 0 },
    foldedRows: 0,
  };
}

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
  test(`a segment spans at most ${MAX_HOURS_PER_SEGMENT} hours; a row that would open one more is unparsable`, async () => {
    const rows = archiveRows(MAX_HOURS_PER_SEGMENT + 1, 3_600_000);
    const totals = await buildArchiveTotals(writeSegment(archiveDirectory(), "708", jsonl(rows)));
    expect(totals!.hourOffsets).toHaveLength(MAX_HOURS_PER_SEGMENT);
    expect(totals).toMatchObject({ rows: MAX_HOURS_PER_SEGMENT, unparsableRows: 1 });
  });

  test("a wide window holds at most one segment's totals at a time", async () => {
    const hour = Date.UTC(2026, 10, 1);
    const listing = {
      segments: Array.from({ length: 30 }, (_, index) => ({
        name: `seg-${index}`, label: new Date(hour + index * 3_600_000).toISOString().replaceAll(":", "-"), ino: String(index), bytes: 1,
        path: join(archiveDirectory(), `seg-${index}.jsonl`), mtimeMs: hour + (index + 1) * 3_600_000, totalsMtimeMs: 1,
      })),
      skipped: [],
      liveLedgerSince: null,
    };
    const held: Array<WeakRef<object>> = [];
    let peak = 0;
    const load = async (entry: { ino: string }) => {
      // A fresh turn first, so no stack slot of the previous turn still points at its totals.
      await Bun.sleep(0);
      Bun.gc(true);
      peak = Math.max(peak, held.filter(ref => ref.deref() !== undefined).length + 1);
      const totals = synthesizedTotals(hour + Number(entry.ino) * 3_600_000);
      held.push(new WeakRef(totals));
      return totals;
    };
    const answer = await answerArchiveTotals(listing, hour, hour + 31 * 3_600_000, {}, { load });
    expect(answer.summary.requests).toBe(30 * 50);
    expect(peak).toBe(1);
  });

  test("the startup pass takes a few segments at a time, newest first, and re-arms until none remain", async () => {
    const paths = Array.from({ length: 5 }, (_, index) =>
      writeSegment(archiveDirectory(), String(720 + index), jsonl(archiveRows(2)), `2026-11-0${index + 1}T00-00-00.000Z`));
    // Each build is refused while publishing is suspended, which marks the segment as handled for the pass.
    scheduleArchiveTotalsStartupBuild(10, { segments: 2, intervalMs: 400 });
    try {
      const built = async (): Promise<string[]> => paths.filter(path => archiveTotalsBuildFailure(path) !== undefined);
      const deadline = Date.now() + 5_000;
      while ((await built()).length < 2 && Date.now() < deadline) await Bun.sleep(10);
      expect((await built()).sort()).toEqual(paths.slice(3).sort());
      while ((await built()).length < paths.length && Date.now() < deadline + 5_000) await Bun.sleep(25);
      expect(await built()).toHaveLength(paths.length);
    } finally {
      stopArchiveTotalsStartupBuild();
    }
  });

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
    const totals = await writeArchiveTotals(path);
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
});
