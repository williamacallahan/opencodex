import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { handleManagementAPI } from "../../src/server/management-api";
import { loadWindowSegments, readArchiveListing } from "../../src/usage/archive-query";
import { inArchiveRowsReadQueue, readArchivedRows } from "../../src/usage/archive-rows";
import { resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { ARCHIVE_FIRST_ROW_AT, archiveRow, archiveRows, jsonl, writeArchiveTotals, writeSegment, type ArchiveFixtureRow } from "../helpers/usage-archive-rows";

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
  incomplete: boolean;
  coverage: {
    segments: Array<{ segment: string; fromByte: number; endedBy: string }>; pending: boolean; pendingSegments: string[];
    ambiguousSegments?: string[]; duplicateSegments?: number;
    failed: Array<{ segment: string; reason: string }>;
  };
  error?: { code: string };
}

async function managementGet<T>(path: string): Promise<{ status: number; body: T }> {
  const req = new ManagementRequest(`http://localhost${path}`, { method: "GET" });
  const response = await handleManagementAPI(req, new URL(req.url), config, {});
  if (!response) throw new Error(`no management route for ${path}`);
  return { status: response.status, body: await response.json() as T };
}

const rowsGet = (query: string) => managementGet<RowsBody>(`/api/usage/archive/rows?${query}`);
const window = (since: number, until: number): string => `since=${encodeURIComponent(iso(since))}&until=${encodeURIComponent(iso(until))}`;

