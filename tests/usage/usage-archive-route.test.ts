import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { archiveTotalsReads } from "../../src/usage/archive-query";
import { noteArchiveChanged } from "../../src/usage/archive-segments";
import { ARCHIVE_TOTALS_FORMAT_VERSION, archiveTotalsPath } from "../../src/usage/archive-totals";
import { usageLogPath } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  ARCHIVE_FIRST_ROW_AT, archiveRow, archiveRows, bruteForce, jsonl, writeArchiveTotals, writeSegment, type ArchiveFixtureRow,
} from "../helpers/usage-archive-rows";

const config: OcxConfig = { port: 0, hostname: "127.0.0.1", defaultProvider: "test", providers: {} };
const HOUR = 3_600_000;
const iso = (at: number): string => new Date(at).toISOString();

let home: string;
let previousHome: string | undefined;
const archiveDirectory = (): string => join(home, "usage-archive");

interface ArchiveSumsBody { requests: number; inputTokens: number; outputTokens: number; totalTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }
interface BreakdownBody { rows: Array<{ key: string } & ArchiveSumsBody>; truncated: number }
interface TotalsBody {
  since: string;
  until: string;
  attribution: string;
  coverage: {
    segments: number; pending: boolean; pendingSegments: string[]; failed: Array<{ segment: string; reason: string; code?: string }>;
    duplicateSegments: number; unparsableRows: number; earliestRowAt: string | null; latestRowAt: string | null; liveLedgerSince: string | null;
  };
  summary: ArchiveSumsBody;
  byHour: Array<{ key: string } & ArchiveSumsBody>;
  byProvider: BreakdownBody;
  byModel: BreakdownBody;
  byHarness: BreakdownBody;
  byClientHost: BreakdownBody;
  byAccount: BreakdownBody;
  error?: { code: string; message: string };
}

async function archiveGet(query: string): Promise<{ status: number; body: TotalsBody }> {
  const req = new ManagementRequest(`http://localhost/api/usage/archive?${query}`, { method: "GET" });
  const response = await handleManagementAPI(req, new URL(req.url), config, { refreshCodexCatalog: async () => {} });
  if (!response) throw new Error("no management route for /api/usage/archive");
  return { status: response.status, body: await response.json() as TotalsBody };
}

const window = (since: number, until: number, extra = ""): string =>
  `since=${encodeURIComponent(iso(since))}&until=${encodeURIComponent(iso(until))}${extra}`;

/** The plain-sum totals the route must report, without the per-bucket cost fields. */
function plainSummary(rows: readonly ArchiveFixtureRow[]): ArchiveSumsBody {
  return bruteForce(rows, () => "all").get("all") ?? { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0 };
}

/** Back-date a file's mtime, as an older trim's segment would have. */
function olderThanNow(path: string, ageMs: number): void {
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
  noteArchiveChanged();
}

