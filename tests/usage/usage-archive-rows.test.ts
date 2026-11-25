import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { handleManagementAPI } from "../../src/server/management-api";
import { readArchiveListing } from "../../src/usage/archive-query";
import { readArchivedRows } from "../../src/usage/archive-rows";
import { readArchiveTotals, scheduleArchiveTotalsBuild } from "../../src/usage/archive-totals";
import { resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { ARCHIVE_FIRST_ROW_AT, archiveRow, archiveRows, jsonl, writeSegment, type ArchiveFixtureRow } from "../helpers/usage-archive-rows";

const config: OcxConfig = { port: 0, hostname: "127.0.0.1", defaultProvider: "test", providers: {} };
const HOUR = 3_600_000;
const iso = (at: number): string => new Date(at).toISOString();

let home: string;
let previousHome: string | undefined;
const archiveDirectory = (): string => join(home, "usage-archive");

interface RowsBody {
  entries: Array<Record<string, unknown> & { requestId: string }>;
  endedBy: string;
  truncated: boolean;
  coverage: { segments: Array<{ segment: string; fromByte: number; endedBy: string }>; pending: boolean; pendingSegments: string[] };
  error?: { code: string };
}

async function managementGet<T>(path: string): Promise<{ status: number; body: T }> {
  const req = new ManagementRequest(`http://localhost${path}`, { method: "GET" });
  const response = await handleManagementAPI(req, new URL(req.url), config, { refreshCodexCatalog: async () => {} });
  if (!response) throw new Error(`no management route for ${path}`);
  return { status: response.status, body: await response.json() as T };
}

const rowsGet = (query: string) => managementGet<RowsBody>(`/api/usage/archive/rows?${query}`);
const window = (since: number, until: number): string => `since=${encodeURIComponent(iso(since))}&until=${encodeURIComponent(iso(until))}`;

async function builtSegment(ino: string, rows: readonly unknown[], label?: string): Promise<string> {
  const path = writeSegment(archiveDirectory(), ino, jsonl(rows), label);
  await scheduleArchiveTotalsBuild(path);
  return path;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-archive-rows-"));
  process.env.OPENCODEX_HOME = home;
  mkdirSync(archiveDirectory());
  resetUsageReadCacheForTests();
});

