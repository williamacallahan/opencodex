import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { ARCHIVE_TOTALS_FORMAT_VERSION, archiveTotalsPath, scheduleArchiveTotalsBuild } from "../../src/usage/archive-totals";
import { usageLogPath } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  ARCHIVE_FIRST_ROW_AT, archiveRow, archiveRows, bruteForce, jsonl, writeSegment, type ArchiveFixtureRow,
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
  coverage: { segments: number; pending: boolean; pendingSegments: string[]; duplicateSegments: number; unparsableRows: number; earliestRowAt: string | null; latestRowAt: string | null; liveLedgerSince: string | null };
  summary: ArchiveSumsBody;
  byHour: Array<{ key: string } & ArchiveSumsBody>;
  byProvider: BreakdownBody;
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

async function builtSegment(ino: string, rows: readonly unknown[], label?: string): Promise<string> {
  const path = writeSegment(archiveDirectory(), ino, jsonl(rows), label);
  await scheduleArchiveTotalsBuild(path);
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

  test("a segment without current totals is reported pending, built in the background, and counted once built", async () => {
    const rows = archiveRows(20);
    const path = writeSegment(archiveDirectory(), "503", jsonl(rows));
    const query = window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + 6 * HOUR);
    const first = await archiveGet(query);
    expect(first.body.coverage).toMatchObject({ segments: 1, pending: true, pendingSegments: [path.split("/").at(-1)] });
    // Coverage comes from the segment's name and mtime until its totals exist, and says so.
    expect(first.body.coverage).toMatchObject({ earliestRowAt: iso(ARCHIVE_FIRST_ROW_AT), approximate: true });
    expect(Date.parse(first.body.coverage.latestRowAt!)).toBeGreaterThanOrEqual(rows.at(-1)!.timestamp);
    expect(first.body.summary.requests).toBe(0);
    await scheduleArchiveTotalsBuild(path);
    const second = await archiveGet(query);
    expect(second.body.coverage.pending).toBe(false);
    expect(second.body.coverage).toMatchObject({ latestRowAt: iso(rows.at(-1)!.timestamp) });
    expect(second.body.coverage).not.toHaveProperty("approximate");
    expect(second.body.summary).toMatchObject(plainSummary(rows));

    // A totals file from an older format is pending again and rebuilt by the read.
    writeFileSync(archiveTotalsPath(path), JSON.stringify({ version: ARCHIVE_TOTALS_FORMAT_VERSION - 1, bytes: statSync(path).size }));
    expect((await archiveGet(query)).body.coverage.pending).toBe(true);
    await scheduleArchiveTotalsBuild(path);
    expect((await archiveGet(query)).body.summary).toMatchObject(plainSummary(rows));
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
    // An earlier trim of the same ledger file that never published: same inode, same first row, shorter.
    await builtSegment("505", rows.slice(0, 12));
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
});
