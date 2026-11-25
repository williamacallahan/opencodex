import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAppOwnedMemoryForTests } from "../../src/lib/app-owned-memory";
import { getFilteredUsageAggregate, getUsageAggregate, resetUsageAggregateCacheForTests } from "../../src/server/management/usage-aggregate-cache";
import {
  readUsageFilterCandidates,
  requestUsageFilterIndexRebuild,
  usageFilterIndexPath,
  setUsageFilterIndexTestHooksForTests,
  settleUsageFilterIndexReclaimForTests,
} from "../../src/usage/filter-index";
import { currentUsageLogRevision, resetUsageReadCacheForTests } from "../../src/usage/log";
import { noteUsageRevision } from "../../src/usage/revision-observation";
import { Database } from "bun:sqlite";
import { repoPath } from "../helpers/repo-root";

// Whether a published index generation may be extended or served is decided from the index
// database, so a restarted process, a peer process and the first reader after a publish all reach
// the same verdict after another process observed a destructive change to usage.jsonl.
let testDir = "";
let previousHome: string | undefined;

function ledgerPath(): string {
  return join(testDir, "usage.jsonl");
}

// Rows far past 64 KiB, so the early rewrite leaves the index's boundary digest window intact.
function row(requestId: string, provider: string, apiKeyId: string): string {
  return `${JSON.stringify({ requestId, timestamp: Date.now() - 60_000, provider, model: "m", status: 200, durationMs: 1,
    usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1 }, admissionKind: "configured", apiKeyId, pad: "x".repeat(400) })}\n`;
}
const filler = Array.from({ length: 400 }, (_, index) => row(`f-${index}`, "anthropic", "key-f")).join("");
const grown = ["a1", "a2", "a3", "a4"].map(id => row(id, "anthropic", "key-f")).join("");
/** Shorter than the grown file, regrown past the first index, with the first row moved from key-a to key-b. */
const rewritten = row("r-0", "google", "key-b") + filler + row("a1", "anthropic", "key-f");

