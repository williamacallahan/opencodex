import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { enforceUsageLedgerSizeLimit } from "../../src/usage/ledger-retention";
import { MIN_USAGE_LEDGER_MAX_BYTES } from "../../src/usage/retention-contract";
import { appendUsageEntry, usageLogPath } from "../../src/usage/log";
import { setUsageLedgerRetention } from "../../src/server/usage-ledger-retention";

let home: string;
let previousHome: string | undefined;

/** Rows start at this instant and advance one second each, like a ledger appended in order. */
const FIRST_ROW_AT = Date.UTC(2026, 10, 1, 8, 30, 15, 250);

function archiveDirectory(): string {
  return join(home, "usage-archive");
}

/** Rows of a known size, each carrying a field no normalizer in this build knows about. */
function writeRows(count: number, padding: number): void {
  const path = usageLogPath();
  mkdirSync(dirname(path), { recursive: true });
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
    requestId: `req-${index}`,
    timestamp: FIRST_ROW_AT + index * 1000,
    aFieldThisBuildDoesNotKnow: "x".repeat(padding),
  }));
  writeFileSync(path, lines.map(line => `${line}\n`).join(""), { encoding: "utf-8", mode: 0o600 });
}

async function waitForWarning(warn: { mock: { calls: unknown[][] } }): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (warn.mock.calls.length === 0 && Date.now() < deadline) await Bun.sleep(25);
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-ledger-retention-"));
  process.env.OPENCODEX_HOME = home;
  mkdirSync(archiveDirectory());
});

afterEach(() => {
  setUsageLedgerRetention(undefined);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("usage ledger retention while the trim is suspended", () => {
  test("the append that crosses the limit returns before the check, which warns once on its own turn and keeps every row", async () => {
    // Just under the limit, so installing it schedules nothing and only the crossing append can.
    writeRows(70, 16 * 1024);
    const limit = statSync(usageLogPath()).size + 16;
    expect(limit).toBeGreaterThan(MIN_USAGE_LEDGER_MAX_BYTES);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      setUsageLedgerRetention(limit);
      await Bun.sleep(1_200);
      expect(warn.mock.calls).toHaveLength(0);
      appendUsageEntry({ requestId: "crossing", timestamp: 1, provider: "a", model: "m", status: 200, durationMs: 1 });
      expect(statSync(usageLogPath()).size).toBeGreaterThan(limit);
      expect(warn.mock.calls).toHaveLength(0);
      await waitForWarning(warn);
      appendUsageEntry({ requestId: "next", timestamp: 2, provider: "a", model: "m", status: 200, durationMs: 1 });
      await Bun.sleep(1_200);
      expect(warn.mock.calls).toHaveLength(1);
      expect(String(warn.mock.calls[0]![0])).toContain("trimming is suspended");
      const ledger = readFileSync(usageLogPath(), "utf-8");
      for (const id of ["req-0", "req-69", "crossing", "next"]) expect(ledger).toContain(`"requestId":"${id}"`);
      expect(readdirSync(archiveDirectory())).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("installing a limit over an already-oversized ledger checks it without waiting for an append, and leaves it whole", async () => {
    writeRows(200, 16 * 1024);
    const before = readFileSync(usageLogPath());
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      setUsageLedgerRetention(MIN_USAGE_LEDGER_MAX_BYTES);
      await waitForWarning(warn);
      expect(warn.mock.calls).toHaveLength(1);
      expect(readFileSync(usageLogPath()).equals(before)).toBe(true);
      expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES)).toEqual({
        kind: "deferred", currentBytes: statSync(usageLogPath()).size, reason: "archive-suspended",
      });
    } finally {
      warn.mockRestore();
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
});
