import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { archiveTotalsName } from "../../src/usage/archive-segments";
import { buildMissingArchiveTotals } from "../../src/usage/archive-query";
import { archiveTotalsBuildFailure, scheduleArchiveTotalsBuild } from "../../src/usage/archive-totals";
import { enforceUsageLedgerSizeLimit } from "../../src/usage/ledger-retention";
import { usageLedgerRetentionStatus } from "../../src/server/usage-ledger-retention";
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

/** Every file under the archive, with its bytes, and every link with its target, so any write or delete shows. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) files.set(name, `link:${readlinkSync(path)}`);
      else if (entry.isDirectory()) { files.set(`${name}/`, "dir"); walk(path, `${name}/`); }
      else files.set(name, readFileSync(path).toString("base64"));
    }
  };
  walk(root, "");
  return files;
}

describe("the legacy usage archive is never written or deleted while its trim is suspended", () => {
  test("a trim over the limit, segment totals builds and the startup pass leave every archive byte and the ledger as they were", async () => {
    const ledger = writeLedger();
    const ino = ledgerIno();
    const head = ledger.subarray(0, rowEnd(ledger, 0));
    const expired = 40 * 24 * 60 * 60_000;
    // An exactly valid-looking unpublished leftover of the live ledger, old enough for every former cleanup rule.
    const segment = archived(`2026-11-01T08-30-00.000Z_${ino}-${head.byteLength}.jsonl`, head, expired);
    archived(archiveTotalsName(segment), "{}", expired);
    archived(`${segment}.ocx.123.4.tmp`, head, expired);
    archived("operator-notes.txt", "keep me", expired);
    mkdirSync(join(archiveDirectory(), "nested"));
    writeFileSync(join(archiveDirectory(), "nested", "child.jsonl"), head);
    const outside = join(home, "outside-target.txt");
    writeFileSync(outside, "target");
    // Windows without symlink privilege cannot create the link; the byte checks below still run.
    try {
      symlinkSync(outside, join(archiveDirectory(), "link.jsonl"));
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    const before = snapshot(archiveDirectory());

    const result = enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES);
    expect(result).toEqual({ kind: "deferred", currentBytes: ledger.byteLength, reason: "archive-suspended" });
    await expect(scheduleArchiveTotalsBuild(join(archiveDirectory(), segment))).rejects.toThrow();
    expect(archiveTotalsBuildFailure(join(archiveDirectory(), segment))).toEqual({ reason: "publishing-suspended" });
    await buildMissingArchiveTotals(4, home);

    expect(snapshot(archiveDirectory())).toEqual(before);
    expect(readFileSync(outside, "utf8")).toBe("target");
    expect(readFileSync(usageLogPath()).equals(ledger)).toBe(true);
  });

  test("the retention status says enforcement is suspended rather than that the ledger is under its limit", () => {
    const ledger = writeLedger();
    expect(usageLedgerRetentionStatus(MIN_USAGE_LEDGER_MAX_BYTES)).toMatchObject({
      maxBytes: MIN_USAGE_LEDGER_MAX_BYTES, currentBytes: ledger.byteLength, enforcement: "suspended",
    });
  });
});