/** A separate Bun process answering one usage read per line on stdin. */
function startProcess() {
  const script = join(testDir, `reader-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(script, `
import { getFilteredUsageAggregate, getUsageAggregate } from ${JSON.stringify(repoPath("src/server/management/usage-aggregate-cache.ts"))};
import { getUsageSourceFacets } from ${JSON.stringify(repoPath("src/server/management/usage-source-facets.ts"))};
import { settleUsageColdRebuildForTests, UsageColdReadPendingError } from ${JSON.stringify(repoPath("src/usage/cold-rebuild-slot.ts"))};
import { publishedUsageFilterIndexGeneration, readUsageFilterCandidatesPassive } from ${JSON.stringify(repoPath("src/usage/filter-index.ts"))};
let builds = 0;
async function settled(read) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await read(); } catch (error) {
      if (!(error instanceof UsageColdReadPendingError) || attempt > 4) throw error;
      builds += 1;
      await settleUsageColdRebuildForTests();
    }
  }
}
const ops = {
  observe: async () => { await settled(() => getUsageAggregate({ cold: "background" })); return {}; },
  keyB: async () => {
    const result = await settled(() => getFilteredUsageAggregate({ apiKeyId: "key-b" }, undefined, "background"));
    return { requests: result.accumulator.summarize("all", Date.now()).summary.requests, generation: publishedUsageFilterIndexGeneration(), builds };
  },
  picker: async () => {
    const facets = await settled(() => getUsageSourceFacets({ client: "all", device: { kind: "all" } }, ["key-a", "key-b", "key-f"]));
    return Object.fromEntries(facets.devices.filter(entry => entry.device.kind === "key").map(entry => [entry.device.id, entry.requests]));
  },
  passive: async () => {
    const read = await readUsageFilterCandidatesPassive({ provider: null, model: null, apiKeyId: "key-b" });
    if (!read) return { declined: true };
    try { let rows = 0; for (let page = read.nextPage(); page.length > 0; page = read.nextPage()) rows += page.length; return { rows }; }
    finally { read.close(); }
  },
};
for await (const line of console) {
  const op = line.trim();
  if (op) console.log(JSON.stringify(await ops[op]()));
}
`);
  const proc = Bun.spawn([process.execPath, script], {
    env: { ...process.env, OPENCODEX_HOME: testDir }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async send(op: string): Promise<Record<string, unknown>> {
      proc.stdin.write(`${op}\n`);
      await proc.stdin.flush();
      while (!buffered.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`reader exited: ${await new Response(proc.stderr).text()}`);
        buffered += decoder.decode(value);
      }
      const end = buffered.indexOf("\n");
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      return JSON.parse(line) as Record<string, unknown>;
    },
    async exit(): Promise<number> {
      await proc.stdin.end();
      return proc.exited;
    },
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-filter-trust-"));
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

describe("filtered usage index generation trust", () => {
  test("a process restarted after another observed a destructive change does not extend the stale generation", async () => {
    writeFileSync(ledgerPath(), row("r-0", "openai", "key-a") + filler);
    const original = startProcess();
    expect(await original.send("keyB")).toMatchObject({ requests: 0 });
    expect(await original.send("picker")).toMatchObject({ "key-a": 1, "key-b": 0 });
    appendFileSync(ledgerPath(), grown);
    await original.send("observe");
    writeFileSync(ledgerPath(), rewritten);
    // The original process sees the shorter file, then exits before anything rebuilds the index.
    await original.send("observe");
    expect(await original.exit()).toBe(0);

    const restarted = startProcess();
    try {
      expect(await restarted.send("passive")).toEqual({ declined: true });
      expect(await restarted.send("keyB")).toMatchObject({ requests: 1 });
      expect(await restarted.send("picker")).toMatchObject({ "key-a": 0, "key-b": 1 });
      expect(await restarted.send("passive")).toEqual({ rows: 1 });
    } finally {
      expect(await restarted.exit()).toBe(0);
    }
  }, 30_000);

  test("two processes that both observed a destructive change adopt one replacement instead of replacing each other", async () => {
    writeFileSync(ledgerPath(), row("r-0", "openai", "key-a") + filler);
    const first = startProcess();
    const second = startProcess();
    try {
      expect(await first.send("keyB")).toMatchObject({ requests: 0 });
      expect(await second.send("keyB")).toMatchObject({ requests: 0 });
      appendFileSync(ledgerPath(), grown);
      await first.send("observe");
      await second.send("observe");
      writeFileSync(ledgerPath(), rewritten);
      await first.send("observe");
      await second.send("observe");
      const answers: Array<Record<string, unknown>> = [];
      for (let turn = 0; turn < 6; turn += 1) answers.push(await (turn % 2 === 0 ? first : second).send("keyB"));
      for (const answer of answers) expect(answer.requests).toBe(1);
      // One valid replacement; every later read adopts it.
      expect(new Set(answers.map(answer => answer.generation)).size).toBe(1);
    } finally {
      await first.exit();
      await second.exit();
    }
  }, 60_000);

  test("a generation whose source changed destructively before publication is never served to the first reader", async () => {
    writeFileSync(ledgerPath(), row("r-0", "openai", "key-a") + filler);
    const keyB = async () => (await getFilteredUsageAggregate({ apiKeyId: "key-b" })).accumulator.summarize("all", Date.now()).summary.requests;
    expect(await keyB()).toBe(0);
    appendFileSync(ledgerPath(), grown);
    await getUsageAggregate({});
    let rewrote = false;
    resetUsageAggregateCacheForTests();
    await getUsageAggregate({});
    setUsageFilterIndexTestHooksForTests({
      beforePublish: () => {
        if (rewrote) return;
        rewrote = true;
        // After the rebuild read the grown file, the file shrinks and its first row moves to key-b.
        writeFileSync(ledgerPath(), rewritten);
        noteUsageRevision(currentUsageLogRevision());
      },
    });
    requestUsageFilterIndexRebuild();
    // The first active reader after the publish attempt, not a cache that might retry above it.
    const read = await readUsageFilterCandidates({ provider: null, model: null, apiKeyId: "key-b" });
    let candidates = 0;
    try {
      for (let page = read!.nextPage(); page.length > 0; page = read!.nextPage()) candidates += page.length;
    } finally {
      read!.close();
    }
    expect(candidates).toBe(1);
    expect(await keyB()).toBe(1);
  });

  test("a destructive change observed for another home's ledger is recorded in that home's index only", async () => {
    const homeB = mkdtempSync(join(tmpdir(), "ocx-usage-filter-trust-b-"));
    const recorded = (home: string) => {
      const db = new Database(usageFilterIndexPath(home), { readonly: true });
      try {
        const found = db.query("SELECT value FROM usage_filter_index_meta WHERE key = 'source_invalidations'").get() as { value: string } | null;
        return Number(found?.value ?? 0);
      } finally {
        db.close();
      }
    };
    try {
      writeFileSync(ledgerPath(), row("r-0", "openai", "key-a") + filler);
      await getFilteredUsageAggregate({ apiKeyId: "key-b" });
      process.env.OPENCODEX_HOME = homeB;
      resetUsageAggregateCacheForTests();
      const ledgerB = join(homeB, "usage.jsonl");
      writeFileSync(ledgerB, row("r-0", "openai", "key-a") + filler);
      await getFilteredUsageAggregate({ apiKeyId: "key-b" });
      appendFileSync(ledgerB, grown);
      noteUsageRevision(currentUsageLogRevision());
      writeFileSync(ledgerB, rewritten);
      const shrunkB = currentUsageLogRevision();
      // The observation arrives in a process whose default home is A.
      process.env.OPENCODEX_HOME = testDir;
      noteUsageRevision(shrunkB);
      expect(recorded(homeB)).toBe(1);
      expect(recorded(testDir)).toBe(0);
    } finally {
      process.env.OPENCODEX_HOME = testDir;
      rmSync(homeB, { recursive: true, force: true });
    }
  });
});