async function builtSegment(ino: string, rows: readonly unknown[], label?: string): Promise<string> {
  const path = writeSegment(archiveDirectory(), ino, jsonl(rows), label);
  await writeArchiveTotals(path);
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

    // A window that ends well inside the segment still reads it to its end: a later offset proves nothing.
    const early = await rowsGet(window(day + HOUR, day + 2 * HOUR));
    expect(early.body.coverage.segments).toEqual([{ segment: expect.stringContaining(label), fromByte: 0, endedBy: "segment-end" }]);
    expect(early.body.endedBy).toBe("window-end");
  });

  test("a segment without totals is reported pending, never scanned from its start, and its refused build writes nothing", async () => {
    const path = writeSegment(archiveDirectory(), "611", jsonl(archiveRows(10)));
    const query = window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + HOUR);
    const { body } = await rowsGet(query);
    expect(body).toMatchObject({ entries: [], incomplete: true, coverage: { segments: [], pending: true, pendingSegments: [basename(path)] } });
    // The read asked for a build, which is refused while the archive trim is suspended.
    const again = await rowsGet(query);
    expect(again.body).toMatchObject({
      entries: [], incomplete: true,
      coverage: { pending: false, pendingSegments: [], failed: [{ segment: basename(path), reason: "publishing-suspended" }] },
    });
    // The refusal is remembered: a later read reports it again without asking for another build.
    const third = await rowsGet(query);
    expect(third.body.coverage.failed).toEqual(again.body.coverage.failed);
    expect(readdirSync(archiveDirectory())).toEqual([basename(path)]);
    await writeArchiveTotals(path);
    expect((await rowsGet(query)).body.entries).toHaveLength(9);
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

  test("a deadline that passes in the middle of a scan returns the rows read so far and says it stopped", async () => {
    // 3,000 rows a second apart; the scanner yields after its first thousand, when the deadline fires.
    await builtSegment("605", archiveRows(3_000, 1_000));
    const since = ARCHIVE_FIRST_ROW_AT;
    const until = ARCHIVE_FIRST_ROW_AT + HOUR;
    const states = await loadWindowSegments(await readArchiveListing(), since, until);
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(), 0);
    const result = await readArchivedRows(states, { since, until, filter: {}, limit: 5_000 }, deadline.signal, { chunkBytes: 4096 });
    expect(result.endedBy).toBe("deadline");
    expect(result.segments).toEqual([expect.objectContaining({ endedBy: "deadline" })]);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThan(3_000);
  });

  test("row reads run one at a time, and a caller that waits past its deadline is told the reader is busy", async () => {
    let finishFirst!: () => void;
    const first = inArchiveRowsReadQueue(1_000, () => new Promise<string>(resolve => { finishFirst = () => resolve("first"); }));
    const second = await inArchiveRowsReadQueue(20, async () => "second");
    expect(second).toEqual({ kind: "busy" });
    finishFirst();
    expect(await first).toEqual({ kind: "read", value: "first" });
    expect(await inArchiveRowsReadQueue(20, async () => "third")).toEqual({ kind: "read", value: "third" });
  });

  test("an abandoned read gives up its turn at once, and a read that throws gives it up too", async () => {
    const request = new AbortController();
    const first = inArchiveRowsReadQueue(5_000, () => new Promise<string>((_, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("abandoned")), { once: true });
    }), request.signal);
    const started = performance.now();
    const second = inArchiveRowsReadQueue(5_000, async () => "second");
    // Let the first read take its turn, then abandon it mid-read.
    await Bun.sleep(0);
    request.abort();
    await expect(first).rejects.toThrow("abandoned");
    expect(await second).toEqual({ kind: "read", value: "second" });
    expect(performance.now() - started).toBeLessThan(1_000);
    // A waiter whose own request is abandoned stops waiting without taking a turn.
    let finish!: () => void;
    const blocking = inArchiveRowsReadQueue(5_000, () => new Promise<void>(resolve => { finish = resolve; }));
    const leaving = new AbortController();
    const waiter = inArchiveRowsReadQueue(5_000, async () => "never", leaving.signal);
    leaving.abort();
    expect(await waiter).toEqual({ kind: "busy" });
    finish();
    await blocking;
    expect(await inArchiveRowsReadQueue(100, async () => "after")).toEqual({ kind: "read", value: "after" });
  });

  test("a pending segment in the window marks the answer incomplete", async () => {
    writeSegment(archiveDirectory(), "612", jsonl(archiveRows(10)));
    const { body } = await rowsGet(window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + HOUR));
    expect(body).toMatchObject({ endedBy: "window-end", truncated: false, incomplete: true, coverage: { pending: true } });
  });

  test("one row stamped far ahead and appended early does not end the read before the window's rows", async () => {
    const day = Date.UTC(2026, 10, 4);
    const rows: ArchiveFixtureRow[] = [{ ...archiveRow(0), requestId: "first", timestamp: day }];
    rows.push({ ...archiveRow(1), requestId: "stray", timestamp: day + 30 * HOUR });
    for (let minute = 1; minute < 120; minute += 10) rows.push({ ...archiveRow(rows.length), timestamp: day + minute * 60_000 });
    await builtSegment("613", rows, iso(day).replaceAll(":", "-"));
    const { body } = await rowsGet(window(day + HOUR, day + 2 * HOUR));
    const expected = rows.filter(row => row.timestamp >= day + HOUR && row.timestamp < day + 2 * HOUR);
    expect(expected.length).toBeGreaterThan(0);
    expect(body.entries.map(entry => entry.requestId)).toEqual(expected.map(row => row.requestId));
  });

  test("two copies of one ledger are reported and left unread, with the deprecated count beside them", async () => {
    const rows = archiveRows(4);
    await builtSegment("615", rows, "untimed-2026-11-02T00-00-00.000Z");
    await builtSegment("615", rows, "untimed-2026-11-03T00-00-00.000Z");
    const { body } = await rowsGet(window(ARCHIVE_FIRST_ROW_AT, ARCHIVE_FIRST_ROW_AT + HOUR));
    expect(body).toMatchObject({ entries: [], incomplete: true, coverage: { duplicateSegments: 2 } });
    expect(body.coverage.ambiguousSegments).toHaveLength(2);
  });

  test("an in-window row appended after rows hours later is still returned", async () => {
    // A long request is stamped when it starts and appended when it ends, after rows of later hours.
    const day = Date.UTC(2026, 10, 5);
    const rows: ArchiveFixtureRow[] = [
      { ...archiveRow(0), requestId: "in-window-early", timestamp: day + HOUR + 10 * 60_000 },
      ...Array.from({ length: 6 }, (_, index) => ({ ...archiveRow(index + 1), requestId: `later-${index}`, timestamp: day + (4 + index) * HOUR })),
      { ...archiveRow(7), requestId: "in-window-late", timestamp: day + HOUR + 20 * 60_000 },
    ];
    await builtSegment("614", rows, iso(day + HOUR).replaceAll(":", "-"));
    const { body } = await rowsGet(window(day + HOUR, day + 2 * HOUR));
    expect(body.entries.map(entry => entry.requestId)).toEqual(["in-window-early", "in-window-late"]);
    expect(body).toMatchObject({ endedBy: "window-end", incomplete: false });
  });

  test.each([
    ["since=2026-11-01T00:00:00Z&until=2026-11-01T06:00:01Z", "invalid_window"],
    ["since=2026-11-01T00:00:00Z", "invalid_window"],
    ["since=2026-11-01T00:00:00Z&until=2026-11-01T01:00:00Z&limit=0", "invalid_limit"],
    ["since=2026-11-01T00:00:00Z&until=2026-11-01T01:00:00Z&limit=101", "invalid_limit"],
    ["since=2026-11-01T00:00:00Z&until=2026-11-01T01:00:00Z&limit=ten", "invalid_limit"],
    ["since=2026-11-01T00:00:00Z&until=2026-11-01T01:00:00Z&prompt=x", "invalid_parameter"],
  ])("%s answers 400 %s", async (query, code) => {
    const { status, body } = await rowsGet(query);
    expect(status).toBe(400);
    expect(body.error?.code).toBe(code);
  });
});
