import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  archiveRows, bruteForce, hourOf, jsonl, writeArchiveTotals, writeSegment,
} from "../helpers/usage-archive-rows";
import {
  ARCHIVE_TOTALS_FORMAT_VERSION, ARCHIVE_TOTALS_LEGACY_VERSION, archiveTotalsBuildFailure, archiveTotalsPath, buildArchiveTotals, readArchiveTotals,
  uncountedCoverage,
  type ArchiveTotalsFile,
} from "../../src/usage/archive-totals";
import {
  scheduleArchiveTotalsStartupBuild, stopArchiveTotalsStartupBuild,
} from "../../src/server/usage-ledger-retention";

let home: string;
let previousHome: string | undefined;

const archiveDirectory = (): string => join(home, "usage-archive");

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(25);
  }
}

/** Sum the file's buckets by one projection, in the shape `bruteForce` produces. */
function totalsBy(totals: ArchiveTotalsFile, keyOf: (bucket: ArchiveTotalsFile["buckets"][number]) => string): ReturnType<typeof bruteForce> {
  const sums: ReturnType<typeof bruteForce> = new Map();
  for (const bucket of totals.buckets) {
    const key = keyOf(bucket);
    const current = sums.get(key) ?? { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0 };
    current.requests += bucket.requests;
    current.inputTokens += bucket.inputTokens;
    current.outputTokens += bucket.outputTokens;
    current.cacheReadInputTokens += bucket.cacheReadInputTokens;
    current.cacheCreationInputTokens += bucket.cacheCreationInputTokens;
    current.totalTokens += bucket.totalTokens;
    sums.set(key, current);
  }
  return sums;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-archive-totals-"));
  process.env.OPENCODEX_HOME = home;
  mkdirSync(archiveDirectory());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("usage archive hourly totals", () => {
  test("a segment's totals equal a plain sum of its rows in every dimension", async () => {
    const archived = archiveRows(200);
    const segmentPath = writeSegment(archiveDirectory(), "4240", jsonl(archived));
    const segment = basename(segmentPath);
    const totals = (await buildArchiveTotals(segmentPath))!;

    expect(totals).toMatchObject({
      version: ARCHIVE_TOTALS_FORMAT_VERSION, segment, bytes: statSync(segmentPath).size, rows: archived.length, unparsableRows: 0,
      firstRowAt: archived[0]!.timestamp, lastRowAt: archived.at(-1)!.timestamp,
    });
    const key = (parts: Array<string | number | undefined>): string => parts.map(part => part ?? "").join("|");
    expect(totalsBy(totals, bucket => key([new Date(bucket.hour).toISOString(), bucket.provider, bucket.model, bucket.harness,
      bucket.workloadLauncher, bucket.workloadSource, bucket.clientHost, bucket.clientAddress, bucket.account])))
      .toEqual(bruteForce(archived, row => key([hourOf(row.timestamp), row.provider, row.model, row.client,
        row.workload?.split(":")[0], row.workloadSource, row.clientHost, row.clientAddress, row.accountLogLabel])));
    // A row without attribution is stored under explicit empty values, not dropped.
    expect(totals.buckets.some(bucket => bucket.harness === "" && bucket.clientAddress === "" && bucket.account === "")).toBe(true);
    for (const bucket of totals.buckets) {
      expect(bucket.pricedRequests + bucket.unpricedRequests + bucket.unmeteredRequests).toBe(bucket.requests);
    }
  });

  test("a build sums a segment by provider and records where each hour's first row starts", async () => {
    const rows = archiveRows(40);
    const path = writeSegment(archiveDirectory(), "4242", jsonl(rows));
    const totals = await buildArchiveTotals(path);
    expect(totals?.rows).toBe(40);
    expect(totalsBy(totals!, bucket => bucket.provider)).toEqual(bruteForce(rows, row => row.provider));
    // Each hour's offset is where its first row starts in the file.
    const expectedOffsets: Array<{ hour: number; offset: number }> = [];
    let offset = 0;
    for (const row of rows) {
      const hour = Date.parse(hourOf(row.timestamp));
      if (!expectedOffsets.some(entry => entry.hour === hour)) expectedOffsets.push({ hour, offset });
      offset += Buffer.byteLength(`${JSON.stringify(row)}\n`);
    }
    expect(totals?.hourOffsets).toEqual(expectedOffsets);
  });

  test("the startup pass over segments without totals is refused and writes nothing into the archive", async () => {
    const path = writeSegment(archiveDirectory(), "4246", jsonl(archiveRows(5)));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    scheduleArchiveTotalsStartupBuild(200);
    try {
      // Nothing is asked for before the pass is due.
      await Bun.sleep(50);
      expect(archiveTotalsBuildFailure(path)).toBeUndefined();
      expect(await waitFor(() => archiveTotalsBuildFailure(path))).toEqual({ reason: "publishing-suspended" });
      expect(readdirSync(archiveDirectory())).toEqual([basename(path)]);
    } finally {
      warn.mockRestore();
      stopArchiveTotalsStartupBuild();
    }
  });

  test("a corrupt row and a torn final row are counted as unparsable and the rest is still summed", async () => {
    const rows = archiveRows(12);
    const content = `${jsonl(rows.slice(0, 5))}{"requestId": not json\n${jsonl(rows.slice(5))}{"requestId":"torn","provider":"alpha"`;
    const path = writeSegment(archiveDirectory(), "4243", content);
    const totals = await buildArchiveTotals(path);
    expect(totals).toMatchObject({ rows: 12, unparsableRows: 2 });
    expect(totalsBy(totals!, () => "all").get("all")).toEqual(bruteForce(rows, () => "all").get("all")!);
  });

  test("totals of an unknown format version, or of a different segment length, are not served", async () => {
    const path = writeSegment(archiveDirectory(), "4244", jsonl(archiveRows(3)));
    const built = await writeArchiveTotals(path);
    const size = statSync(path).size;
    expect(await readArchiveTotals(path, size)).toEqual(built!);
    expect(await readArchiveTotals(path, size + 1)).toBeUndefined();
    writeFileSync(archiveTotalsPath(path), JSON.stringify({ ...built, version: ARCHIVE_TOTALS_LEGACY_VERSION - 1 }));
    expect(await readArchiveTotals(path, size)).toBeUndefined();
    // A current-version file without its uncounted-row record is not one this build wrote.
    const { uncounted: _uncounted, ...withoutCoverage } = built!;
    writeFileSync(archiveTotalsPath(path), JSON.stringify(withoutCoverage));
    expect(await readArchiveTotals(path, size)).toBeUndefined();
  });

  test("a previous-version file is still served, but its unparsable rows may lie in any window", async () => {
    const path = writeSegment(archiveDirectory(), "4246", `${jsonl(archiveRows(3))}{"requestId": not json\n`);
    const built = await writeArchiveTotals(path);
    const { uncounted: _uncounted, oversizedRows: _oversized, ...legacy } = { ...built!, version: ARCHIVE_TOTALS_LEGACY_VERSION };
    writeFileSync(archiveTotalsPath(path), JSON.stringify(legacy));
    const read = await readArchiveTotals(path, statSync(path).size);
    expect(read?.version).toBe(ARCHIVE_TOTALS_LEGACY_VERSION);
    expect(uncountedCoverage(read!)).toBe("anywhere");
    // The current version records that row as malformed, whose time was never read: also anywhere.
    expect(uncountedCoverage(built!)).toBe("anywhere");
    expect(built).toMatchObject({ malformedRows: 1 });
    const clean = await buildArchiveTotals(writeSegment(archiveDirectory(), "4247", jsonl(archiveRows(3))));
    expect(uncountedCoverage(clean!)).toBe("exact");
    // A torn final row is an uncommitted write, not an excluded record.
    const torn = await buildArchiveTotals(writeSegment(archiveDirectory(), "4248", `${jsonl(archiveRows(3))}{"requestId":"torn"`));
    expect(torn).toMatchObject({ malformedRows: 0 });
    expect(uncountedCoverage(torn!)).toBe("exact");
  });

  test("the build yields to the event loop between chunks instead of reading the segment in one turn", async () => {
    const path = writeSegment(archiveDirectory(), "4245", jsonl(archiveRows(3_000, 1_000)));
    let timerRan = false;
    const build = buildArchiveTotals(path, { chunkBytes: 4096 });
    setTimeout(() => { timerRan = true; }, 0);
    const totals = await build;
    expect(timerRan).toBe(true);
    expect(totals?.rows).toBe(3_000);
  });
});
