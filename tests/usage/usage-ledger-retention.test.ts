import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { enforceUsageLedgerSizeLimit } from "../../src/usage/ledger-retention";
import {
  MIN_USAGE_LEDGER_MAX_BYTES,
  USAGE_ARCHIVE_RETENTION_DAYS,
  USAGE_LEDGER_RETENTION_TARGET_RATIO,
} from "../../src/usage/retention-contract";
import { appendUsageEntry, usageLogPath } from "../../src/usage/log";
import { setUsageLedgerRetention } from "../../src/server/usage-ledger-retention";
import { clearRequestLogsForTests, getRequestLogEntries, hydrateRequestLogsFromDisk } from "../../src/server/request-log";
import { CONFIG_UNINSTALL_MANIFEST, initializeConfigOwnership } from "../../src/lib/config-ownership";

let home: string;
let previousHome: string | undefined;

/** Rows start at this instant and advance one second each, like a ledger appended in order. */
const FIRST_ROW_AT = Date.UTC(2026, 10, 1, 8, 30, 15, 250);

function archiveDirectory(): string {
  return join(home, "usage-archive");
}

function archiveFiles(): string[] {
  return readdirSync(archiveDirectory()).sort();
}

/** Rows of a known size, each carrying a field no normalizer in this build knows about. */
function writeRows(count: number, padding: number, extra: Record<string, unknown> = {}): string[] {
  const path = usageLogPath();
  mkdirSync(dirname(path), { recursive: true });
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
    requestId: `req-${index}`,
    timestamp: FIRST_ROW_AT + index * 1000,
    aFieldThisBuildDoesNotKnow: "x".repeat(padding),
    ...extra,
  }));
  writeFileSync(path, lines.map(line => `${line}\n`).join(""), { encoding: "utf-8", mode: 0o600 });
  return lines;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-ledger-retention-"));
  process.env.OPENCODEX_HOME = home;
  mkdirSync(archiveDirectory());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("usage ledger retention", () => {
  test("the append that crosses the limit returns before the compaction, which runs once on its own turn", async () => {
    writeRows(200, 16 * 1024);
    setUsageLedgerRetention(MIN_USAGE_LEDGER_MAX_BYTES);
    try {
      appendUsageEntry({ requestId: "crossing", timestamp: 1, provider: "a", model: "m", status: 200, durationMs: 1 });
      appendUsageEntry({ requestId: "next", timestamp: 2, provider: "a", model: "m", status: 200, durationMs: 1 });
      expect(statSync(usageLogPath()).size).toBeGreaterThan(MIN_USAGE_LEDGER_MAX_BYTES);
      const deadline = Date.now() + 5_000;
      while (statSync(usageLogPath()).size > MIN_USAGE_LEDGER_MAX_BYTES && Date.now() < deadline) await Bun.sleep(50);
      expect(statSync(usageLogPath()).size).toBeLessThanOrEqual(MIN_USAGE_LEDGER_MAX_BYTES);
      expect(readFileSync(usageLogPath(), "utf-8")).toContain('"requestId":"next"');
    } finally {
      setUsageLedgerRetention(undefined);
    }
  });

  test("installing a limit over an already-oversized ledger compacts it without waiting for an append", async () => {
    writeRows(200, 16 * 1024);
    expect(statSync(usageLogPath()).size).toBeGreaterThan(MIN_USAGE_LEDGER_MAX_BYTES);
    setUsageLedgerRetention(MIN_USAGE_LEDGER_MAX_BYTES);
    try {
      const deadline = Date.now() + 5_000;
      while (statSync(usageLogPath()).size > MIN_USAGE_LEDGER_MAX_BYTES && Date.now() < deadline) await Bun.sleep(50);
      expect(statSync(usageLogPath()).size).toBeLessThanOrEqual(
        Math.floor(MIN_USAGE_LEDGER_MAX_BYTES * USAGE_LEDGER_RETENTION_TARGET_RATIO),
      );
      expect(readFileSync(usageLogPath(), "utf-8")).toContain('"requestId":"req-199"');
    } finally {
      setUsageLedgerRetention(undefined);
    }
  });

  test("no limit, a limit below the floor, and a ledger under the limit leave the file alone", () => {
    writeRows(20, 64);
    const before = readFileSync(usageLogPath(), "utf-8");
    expect(enforceUsageLedgerSizeLimit(undefined).kind).toBe("disabled");
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES - 1).kind).toBe("disabled");
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("unchanged");
    expect(readFileSync(usageLogPath(), "utf-8")).toBe(before);
  });

  test("it keeps the newest whole rows, byte for byte, including fields it does not understand", () => {
    const lines = writeRows(200, 16 * 1024);
    const originalBytes = statSync(usageLogPath()).size;
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");

    const after = readFileSync(usageLogPath(), "utf-8");
    const retained = after.split("\n").filter(line => line !== "");
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(lines.length);
    // Identical to the tail they came from: rows are copied, never parsed and rewritten, which
    // is what keeps a field this build has never heard of intact through a compaction.
    expect(retained).toEqual(lines.slice(lines.length - retained.length));
    expect(after).toContain("aFieldThisBuildDoesNotKnow");
    expect(after.endsWith("\n")).toBe(true);
    const size = statSync(usageLogPath()).size;
    expect(size).toBeLessThan(originalBytes);
    expect(size).toBeLessThanOrEqual(
      Math.floor(MIN_USAGE_LEDGER_MAX_BYTES * USAGE_LEDGER_RETENTION_TARGET_RATIO),
    );
  });

  test("an unterminated final row is carried as-is and never promoted", () => {
    writeRows(200, 16 * 1024);
    const torn = JSON.stringify({ requestId: "torn" }).slice(0, 12);
    appendFileSync(usageLogPath(), torn);
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    const lines = readFileSync(usageLogPath(), "utf-8").split("\n");
    // No LF was invented to make it committed: the scanner's definition is unchanged here.
    expect(lines.at(-1)).toBe(torn);
    for (const line of lines.slice(0, -1)) {
      if (line !== "") expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  test("one row larger than the whole target defers instead of emptying the ledger", () => {
    writeRows(1, MIN_USAGE_LEDGER_MAX_BYTES * 2);
    const before = readFileSync(usageLogPath(), "utf-8");
    const result = enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES);
    expect(result.kind).toBe("deferred");
    expect(result).toMatchObject({ reason: "no-boundary" });
    expect(readFileSync(usageLogPath(), "utf-8")).toBe(before);
  });

  test("a row appended while the retained span is copied aborts the replacement", () => {
    const lines = writeRows(200, 16 * 1024);
    const raced = JSON.stringify({ requestId: "appended-during-copy" });
    const result = enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES, {
      onSpanCopied: () => appendFileSync(usageLogPath(), `${raced}\n`),
    });

    // This is the defect the revision contract exists to close. #5063 captured a size, copied a
    // suffix and renamed over whatever was there, so this row was silently lost.
    expect(result.kind).toBe("deferred");
    expect(result).toMatchObject({ reason: "revision-changed" });
    const after = readFileSync(usageLogPath(), "utf-8");
    expect(after).toContain("appended-during-copy");
    // Nothing was trimmed either: the original file is exactly as it was, plus the new row.
    expect(after.split("\n").filter(line => line !== "").length).toBe(lines.length + 1);
  });

  test("a replacement after copying is preserved with the source handle already closed", () => {
    writeRows(200, 16 * 1024);
    const path = usageLogPath();
    const before = readFileSync(path, "utf8");
    const result = enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES, {
      onSpanCopied: () => {
        // Also exercises Windows, where our own open reader would deny this rename.
        renameSync(path, `${path}.previous`);
        writeFileSync(path, before);
      },
    });
    expect(result).toMatchObject({ kind: "deferred", reason: "revision-changed" });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("the published file keeps owner-only permissions", () => {
    if (process.platform === "win32") return;
    writeRows(200, 16 * 1024);
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    expect(statSync(usageLogPath()).mode & 0o777).toBe(0o600);
  });
});

