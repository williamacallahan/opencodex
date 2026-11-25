import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAppOwnedMemoryForTests } from "../../src/lib/app-owned-memory";
import { getFilteredUsageAggregate, resetUsageAggregateCacheForTests } from "../../src/server/management/usage-aggregate-cache";
import {
  requestUsageFilterIndexRebuild,
  setUsageFilterIndexTestHooksForTests,
  settleUsageFilterIndexReclaimForTests,
  usageFilterIndexPath,
} from "../../src/usage/filter-index";
import { resetUsageReadCacheForTests, type PersistedUsageEntry } from "../../src/usage/log";

// Retired index generations are removed by a background reclaimer in bounded batches; these
// cases pin the batch bound and the reclaimer's survival of another writer's lock.
const NOW = Date.parse("2026-09-01T10:00:00.000Z");
let testDir = "";
let previousHome: string | undefined;

function ledgerPath(): string {
  return join(testDir, "usage.jsonl");
}

function row(index: number): PersistedUsageEntry {
  return { requestId: `req-${index}`, timestamp: NOW, provider: "openai", model: "m", status: 200, durationMs: 1, usageStatus: "unreported" };
}

function retiredCounts(): { rows: number; attributions: number } {
  const db = new Database(usageFilterIndexPath(testDir), { readonly: true });
  try {
    const published = (db.query("SELECT value FROM usage_filter_index_meta WHERE key = 'generation'").get() as { value: string }).value;
    const rows = (db.query("SELECT COUNT(*) AS n FROM usage_rows WHERE generation <> ?").get(published) as { n: number }).n;
    const attributions = (db.query("SELECT COUNT(*) AS n FROM usage_attributions WHERE generation <> ?").get(published) as { n: number }).n;
    return { rows, attributions };
  } finally {
    db.close();
  }
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-filter-reclaim-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageAggregateCacheForTests();
  resetUsageReadCacheForTests();
  resetAppOwnedMemoryForTests();
});

afterEach(async () => {
  setUsageFilterIndexTestHooksForTests(null);
  await settleUsageFilterIndexReclaimForTests();
  resetUsageAggregateCacheForTests();
  resetUsageReadCacheForTests();
  resetAppOwnedMemoryForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(testDir, { recursive: true, force: true });
});

describe("retired usage index reclamation", () => {
  test("a row with thousands of attempt attributions is reclaimed in batches of at most 2,000 attributions", async () => {
    const attempts = Array.from({ length: 4_000 }, (_, index) => ({
      ordinal: index + 1, provider: "openai", model: `attempt-${index}`, adapter: "openai-responses",
      status: 200, durationMs: 1, sendCount: 1, recoveryKinds: [], usageStatus: "reported" as const,
    }));
    writeFileSync(ledgerPath(), `${JSON.stringify({ ...row(0), provider: "combo", model: "auto", attempts })}\n`);
    await getFilteredUsageAggregate({ provider: "openai" });
    const deletes: number[] = [];
    const realQuery = Database.prototype.query;
    const spy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
      const statement = realQuery.call(this, sql);
      if (!sql.startsWith("DELETE FROM usage_attributions WHERE generation = ? AND")) return statement;
      const run = statement.run.bind(statement);
      return Object.assign(Object.create(statement), {
        run: (...args: unknown[]) => {
          const result = run(...(args as []));
          deletes.push(result.changes);
          return result;
        },
      });
    } as typeof Database.prototype.query);
    try {
      resetUsageAggregateCacheForTests();
      requestUsageFilterIndexRebuild();
      await getFilteredUsageAggregate({ provider: "openai" });
      await settleUsageFilterIndexReclaimForTests();
    } finally {
      spy.mockRestore();
    }
    expect(deletes.filter(changes => changes > 0).length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...deletes)).toBeLessThanOrEqual(2_000);
    expect(retiredCounts()).toEqual({ rows: 0, attributions: 0 });
  });

  test("a backlog left by another writer's lock drains after the lock is released, without another index read", async () => {
    writeFileSync(ledgerPath(), Array.from({ length: 3_000 }, (_, index) => `${JSON.stringify(row(index))}\n`).join(""));
    await getFilteredUsageAggregate({ provider: "openai" });
    let holder: Database | null = null;
    resetUsageAggregateCacheForTests();
    setUsageFilterIndexTestHooksForTests({
      afterPublish: ({ dbPath }) => {
        // Another writer takes the index lock as the retired generation becomes reclaimable.
        holder = new Database(dbPath);
        holder.exec("BEGIN IMMEDIATE");
      },
    });
    requestUsageFilterIndexRebuild();
    await getFilteredUsageAggregate({ provider: "openai" });
    setUsageFilterIndexTestHooksForTests(null);
    expect(retiredCounts().rows).toBe(3_000);
    await Bun.sleep(450);
    holder!.exec("COMMIT");
    holder!.close();
    // Raw appends only: nothing reads the index again.
    appendFileSync(ledgerPath(), Array.from({ length: 42 }, (_, index) => `${JSON.stringify(row(10_000 + index))}\n`).join(""));
    await settleUsageFilterIndexReclaimForTests();
    expect(retiredCounts()).toEqual({ rows: 0, attributions: 0 });
  });

  test("a reclaimer meeting an exclusive lock never blocks the event loop while it opens the index", async () => {
    writeFileSync(ledgerPath(), Array.from({ length: 3_000 }, (_, index) => `${JSON.stringify(row(index))}\n`).join(""));
    await getFilteredUsageAggregate({ provider: "openai" });
    let holdReclaim = true;
    resetUsageAggregateCacheForTests();
    setUsageFilterIndexTestHooksForTests({
      // Keeps the reclaimer retrying, its connection closed between attempts, until the lock below is held.
      betweenReclaimCheckAndLock: () => { if (holdReclaim) throw new Error("database is locked"); },
    });
    requestUsageFilterIndexRebuild();
    await getFilteredUsageAggregate({ provider: "openai" });
    // Another connection holds the index exclusively, so even reading its schema must wait.
    const holder = new Database(usageFilterIndexPath(testDir));
    holder.exec("PRAGMA locking_mode = EXCLUSIVE");
    holder.exec("BEGIN EXCLUSIVE");
    holder.query("SELECT COUNT(*) FROM usage_filter_index_meta").get();
    holdReclaim = false;
    let worstLag = 0;
    let expected = performance.now() + 10;
    const timer = setInterval(() => {
      const now = performance.now();
      worstLag = Math.max(worstLag, now - expected);
      expected = now + 10;
    }, 10);
    try {
      await Bun.sleep(700);
    } finally {
      clearInterval(timer);
      holder.exec("COMMIT");
      holder.close();
    }
    await settleUsageFilterIndexReclaimForTests();
    setUsageFilterIndexTestHooksForTests(null);
    expect(worstLag).toBeLessThan(100);
    expect(retiredCounts()).toEqual({ rows: 0, attributions: 0 });
  });
});
