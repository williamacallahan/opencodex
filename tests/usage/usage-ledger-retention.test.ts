import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
function writeRows(count: number, padding: number): string[] {
  const path = usageLogPath();
  mkdirSync(dirname(path), { recursive: true });
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
    requestId: `req-${index}`,
    timestamp: FIRST_ROW_AT + index * 1000,
    aFieldThisBuildDoesNotKnow: "x".repeat(padding),
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

  test("a trim aborted because the ledger changed leaves no archive segment", () => {
    writeRows(200, 16 * 1024);
    const result = enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES, {
      onSpanCopied: () => appendFileSync(usageLogPath(), `${JSON.stringify({ requestId: "raced", timestamp: 1 })}\n`),
    });
    expect(result).toMatchObject({ kind: "deferred", reason: "revision-changed" });
    expect(archiveFiles()).toEqual([]);
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