describe("usage ledger archive", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  test("the trimmed rows land in one segment that, followed by the new ledger, is the old ledger byte for byte", () => {
    writeRows(200, 16 * 1024);
    const before = readFileSync(usageLogPath());
    const ino = statSync(usageLogPath(), { bigint: true }).ino.toString();
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");

    const [segment, ...others] = archiveFiles();
    expect(others).toEqual([]);
    const archived = readFileSync(join(archiveDirectory(), segment!));
    expect(segment).toBe(`2026-11-01T08-30-15.250Z_${ino}-${archived.byteLength}.jsonl`);
    expect(Buffer.concat([archived, readFileSync(usageLogPath())]).equals(before)).toBe(true);
  });

  test("rows that cannot name the segment never stop a trim: the first timed row in the cut span names it, else the trim time does", () => {
    const lines = writeRows(200, 16 * 1024);
    const path = usageLogPath();
    writeFileSync(path, ["not json", JSON.stringify({ requestId: "no-time" }), ...lines.slice(2)].map(line => `${line}\n`).join(""));
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    expect(archiveFiles()[0]).toStartWith(`${new Date(FIRST_ROW_AT + 2000).toISOString().replaceAll(":", "-")}_`);

    rmSync(archiveDirectory(), { recursive: true });
    mkdirSync(archiveDirectory());
    writeFileSync(path, Array.from({ length: 200 }, (_, index) => `{"untimed":${index},"pad":"${"x".repeat(16 * 1024)}"}\n`).join(""));
    const trimmedAt = Date.now();
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    const [segment] = archiveFiles();
    expect(segment).toMatch(/^untimed-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_/);
    expect(Date.parse(segment!.slice("untimed-".length, segment!.indexOf("_")).replace(/T(\d{2})-(\d{2})-/, "T$1:$2:"))).toBeGreaterThanOrEqual(trimmedAt - 1000);
  });

  test("a segment left by a trim that stopped before its rename is replaced, so one segment covers the cut span", () => {
    writeRows(200, 16 * 1024);
    const before = readFileSync(usageLogPath());
    const ino = statSync(usageLogPath(), { bigint: true }).ino.toString();
    const archived = (name: string, bytes: Buffer | string, ageMs: number) => {
      const target = join(archiveDirectory(), name);
      writeFileSync(target, bytes);
      const at = new Date(Date.now() - ageMs);
      utimesSync(target, at, at);
      return name;
    };
    // The crash: an earlier trim archived the head of THIS ledger file, over 1 MiB of it, and never published.
    const headEnd = before.indexOf(0x0a, 70 * 16 * 1024) + 1;
    const leftover = archived(`2026-11-01T08-30-15.250Z_${ino}-${headEnd}.jsonl`, before.subarray(0, headEnd), 10 * 60_000);
    // The same length differing only past the first MiB is not this ledger's prefix.
    const altered = Buffer.from(before.subarray(0, headEnd));
    altered[headEnd - 3] = 0x79;
    const notPrefix = archived(`2026-10-02T00-00-00.000Z_${ino}-${headEnd}.jsonl`, altered, 10 * 60_000);
    // A prefix written a moment ago survives the check before the trim, but this trim's publish supersedes it.
    const young = archived(`2026-10-03T00-00-00.000Z_${ino}-${headEnd}.jsonl`, before.subarray(0, headEnd), 0);
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    const files = archiveFiles();
    expect(files).not.toContain(leftover);
    expect(files).toContain(notPrefix);
    expect(files).not.toContain(young);
    const covering = files.filter(name => name.startsWith("2026-11-01"));
    expect(covering).toHaveLength(1);
    expect(Buffer.concat([readFileSync(join(archiveDirectory(), covering[0]!)), readFileSync(usageLogPath())]).equals(before)).toBe(true);
  });

  test("a leftover too young to delete before the trim is dropped once the trim publishes, so each row is archived once", () => {
    writeRows(200, 16 * 1024);
    const ino = statSync(usageLogPath(), { bigint: true }).ino.toString();
    // A trim was killed after its segment and before its rename; the restarted hub appends within five minutes.
    const head = readFileSync(usageLogPath());
    const leftover = head.subarray(0, head.indexOf(0x0a) + 1);
    writeFileSync(join(archiveDirectory(), `2026-11-01T08-30-15.250Z_${ino}-${leftover.byteLength}.jsonl`), leftover);
    appendFileSync(usageLogPath(), `${JSON.stringify({ requestId: "after-restart", timestamp: FIRST_ROW_AT + 500_000 })}\n`);
    const before = readFileSync(usageLogPath());
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    const [segment, ...others] = archiveFiles();
    expect(others).toEqual([]);
    const archived = readFileSync(join(archiveDirectory(), segment!));
    expect(Buffer.concat([archived, readFileSync(usageLogPath())]).equals(before)).toBe(true);
    const rows = Buffer.concat([archived, readFileSync(usageLogPath())]).toString("utf8").trim().split("\n")
      .map(line => (JSON.parse(line) as { requestId: string }).requestId);
    expect(new Set(rows).size).toBe(rows.length);
  });

  /** A young leftover of an earlier trim of this ledger: a prefix of it, which the cleanup after a publish tries to delete. */
  function writeUnreadableLeftover(): string {
    const ino = statSync(usageLogPath(), { bigint: true }).ino.toString();
    const head = readFileSync(usageLogPath());
    const leftover = head.subarray(0, head.indexOf(0x0a) + 1);
    const path = join(archiveDirectory(), `2026-11-01T08-30-15.250Z_${ino}-${leftover.byteLength}.jsonl`);
    writeFileSync(path, leftover);
    chmodSync(path, 0o000);
    return path;
  }

  /** Root reads any file whatever its mode, and Windows does not map POSIX modes, so an unreadable file is not real there. */
  const unreadableFilesUnsupported = (): boolean => process.platform === "win32" || process.getuid?.() === 0;

  test("a leftover the cleanup cannot read leaves the published trim published, and says which file and why", () => {
    if (unreadableFilesUnsupported()) return;
    writeRows(200, 16 * 1024);
    const leftover = writeUnreadableLeftover();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
      expect(statSync(usageLogPath()).size).toBeLessThanOrEqual(MIN_USAGE_LEDGER_MAX_BYTES);
      const [message] = warn.mock.calls.map(call => String(call[0])).filter(text => text.includes("superseded archive segment"));
      expect(message).toContain(leftover);
      expect(message).toContain("EACCES");
      expect(message).not.toContain("req-");
    } finally {
      warn.mockRestore();
      chmodSync(leftover, 0o600);
    }
  });

  test("the Logs ring is rebuilt from the trimmed ledger even when the superseded-segment cleanup throws", async () => {
    if (unreadableFilesUnsupported()) return;
    writeRows(200, 16 * 1024, { provider: "example", model: "m", status: 200, durationMs: 1 });
    clearRequestLogsForTests();
    hydrateRequestLogsFromDisk();
    expect(getRequestLogEntries().some(row => row.requestId === "req-0")).toBe(true);
    const leftover = writeUnreadableLeftover();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      setUsageLedgerRetention(MIN_USAGE_LEDGER_MAX_BYTES);
      const deadline = Date.now() + 5_000;
      while (statSync(usageLogPath()).size > MIN_USAGE_LEDGER_MAX_BYTES && Date.now() < deadline) await Bun.sleep(50);
      await Bun.sleep(100);
      expect(getRequestLogEntries().some(row => row.requestId === "req-0")).toBe(false);
      expect(getRequestLogEntries().some(row => row.requestId === "req-199")).toBe(true);
      expect(warn.mock.calls.some(call => String(call[0]).includes("could not enforce"))).toBe(false);
    } finally {
      setUsageLedgerRetention(undefined);
      warn.mockRestore();
      chmodSync(leftover, 0o600);
    }
  });

  test("another writer's in-flight temp file is never treated as a leftover segment", () => {
    writeRows(200, 16 * 1024);
    const ino = statSync(usageLogPath(), { bigint: true }).ino.toString();
    const head = readFileSync(usageLogPath());
    const inFlight = join(archiveDirectory(), `2026-11-01T08-30-15.250Z_${ino}-1.jsonl.ocx.4242.1.tmp`);
    writeFileSync(inFlight, head.subarray(0, head.indexOf(0x0a) + 1));
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    expect(readdirSync(archiveDirectory())).toContain(inFlight.slice(archiveDirectory().length + 1));
  });

  test("a crashed writer's temp copy of a leftover older than five minutes is deleted by the next trim", () => {
    writeRows(200, 16 * 1024);
    const ino = statSync(usageLogPath(), { bigint: true }).ino.toString();
    const head = readFileSync(usageLogPath());
    const prefix = head.subarray(0, head.indexOf(0x0a) + 1);
    const crashed = `2026-11-01T08-30-15.250Z_${ino}-${prefix.byteLength}.jsonl.ocx.4242.1.tmp`;
    const writing = `2026-11-01T08-30-15.250Z_${ino}-${prefix.byteLength}.jsonl.ocx.4343.1.tmp`;
    for (const name of [crashed, writing]) writeFileSync(join(archiveDirectory(), name), prefix);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(archiveDirectory(), crashed), tenMinutesAgo, tenMinutesAgo);
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    const names = readdirSync(archiveDirectory());
    expect(names).not.toContain(crashed);
    expect(names).toContain(writing);
  });

  /** An old leftover of an earlier trim of this ledger, a prefix of it, which the cleanup before a trim deletes. */
  function writeOldLeftover(label: string, readable: boolean): string {
    const ino = statSync(usageLogPath(), { bigint: true }).ino.toString();
    const head = readFileSync(usageLogPath());
    const prefix = head.subarray(0, head.indexOf(0x0a) + 1);
    const path = join(archiveDirectory(), `${label}_${ino}-${prefix.byteLength}.jsonl`);
    writeFileSync(path, prefix);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, tenMinutesAgo, tenMinutesAgo);
    if (!readable) chmodSync(path, 0o000);
    return path;
  }

  test("an unreadable leftover before the trim is reported by name and no longer stops the trim", () => {
    if (unreadableFilesUnsupported()) return;
    writeRows(200, 16 * 1024);
    const leftover = writeOldLeftover("2026-10-05T00-00-00.000Z", false);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
      expect(statSync(usageLogPath()).size).toBeLessThanOrEqual(MIN_USAGE_LEDGER_MAX_BYTES);
      const [message] = warn.mock.calls.map(call => String(call[0])).filter(text => text.includes("unpublished archive leftover"));
      expect(message).toContain(leftover);
      expect(message).toContain("EACCES");
    } finally {
      warn.mockRestore();
      chmodSync(leftover, 0o600);
    }
  });

  test("with two leftovers before the trim, an unreadable first one does not keep the second from being cleaned up", () => {
    if (unreadableFilesUnsupported()) return;
    writeRows(200, 16 * 1024);
    const unreadable = writeOldLeftover("2026-10-05T00-00-00.000Z", false);
    const readable = writeOldLeftover("2026-10-06T00-00-00.000Z", true);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
      const names = readdirSync(archiveDirectory());
      expect(names).not.toContain(readable.slice(archiveDirectory().length + 1));
      expect(names).toContain(unreadable.slice(archiveDirectory().length + 1));
    } finally {
      warn.mockRestore();
      chmodSync(unreadable, 0o600);
    }
  });

  test("a trim whose ledger was replaced by something else keeps its segment, which may be the only copy of those rows", () => {
    writeRows(200, 16 * 1024);
    const before = readFileSync(usageLogPath());
    const result = enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES, {
      onSpanCopied: () => {
        const replacement = `${usageLogPath()}.replacement`;
        writeFileSync(replacement, `${JSON.stringify({ requestId: "after", timestamp: 1 })}\n`);
        renameSync(replacement, usageLogPath());
      },
    });
    expect(result).toMatchObject({ kind: "deferred", reason: "revision-changed" });
    const [segment, ...others] = archiveFiles();
    expect(others).toEqual([]);
    expect(before.subarray(0, readFileSync(join(archiveDirectory(), segment!)).byteLength)
      .equals(readFileSync(join(archiveDirectory(), segment!)))).toBe(true);
  });

  test("a trim aborted because the ledger changed leaves no archive segment and spares a young leftover", () => {
    writeRows(200, 16 * 1024);
    const ino = statSync(usageLogPath(), { bigint: true }).ino.toString();
    const head = readFileSync(usageLogPath());
    const leftover = head.subarray(0, head.indexOf(0x0a) + 1);
    // Young enough to be another process's trim that has not renamed yet; an older one is not.
    const young = `2026-10-03T00-00-00.000Z_${ino}-${leftover.byteLength}.jsonl`;
    const old = `2026-10-04T00-00-00.000Z_${ino}-${leftover.byteLength}.jsonl`;
    writeFileSync(join(archiveDirectory(), young), leftover);
    writeFileSync(join(archiveDirectory(), old), leftover);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(archiveDirectory(), old), tenMinutesAgo, tenMinutesAgo);
    const result = enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES, {
      onSpanCopied: () => appendFileSync(usageLogPath(), `${JSON.stringify({ requestId: "raced", timestamp: 1 })}\n`),
    });
    expect(result).toMatchObject({ kind: "deferred", reason: "revision-changed" });
    expect(archiveFiles()).toEqual([young]);
  });

  const unusable: Array<[string, () => void]> = [
    ["missing", () => rmSync(archiveDirectory(), { recursive: true })],
    ["unwritable", () => chmodSync(archiveDirectory(), 0o500)],
  ];
  for (const [condition, breakArchive] of unusable) {
    test(`a ${condition} archive directory leaves the ledger untrimmed and says why`, async () => {
      // Root ignores directory modes, and Windows does not map them, so only the missing case is real there.
      if (condition === "unwritable" && (process.platform === "win32" || process.getuid?.() === 0)) return;
      writeRows(200, 16 * 1024);
      const before = readFileSync(usageLogPath());
      breakArchive();
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
      setUsageLedgerRetention(MIN_USAGE_LEDGER_MAX_BYTES);
      try {
        const deadline = Date.now() + 5_000;
        while (warnings.length === 0 && Date.now() < deadline) await Bun.sleep(50);
        expect(warnings.join("\n")).toContain(
          `[usage-retention] could not enforce the usage ledger size limit: the ledger was not trimmed because its oldest rows could not be archived in ${archiveDirectory()}`,
        );
        expect(readFileSync(usageLogPath()).equals(before)).toBe(true);
      } finally {
        setUsageLedgerRetention(undefined);
        console.warn = originalWarn;
        if (condition === "unwritable") chmodSync(archiveDirectory(), 0o700);
      }
    });
  }

  test(`a trim deletes archive files last written more than ${USAGE_ARCHIVE_RETENTION_DAYS} days ago and keeps younger ones`, () => {
    const now = Date.now();
    const expired = join(archiveDirectory(), "expired.jsonl");
    const kept = join(archiveDirectory(), "kept.jsonl");
    for (const [path, ageDays] of [[expired, USAGE_ARCHIVE_RETENTION_DAYS + 1], [kept, USAGE_ARCHIVE_RETENTION_DAYS - 1]] as const) {
      writeFileSync(path, "{}\n");
      const at = new Date(now - ageDays * DAY_MS);
      utimesSync(path, at, at);
    }
    writeRows(200, 16 * 1024);
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    const files = archiveFiles();
    expect(files).not.toContain("expired.jsonl");
    expect(files).toContain("kept.jsonl");
    expect(files).toHaveLength(2);
  });

  test("the uninstall manifest owns the archive directory once and never lists a segment", () => {
    // Ownership is only created in an empty home.
    rmSync(archiveDirectory(), { recursive: true });
    expect(initializeConfigOwnership(home)).toBe(true);
    mkdirSync(archiveDirectory());
    const manifestPaths = () =>
      (JSON.parse(readFileSync(join(home, CONFIG_UNINSTALL_MANIFEST), "utf8")) as { paths: string[] }).paths;

    const counts: number[] = [];
    for (let trim = 0; trim < 3; trim += 1) {
      writeRows(200, 16 * 1024);
      expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
      counts.push(manifestPaths().length);
    }
    expect(archiveFiles()).toHaveLength(3);
    const expiredAt = new Date(Date.now() - (USAGE_ARCHIVE_RETENTION_DAYS + 1) * DAY_MS);
    for (const name of archiveFiles()) utimesSync(join(archiveDirectory(), name), expiredAt, expiredAt);
    writeRows(200, 16 * 1024);
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    expect(archiveFiles()).toHaveLength(1);

    const paths = manifestPaths();
    expect(paths).toContain("usage-archive");
    expect(paths.filter(path => path.startsWith("usage-archive/"))).toEqual([]);
    expect([...counts, paths.length]).toEqual([counts[0]!, counts[0]!, counts[0]!, counts[0]!]);
  });
});