afterEach(() => {
  closeRequestHistoryIndex();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("GET /api/usage/archive/rows", () => {
  test("returns the window's matching rows, oldest first, from every segment in it", async () => {
    const rows = archiveRows(40);
    await builtSegment("601", rows.slice(0, 20));
    await builtSegment("602", rows.slice(20), iso(rows[20]!.timestamp).replaceAll(":", "-"));
    const since = rows[10]!.timestamp;
    const until = rows[30]!.timestamp;
    const { status, body } = await rowsGet(`${window(since, until)}&workload=batch-runner:job-7&harness=claude_code`);
    expect(status).toBe(200);
    const expected = rows.filter(row => row.timestamp >= since && row.timestamp < until
      && row.workload === "batch-runner:job-7" && row.client === "claude_code");
    expect(expected.length).toBeGreaterThan(1);
    expect(body.entries.map(entry => entry.requestId)).toEqual(expected.map(row => row.requestId));
    expect(body).toMatchObject({ endedBy: "window-end", truncated: false, coverage: { pending: false } });
    expect(body.coverage.segments).toHaveLength(2);
  });

  test("the read seeks to the hour before since, finds a row logged out of order there, and returns only the window's rows", async () => {
    // Hours 00 through 05, ten rows each; one hour-04 row was appended among the hour-03 rows.
    const day = Date.UTC(2026, 10, 3);
    const rows: ArchiveFixtureRow[] = [];
    for (let hour = 0; hour < 6; hour++) {
      for (let minute = 0; minute < 60; minute += 6) rows.push({ ...archiveRow(rows.length), timestamp: day + hour * HOUR + minute * 60_000 });
    }
    const late = { ...archiveRow(999), requestId: "late-hour-4", timestamp: day + 4 * HOUR + 30_000 };
    rows.splice(35, 0, late);
    const label = iso(day).replaceAll(":", "-");
    await builtSegment("610", rows, label);
    const content = jsonl(rows);
    const hour3Offset = Buffer.byteLength(content.slice(0, content.indexOf(JSON.stringify(rows.find(row => row.timestamp >= day + 3 * HOUR)))));

    const { body } = await rowsGet(window(day + 4 * HOUR, day + 5 * HOUR));
    expect(body.coverage.segments).toEqual([{ segment: expect.stringContaining(label), fromByte: hour3Offset, endedBy: "segment-end" }]);
    const expected = rows.filter(row => row.timestamp >= day + 4 * HOUR && row.timestamp < day + 5 * HOUR);
    expect(body.entries.map(entry => entry.requestId)).toEqual(expected.map(row => row.requestId));
    expect(body.entries.map(entry => entry.requestId)).toContain("late-hour-4");

    // A window that ends well inside the segment stops an hour past its end instead of reading on.
    const early = await rowsGet(window(day + HOUR, day + 2 * HOUR));
    expect(early.body.coverage.segments).toEqual([{ segment: expect.stringContaining(label), fromByte: 0, endedBy: "window-end" }]);
    expect(early.body.endedBy).toBe("window-end");
  });

  test("a segment without totals is reported pending and queued for a build, never scanned from its start", async () => {
    const path = writeSegment(archiveDirectory(), "611", jsonl(archiveRows(10)));
    const { body } = await rowsGet(window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + HOUR));
    expect(body).toMatchObject({ entries: [], coverage: { segments: [], pending: true, pendingSegments: [path.split("/").at(-1)] } });
    // The request queued the build itself; nothing here starts one.
    const deadline = Date.now() + 5_000;
    while (!readArchiveTotals(path, statSync(path).size) && Date.now() < deadline) await Bun.sleep(20);
    expect((await rowsGet(window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + HOUR))).body.entries).toHaveLength(9);
  });

  test("an archived row exposes exactly the fields the live request-history row does", async () => {
    const [row] = archiveRows(1);
    await builtSegment("603", [row]);
    const archived = await rowsGet(window(row!.timestamp, row!.timestamp + 1));
    mkdirSync(dirname(usageLogPath()), { recursive: true });
    writeFileSync(usageLogPath(), jsonl([row]));
    const live = await managementGet<{ entries: RowsBody["entries"] }>(`/api/request-history?from=${row!.timestamp}&to=${row!.timestamp}`);
    expect(live.body.entries).toHaveLength(1);
    expect(archived.body.entries).toEqual(live.body.entries);
  });

  test("a limit returns that many rows and says more matched", async () => {
    await builtSegment("604", archiveRows(30, 60_000));
    const { body } = await rowsGet(`${window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + HOUR)}&limit=5`);
    expect(body.entries.map(entry => entry.requestId)).toEqual(["archive-0", "archive-1", "archive-2", "archive-3", "archive-4"]);
    expect(body).toMatchObject({ endedBy: "limit", truncated: true });
  });

  test("a read past its deadline returns what it has and says it stopped", async () => {
    await builtSegment("605", archiveRows(30, 60_000));
    const result = await readArchivedRows(readArchiveListing(), {
      since: ARCHIVE_FIRST_ROW_AT, until: ARCHIVE_FIRST_ROW_AT + HOUR, filter: {}, limit: 100,
    }, AbortSignal.abort());
    expect(result).toMatchObject({ rows: [], endedBy: "deadline" });
  });

  test.each([
    ["since=2026-11-01T00:00:00Z&until=2026-11-01T06:00:01Z", "invalid_window"],
    ["since=2026-11-01T00:00:00Z", "invalid_window"],
    ["since=2026-11-01T00:00:00Z&until=2026-11-01T01:00:00Z&limit=0", "invalid_limit"],
    ["since=2026-11-01T00:00:00Z&until=2026-11-01T01:00:00Z&limit=501", "invalid_limit"],
    ["since=2026-11-01T00:00:00Z&until=2026-11-01T01:00:00Z&limit=ten", "invalid_limit"],
    ["since=2026-11-01T00:00:00Z&until=2026-11-01T01:00:00Z&prompt=x", "invalid_parameter"],
  ])("%s answers 400 %s", async (query, code) => {
    const { status, body } = await rowsGet(query);
    expect(status).toBe(400);
    expect(body.error?.code).toBe(code);
  });
});
