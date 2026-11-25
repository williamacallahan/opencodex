import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { handleManagementAPI } from "../../src/server/management-api";
import { readArchiveListing } from "../../src/usage/archive-query";
import { readArchivedRows } from "../../src/usage/archive-rows";
import { resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { ARCHIVE_FIRST_ROW_AT, archiveRows, jsonl, writeSegment } from "../helpers/usage-archive-rows";

const config: OcxConfig = { port: 0, hostname: "127.0.0.1", defaultProvider: "test", providers: {} };
const HOUR = 3_600_000;
const iso = (at: number): string => new Date(at).toISOString();

let home: string;
let previousHome: string | undefined;
const archiveDirectory = (): string => join(home, "usage-archive");

interface RowsBody {
  entries: Array<Record<string, unknown> & { requestId: string }>;
  truncated: boolean;
  truncatedReason?: string;
  coverage: { segments: number };
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
    writeSegment(archiveDirectory(), "601", jsonl(rows.slice(0, 20)));
    writeSegment(archiveDirectory(), "602", jsonl(rows.slice(20)), iso(rows[20]!.timestamp).replaceAll(":", "-"));
    const since = rows[10]!.timestamp;
    const until = rows[30]!.timestamp;
    const { status, body } = await rowsGet(`${window(since, until)}&workload=batch-runner:job-7&harness=claude_code`);
    expect(status).toBe(200);
    const expected = rows.filter(row => row.timestamp >= since && row.timestamp < until
      && row.workload === "batch-runner:job-7" && row.client === "claude_code");
    expect(expected.length).toBeGreaterThan(1);
    expect(body.entries.map(entry => entry.requestId)).toEqual(expected.map(row => row.requestId));
    expect(body).toMatchObject({ truncated: false, coverage: { segments: 2 } });
  });

  test("an archived row exposes exactly the fields the live request-history row does", async () => {
    const [row] = archiveRows(1);
    writeSegment(archiveDirectory(), "603", jsonl([row]));
    const archived = await rowsGet(window(row!.timestamp, row!.timestamp + 1));
    mkdirSync(dirname(usageLogPath()), { recursive: true });
    writeFileSync(usageLogPath(), jsonl([row]));
    const live = await managementGet<{ entries: RowsBody["entries"] }>(`/api/request-history?from=${row!.timestamp}&to=${row!.timestamp}`);
    expect(live.body.entries).toHaveLength(1);
    expect(archived.body.entries).toEqual(live.body.entries);
  });

  test("a limit returns that many rows and says more matched", async () => {
    writeSegment(archiveDirectory(), "604", jsonl(archiveRows(30, 60_000)));
    const { body } = await rowsGet(`${window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + HOUR)}&limit=5`);
    expect(body.entries.map(entry => entry.requestId)).toEqual(["archive-0", "archive-1", "archive-2", "archive-3", "archive-4"]);
    expect(body).toMatchObject({ truncated: true, truncatedReason: "limit" });
  });

  test("a read past its deadline returns what it has and says it stopped", async () => {
    writeSegment(archiveDirectory(), "605", jsonl(archiveRows(30, 60_000)));
    const result = await readArchivedRows(readArchiveListing(), {
      since: ARCHIVE_FIRST_ROW_AT, until: ARCHIVE_FIRST_ROW_AT + HOUR, filter: {}, limit: 100,
    }, AbortSignal.abort());
    expect(result).toMatchObject({ rows: [], truncated: "deadline" });
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
