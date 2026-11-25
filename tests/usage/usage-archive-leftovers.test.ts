import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { archiveTotalsName } from "../../src/usage/archive-segments";
import { enforceUsageLedgerSizeLimit } from "../../src/usage/ledger-retention";
import { MIN_USAGE_LEDGER_MAX_BYTES } from "../../src/usage/retention-contract";
import { usageLogPath } from "../../src/usage/log";

let home: string;
let previousHome: string | undefined;
const archiveDirectory = (): string => join(home, "usage-archive");

/** 200 rows of about 16 KiB, so the 1 MiB minimum limit cuts most of them. */
function writeLedger(): Buffer {
  mkdirSync(dirname(usageLogPath()), { recursive: true });
  const rows = Array.from({ length: 200 }, (_, index) => JSON.stringify({
    requestId: `req-${index}`, timestamp: Date.UTC(2026, 10, 1, 8, 30) + index * 1_000, provider: "alpha", padding: "x".repeat(16 * 1024),
  }));
  writeFileSync(usageLogPath(), rows.map(row => `${row}\n`).join(""), { mode: 0o600 });
  return readFileSync(usageLogPath());
}

const ledgerIno = (): string => statSync(usageLogPath(), { bigint: true }).ino.toString();
/** The end of the first row ending at or after `offset`. */
const rowEnd = (ledger: Buffer, offset: number): number => ledger.indexOf(0x0a, offset) + 1;

function archived(name: string, bytes: Buffer | string, ageMs: number): string {
  const path = join(archiveDirectory(), name);
  writeFileSync(path, bytes);
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
  return name;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-archive-leftovers-"));
  process.env.OPENCODEX_HOME = home;
  mkdirSync(archiveDirectory());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("usage archive leftover cleanup", () => {
  test("both leftover cleanups delete a removed segment's totals file, and only real segment names are candidates", () => {
    const ledger = writeLedger();
    const ino = ledgerIno();
    const head = ledger.subarray(0, rowEnd(ledger, 0));
    // Old: removed before the trim. Young: removed after the publish supersedes it.
    const old = archived(`2026-11-01T08-30-00.000Z_${ino}-${head.byteLength}.jsonl`, head, 10 * 60_000);
    const young = archived(`2026-10-02T00-00-00.000Z_${ino}-${head.byteLength}.jsonl`, head, 0);
    for (const name of [old, young]) archived(archiveTotalsName(name), "{}", 0);
    // Carries the inode marker and the ledger's bytes but is no segment: a substring match would delete it.
    const notASegment = archived(`notes_${ino}-${head.byteLength}.txt`, head, 10 * 60_000);
    expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES).kind).toBe("replaced");
    const names = readdirSync(archiveDirectory());
    for (const name of [old, young, archiveTotalsName(old), archiveTotalsName(young)]) expect(names).not.toContain(name);
    expect(names).toContain(notASegment);
  });

  test("a longer leftover of the same file is removed once a smaller cut publishes, after the limit was raised", () => {
    // A trim with the minimum limit was killed before its rename, leaving a long segment. The operator
    // raised the limit and restarted within five minutes, so the next trim's pre-check spares the young
    // leftover, cuts less, and publishes a shorter segment of the same file.
    const ledger = writeLedger();
    const ino = ledgerIno();
    const longCut = rowEnd(ledger, ledger.byteLength - 20 * 16 * 1024);
    const leftover = archived(`2026-11-01T08-30-00.000Z_${ino}-${longCut}.jsonl`, ledger.subarray(0, longCut), 60_000);
    const raised = 2 * 1024 * 1024;
    const result = enforceUsageLedgerSizeLimit(raised);
    expect(result.kind).toBe("replaced");
    const published = result.kind === "replaced" ? result.archivePath.split("/").at(-1)! : "";
    expect(statSync(join(archiveDirectory(), published)).size).toBeLessThan(longCut);
    const names = readdirSync(archiveDirectory()).filter(name => name.endsWith(".jsonl"));
    expect(names).toEqual([published]);
    expect(names).not.toContain(leftover);
    // The archive followed by the live ledger is still the original ledger, each row once.
    expect(Buffer.concat([readFileSync(join(archiveDirectory(), published)), readFileSync(usageLogPath())]).equals(ledger)).toBe(true);
  });
});