async function builtSegment(ino: string, rows: readonly unknown[], label?: string): Promise<string> {
  const path = writeSegment(archiveDirectory(), ino, jsonl(rows), label);
  await writeArchiveTotals(path);
  return path;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-archive-route-"));
  process.env.OPENCODEX_HOME = home;
  mkdirSync(archiveDirectory());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("GET /api/usage/archive", () => {
  test("the window widens outward to whole UTC hours and the totals equal a plain sum of those hours' rows", async () => {
    const rows = archiveRows(60);
    await builtSegment("501", rows);
    const since = ARCHIVE_FIRST_ROW_AT + 75 * 60_000;
    const until = ARCHIVE_FIRST_ROW_AT + 3 * HOUR + 5 * 60_000;
    const { status, body } = await archiveGet(window(since, until));
    expect(status).toBe(200);
    const effectiveSince = Math.floor(since / HOUR) * HOUR;
    const effectiveUntil = Math.ceil(until / HOUR) * HOUR;
    expect(body).toMatchObject({ since: iso(effectiveSince), until: iso(effectiveUntil) });
    const inside = rows.filter(row => row.timestamp >= effectiveSince && row.timestamp < effectiveUntil);
    expect(body.summary).toMatchObject(plainSummary(inside));
    expect(body.coverage).toMatchObject({ segments: 1, pending: false, pendingSegments: [], duplicateSegments: 0, unparsableRows: 0, liveLedgerSince: null });
    expect(body.coverage.earliestRowAt).toBe(iso(rows[0]!.timestamp));
    expect(body.byHour.map(row => row.key)).toEqual([...new Set(inside.map(row => iso(Math.floor(row.timestamp / HOUR) * HOUR)))]);
  });

  test("filters match stored values exactly, and an empty value selects rows that lack the dimension", async () => {
    const rows = archiveRows(60);
    await builtSegment("502", rows);
    const all = window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + 12 * HOUR);
    const filtered = await archiveGet(`${all}&provider=alpha&harness=claude_code&account=main`);
    expect(filtered.body.summary).toMatchObject(plainSummary(rows.filter(row => row.provider === "alpha" && row.client === "claude_code" && row.accountLogLabel === "main")));
    expect(filtered.body.byProvider.rows.map(row => row.key)).toEqual(["alpha"]);
    const bare = await archiveGet(`${all}&harness=`);
    expect(bare.body.summary.requests).toBe(rows.filter(row => row.client === undefined).length);
    expect((await archiveGet(`${all}&workloadLauncher=batch-runner`)).body.summary.requests)
      .toBe(rows.filter(row => row.workload?.startsWith("batch-runner:")).length);
  });

  test.each([
    ["since=2026-11-01T00:00:00Z", "invalid_window"],
    ["since=2026-11-02T00:00:00Z&until=2026-11-01T00:00:00Z", "invalid_window"],
    ["since=2026-11-01T00:00:00Z&until=2026-11-01T00:00:00Z", "invalid_window"],
    ["since=2026-10-01T00:00:00Z&until=2026-11-02T00:00:01Z", "invalid_window"],
    ["since=yesterday&until=2026-11-01T00:00:00Z", "invalid_window"],
    ["since=2026-11-01T00:00:00Z&until=2026-11-02T00:00:00Z&harnes=pi", "invalid_parameter"],
    ["since=2026-11-01T00:00:00Z&until=2026-11-02T00:00:00Z&model=a&model=b", "invalid_parameter"],
  ])("%s answers 400 %s", async (query, code) => {
    const { status, body } = await archiveGet(query);
    expect(status).toBe(400);
    expect(body.error?.code).toBe(code);
  });

  test("a segment without current totals is reported pending, then failed with its refused build, and counted once totals exist", async () => {
    const rows = archiveRows(20);
    const path = writeSegment(archiveDirectory(), "503", jsonl(rows));
    const query = window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + 6 * HOUR);
    const first = await archiveGet(query);
    expect(first.body.coverage).toMatchObject({ segments: 1, pending: true, pendingSegments: [path.split("/").at(-1)] });
    // Coverage comes from the segment's name and mtime until its totals exist, and says so.
    expect(first.body.coverage).toMatchObject({ earliestRowAt: iso(ARCHIVE_FIRST_ROW_AT), approximate: true });
    expect(Date.parse(first.body.coverage.latestRowAt!)).toBeGreaterThanOrEqual(rows.at(-1)!.timestamp);
    expect(first.body.summary.requests).toBe(0);
    // The read queued a build, which is refused while the archive trim is suspended and writes nothing.
    const refused = await archiveGet(query);
    expect(refused.body.coverage).toMatchObject({
      pending: false, pendingSegments: [], failed: [{ segment: path.split("/").at(-1), reason: "publishing-suspended" }],
    });
    expect(readdirSync(archiveDirectory())).toEqual([path.split("/").at(-1)]);
    await writeArchiveTotals(path);
    const second = await archiveGet(query);
    expect(second.body.coverage.pending).toBe(false);
    expect(second.body.coverage).toMatchObject({ latestRowAt: iso(rows.at(-1)!.timestamp) });
    expect(second.body.coverage).not.toHaveProperty("approximate");
    expect(second.body.summary).toMatchObject(plainSummary(rows));

    // A totals file from an older format is never served; its rebuild stays refused.
    writeFileSync(archiveTotalsPath(path), JSON.stringify({ version: ARCHIVE_TOTALS_FORMAT_VERSION - 1, bytes: statSync(path).size }));
    noteArchiveChanged();
    const stale = await archiveGet(query);
    expect(stale.body.summary.requests).toBe(0);
    expect(stale.body.coverage.failed).toEqual([{ segment: path.split("/").at(-1)!, reason: "publishing-suspended" }]);
  });

  test("each breakdown keeps the 200 keys with the most requests and counts the rest", async () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({ ...archiveRow(index, 1_000), clientHost: `host-${index}` }));
    rows.push(...Array.from({ length: 5 }, (_, index) => ({ ...archiveRow(300 + index, 1_000), clientHost: "host-0" })));
    await builtSegment("504", rows);
    const { body } = await archiveGet(window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + HOUR));
    expect(body.byClientHost.rows).toHaveLength(200);
    expect(body.byClientHost.truncated).toBe(50);
    expect(body.byClientHost.rows[0]).toMatchObject({ key: "host-0", requests: 6 });
  });

  test("byHour is every hour with rows, oldest first, however many there are", async () => {
    const rows = archiveRows(300, HOUR);
    await builtSegment("506", rows);
    const { body } = await archiveGet(window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + 31 * 24 * HOUR));
    expect(body.byHour.map(row => row.key)).toEqual(rows.map(row => iso(Math.floor(row.timestamp / HOUR) * HOUR)));
    expect(body.byHour).not.toHaveProperty("truncated");
  });

  test("a leftover prefix of a segment and an unpublished trim of the live ledger are not counted again", async () => {
    const rows = archiveRows(30);
    await builtSegment("505", rows);
    // An earlier trim of the same ledger file that never published: same inode, same first row, shorter, older.
    olderThanNow(await builtSegment("505", rows.slice(0, 12)), 10 * 60_000);
    // A trim of the live ledger stopped before its rename: those rows are still in usage.jsonl.
    const live = archiveRows(10, undefined, 100);
    mkdirSync(dirname(usageLogPath()), { recursive: true });
    writeFileSync(usageLogPath(), jsonl(live));
    const liveIno = String(statSync(usageLogPath(), { bigint: true }).ino);
    const liveLabel = iso(live[0]!.timestamp).replaceAll(":", "-");
    await builtSegment(liveIno, live.slice(0, 4), liveLabel);

    const { body } = await archiveGet(window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + 24 * HOUR));
    expect(body.summary).toMatchObject(plainSummary(rows));
    expect(body.coverage).toMatchObject({ segments: 1, duplicateSegments: 2, liveLedgerSince: iso(live[0]!.timestamp) });
  });

  test("after a limit change, the newer shorter segment counts and an older longer leftover of the same file does not", async () => {
    // A trim was killed before its rename (long, older); the limit was raised; the next trim of the same
    // file cut less and published (short, newer). The leftover's extra rows are in the live ledger now.
    const rows = archiveRows(30);
    olderThanNow(await builtSegment("508", rows.slice(0, 20)), 10 * 60_000);
    await builtSegment("508", rows.slice(0, 8));
    mkdirSync(dirname(usageLogPath()), { recursive: true });
    writeFileSync(usageLogPath(), jsonl(rows.slice(8)));
    const { body } = await archiveGet(window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + 24 * HOUR));
    expect(body.summary).toMatchObject(plainSummary(rows.slice(0, 8)));
    expect(body.coverage).toMatchObject({ segments: 1, duplicateSegments: 1, liveLedgerSince: iso(rows[8]!.timestamp) });
  });

  test("only totals files of segments that may overlap the window are read", async () => {
    const early = await builtSegment("509", archiveRows(5), "2026-11-01T08-30-00.000Z");
    const late = archiveRows(5, undefined, 0).map(row => ({ ...row, timestamp: row.timestamp + 10 * 24 * HOUR }));
    await builtSegment("510", late, iso(late[0]!.timestamp).replaceAll(":", "-"));
    // The early segment was trimmed on Nov 2, so its rows cannot reach a window that starts on Nov 11.
    const trimmedAt = new Date(Date.UTC(2026, 10, 2));
    utimesSync(early, trimmedAt, trimmedAt);
    noteArchiveChanged();
    const before = archiveTotalsReads.count;
    const { body } = await archiveGet(window(late[0]!.timestamp, late[0]!.timestamp + 6 * HOUR));
    expect(archiveTotalsReads.count - before).toBe(1);
    expect(body.summary.requests).toBe(5);
  });

  test("a row stamped beyond what a Date holds is unparsable and never turns the answer into a 500", async () => {
    const rows = archiveRows(5);
    await builtSegment("512", [...rows, { ...archiveRow(6), timestamp: 1e17 }]);
    const { status, body } = await archiveGet(window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + 6 * HOUR));
    expect(status).toBe(200);
    expect(body.summary).toMatchObject(plainSummary(rows));
    expect(body.coverage.unparsableRows).toBe(1);
  });

  test("harness and clientAddress filters normalize like the live filters, and the answer names its attribution", async () => {
    const rows = archiveRows(30);
    await builtSegment("513", rows);
    const all = window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + 12 * HOUR);
    const { body } = await archiveGet(`${all}&clientAddress=${encodeURIComponent("::ffff:192.0.2.10")}&harness=${encodeURIComponent(" claude_code ")}`);
    expect(body.summary.requests).toBe(rows.filter(row => row.clientAddress === "192.0.2.10" && row.client === "claude_code").length);
    expect(body.summary.requests).toBeGreaterThan(0);
    expect(body.attribution).toBe("per-attempt");
  });

  test("a segment named after its first row still counts an earlier-stamped row appended after it", async () => {
    // The request stamped 13:59 completed after the 14:00:07 row, so the segment is named 14:00:07.
    const at = Date.UTC(2026, 10, 3, 14, 0, 7);
    const rows = [{ ...archiveRow(0), timestamp: at }, { ...archiveRow(1), timestamp: at - 68_000 }];
    const path = writeSegment(archiveDirectory(), "514", jsonl(rows), iso(at).replaceAll(":", "-"));
    const query = window(at - 2 * HOUR, Date.UTC(2026, 10, 3, 14));
    // Not built yet: the name less the append slack still reaches back into the window.
    expect((await archiveGet(query)).body.coverage).toMatchObject({ segments: 1, pending: true });
    await writeArchiveTotals(path);
    expect((await archiveGet(query)).body.summary.requests).toBe(1);
  });

  test("coverage reports the per-segment caps, so a caller knows a breakdown may fold keys", async () => {
    const rows = Array.from({ length: 1_010 }, (_, index) => ({ ...archiveRow(0, 0), requestId: `cap-${index}`, clientHost: `host-${index}` }));
    await builtSegment("515", rows);
    const { body } = await archiveGet(window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + HOUR));
    expect(body.coverage).toMatchObject({ capped: true, foldedRows: 0, overflowRows: { clientHost: 10 } });
    expect(body.summary.requests).toBe(1_010);
  });

  test("a breakdown with thousands of keys still returns its top 200 in order", async () => {
    const rows = Array.from({ length: 2_500 }, (_, index) => ({ ...archiveRow(0, 0), requestId: `many-${index}`, model: `model-${index % 900}` }));
    await builtSegment("517", rows);
    const { body } = await archiveGet(window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + HOUR));
    expect(body.byModel.rows).toHaveLength(200);
    expect(body.byModel.truncated).toBe(700);
    const counts = body.byModel.rows.map(row => row.requests);
    expect(counts).toEqual([...counts].sort((left, right) => right - left));
    expect(counts[0]).toBe(3);
  });

  test("the live head is read again after an archive write, so a reused inode never hides a published segment", async () => {
    // The ledger the trim cut keeps its inode in place here, as a filesystem reusing a retired inode would.
    mkdirSync(dirname(usageLogPath()), { recursive: true });
    const old = archiveRows(5);
    writeFileSync(usageLogPath(), jsonl(old));
    const ino = String(statSync(usageLogPath(), { bigint: true }).ino);
    const all = window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + 24 * HOUR);
    await builtSegment(ino, old, iso(old[0]!.timestamp).replaceAll(":", "-"));
    // While the ledger starts with those rows, the segment is an unpublished trim of it.
    expect((await archiveGet(all)).body.summary.requests).toBe(0);
    // The trim publishes: the new ledger, on the same inode, starts later; the segment now counts.
    writeFileSync(usageLogPath(), jsonl(archiveRows(2, undefined, 50)));
    noteArchiveChanged();
    expect((await archiveGet(all)).body.summary.requests).toBe(5);
  });
});
