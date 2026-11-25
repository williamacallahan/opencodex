import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  archiveRows, bruteForce, hourOf, jsonl, writeSegment, type ArchiveFixtureRow,
} from "../helpers/usage-archive-rows";
import {
  ARCHIVE_TOTALS_FORMAT_VERSION, archiveTotalsPath, buildArchiveTotals, readArchiveTotals, scheduleArchiveTotalsBuild,
  type ArchiveTotalsFile,
} from "../../src/usage/archive-totals";
import { enforceUsageLedgerSizeLimit } from "../../src/usage/ledger-retention";
import { MIN_USAGE_LEDGER_MAX_BYTES, USAGE_ARCHIVE_RETENTION_DAYS } from "../../src/usage/retention-contract";
import { usageLogPath } from "../../src/usage/log";
import {
  scheduleArchiveTotalsStartupBuild, setUsageLedgerRetention, stopArchiveTotalsStartupBuild,
} from "../../src/server/usage-ledger-retention";

let home: string;
let previousHome: string | undefined;

const archiveDirectory = (): string => join(home, "usage-archive");
const segmentsIn = (directory: string): string[] => readdirSync(directory).filter(name => name.endsWith(".jsonl")).sort();

/** Rows padded to a fixed size, so 200 of them cross the 1 MiB minimum limit. */
function paddedRows(count: number): Array<ArchiveFixtureRow & { padding: string }> {
  return archiveRows(count).map(row => ({ ...row, padding: "x".repeat(8 * 1024) }));
}

function writeLedger(content: string): void {
  mkdirSync(dirname(usageLogPath()), { recursive: true });
  writeFileSync(usageLogPath(), content, { mode: 0o600 });
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = read();
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
  setUsageLedgerRetention(undefined);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("usage archive hourly totals", () => {
  test("a trim builds its segment's totals, and they equal a plain sum of the rows it archived", async () => {
    const rows = paddedRows(200);
    writeLedger(jsonl(rows));
    setUsageLedgerRetention(MIN_USAGE_LEDGER_MAX_BYTES);
    const segment = await waitFor(() => segmentsIn(archiveDirectory())[0]);
    const segmentPath = join(archiveDirectory(), segment);
    const totals = await waitFor(() => readArchiveTotals(segmentPath, statSync(segmentPath).size));
    const archived = readFileSync(segmentPath, "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as ArchiveFixtureRow);
    expect(archived.length).toBeGreaterThan(0);
    expect(archived.length).toBeLessThan(rows.length);

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

  test("a segment written before totals existed gets them from a lazy build", async () => {
    const rows = archiveRows(40);
    const path = writeSegment(archiveDirectory(), "4242", jsonl(rows));
    expect(existsSync(archiveTotalsPath(path))).toBe(false);
    await scheduleArchiveTotalsBuild(path);
    const totals = readArchiveTotals(path, statSync(path).size);
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

  test("segments without totals get them from one background pass after startup, not before it is due", async () => {
    const path = writeSegment(archiveDirectory(), "4246", jsonl(archiveRows(5)));
    scheduleArchiveTotalsStartupBuild(50);
    try {
      expect(existsSync(archiveTotalsPath(path))).toBe(false);
      const totals = await waitFor(() => readArchiveTotals(path, statSync(path).size));
      expect(totals.rows).toBe(5);
    } finally {
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

  test("totals of another format version, or of a different segment length, are not served", async () => {
    const path = writeSegment(archiveDirectory(), "4244", jsonl(archiveRows(3)));
    const built = await buildArchiveTotals(path);
    const size = statSync(path).size;
    expect(readArchiveTotals(path, size)).toEqual(built!);
    expect(readArchiveTotals(path, size + 1)).toBeUndefined();
    writeFileSync(archiveTotalsPath(path), JSON.stringify({ ...built, version: ARCHIVE_TOTALS_FORMAT_VERSION - 1 }));
    expect(readArchiveTotals(path, size)).toBeUndefined();
    await scheduleArchiveTotalsBuild(path);
    expect(readArchiveTotals(path, size)?.version).toBe(ARCHIVE_TOTALS_FORMAT_VERSION);
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

  test(`a trim's ${USAGE_ARCHIVE_RETENTION_DAYS}-day prune removes a totals file with its segment, and an orphan whose segment is gone`, () => {
    const expired = writeSegment(archiveDirectory(), "1111", jsonl(archiveRows(2)), "2026-09-01T00-00-00.000Z");
    const kept = writeSegment(archiveDirectory(), "2222", jsonl(archiveRows(2)), "2026-10-30T00-00-00.000Z");
    for (const path of [expired, kept]) writeFileSync(archiveTotalsPath(path), "{}");
    const orphan = join(archiveDirectory(), "2026-10-01T00-00-00.000Z_3333-10.hourly.json");
    writeFileSync(orphan, "{}");
    const old = (Date.now() - (USAGE_ARCHIVE_RETENTION_DAYS + 1) * 86_400_000) / 1000;
    utimesSync(expired, old, old);
    writeLedger(jsonl(paddedRows(200)));
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    const names = readdirSync(archiveDirectory());
    expect(names).not.toContain(expired.split("/").at(-1));
    expect(names).not.toContain(archiveTotalsPath(expired).split("/").at(-1));
    expect(names).not.toContain(orphan.split("/").at(-1));
    expect(names).toContain(kept.split("/").at(-1));
    expect(names).toContain(archiveTotalsPath(kept).split("/").at(-1));
  });

  test("a trim stays published when its totals build throws, and says so once", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeLedger(jsonl(paddedRows(200)));
      setUsageLedgerRetention(MIN_USAGE_LEDGER_MAX_BYTES, { onSegmentPublished: () => { throw new Error("totals unavailable"); } });
      const segment = await waitFor(() => segmentsIn(archiveDirectory())[0]);
      await waitFor(() => warn.mock.calls.length > 0 ? true : undefined);
      expect(statSync(usageLogPath()).size).toBeLessThanOrEqual(MIN_USAGE_LEDGER_MAX_BYTES);
      expect(existsSync(join(archiveDirectory(), segment))).toBe(true);
      expect(warn.mock.calls).toHaveLength(1);
      expect(String(warn.mock.calls[0]![0])).toContain("totals unavailable");
    } finally {
      warn.mockRestore();
    }
  });
});
