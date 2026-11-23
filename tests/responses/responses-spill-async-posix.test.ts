import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BULK_DURABLE_IO_BUDGET_MS } from "../helpers/test-budget";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  evictOldestResponseContinuationForBudget,
  expandPreviousResponseInput,
  flushPendingResponseSpillsForTests,
  flushResponseState,
  getSpilledResponseBytesForTests,
  getStoredResponseBytesForTests,
  markBodyNonPersistable,
  pendingResponseSpillMetricsForTests,
  previousResponseReplayFailure,
  previousResponseReplayPrefixLength,
  rememberResponseState,
  responseContinuationRetainedStoreSnapshot,
  responseStateMetrics,
  responseStatePersistPendingForTests,
  runPendingResponseStatePersistForTests,
  setResponseStateByteCapForTests,
  setResponseStatePersistAttemptHookForTests,
  setSpilledResponseByteCapForTests,
  sweepExpiredResponseStates,
} from "../../src/responses/state";
import {
  deleteResponseSpill,
  responseSpillDirectory,
  setSpillIoForTest,
  writeResponseSpillDurably,
} from "../../src/responses/spill-store";
import { parseRequest } from "../../src/responses/parser";
import { setPlatformForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function fixedResponse(id: string, output: unknown[]): { id: string; output: unknown[]; status: string } {
  return { id, output, status: "completed" };
}

function spillFileNames(home: string): string[] {
  const dir = responseSpillDirectory(home);
  return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".spill.json")) : [];
}

function rememberLarge(id: string, text: string, providers?: Parameters<typeof rememberResponseState>[2]): void {
  rememberResponseState(
    { model: "test/model", input: text, store: false },
    fixedResponse(id, [{ type: "message", role: "assistant", content: text }]),
    providers,
    { force: true },
  );
}

describe("Responses previous_response_id async POSIX spill state", () => {
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-state-async-posix-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
    setPlatformForTests("linux");
  });

  afterEach(() => {
    setSpillIoForTest(null);
    setPlatformForTests(null);
    setResponseStateByteCapForTests(null);
    setSpilledResponseByteCapForTests(null);
    setResponseStatePersistAttemptHookForTests(null);
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  test("POSIX spill yields the event loop while keeping queued entries replayable", async () => {
    setResponseStateByteCapForTests(1_024);
    let tickRan = false;
    setTimeout(() => { tickRan = true; }, 0);

    rememberLarge("resp_posix_yield", "y".repeat(8_000));
    // Queued synchronously; replayable from RAM before async settlement completes.
    expect(pendingResponseSpillMetricsForTests().count).toBe(1);
    expect(JSON.stringify(expandPreviousResponseInput({ previous_response_id: "resp_posix_yield", input: "next" })))
      .toContain("yyyyyyyy");

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(tickRan).toBe(true);

    await flushPendingResponseSpillsForTests();
    expect(pendingResponseSpillMetricsForTests()).toEqual({ count: 0, bytes: 0 });
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, spillStubCount: 1, spillWriteFailures: 0 });
    expect(JSON.stringify(expandPreviousResponseInput({ previous_response_id: "resp_posix_yield", input: "next" })))
      .toContain("yyyyyyyy");
  });

  test("O(1) spilledResponseBytes matches actual files on disk across insert, replace, tombstone, overflow unlink, and drain", async () => {
    const sumDiskSpills = () => spillFileNames(home).reduce(
      (sum, name) => sum + statSync(join(responseSpillDirectory(home), name)).size,
      0,
    );
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_o1_a", "a".repeat(8_000));
    rememberLarge("resp_o1_b", "b".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(getSpilledResponseBytesForTests()).toBe(sumDiskSpills());

    // Same-id replacement defers old file in pendingSpillUnlinks; total remains exact.
    rememberLarge("resp_o1_a", "c".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(getSpilledResponseBytesForTests()).toBe(sumDiskSpills());

    // Overflow pendingSpillUnlinks (>128) unlinks oldest and updates O(1) total accurately.
    for (let i = 0; i < 130; i += 1) {
      rememberLarge("resp_o1_a", `gen-${i}-${"x".repeat(4_000)}`);
      await flushPendingResponseSpillsForTests();
    }
    expect(getSpilledResponseBytesForTests()).toBe(sumDiskSpills());

    await flushResponseState();
    expect(getSpilledResponseBytesForTests()).toBe(sumDiskSpills());

    // Non-persistable replacement deletes existing spill cleanly.
    markBodyNonPersistable({ input: "drop" });
    expect(getSpilledResponseBytesForTests()).toBe(sumDiskSpills());
    deleteResponseSpill({ version: 1, fileName: "missing.spill.json", digest: "0".repeat(64), payloadBytes: 123 });
  });

  test("coalesced async directory fsync preserves dir-fsync ordering before stub-swap", async () => {
    const events: string[] = [];
    setSpillIoForTest({ record: event => events.push(event) });
    setResponseStateByteCapForTests(1_024);

    rememberLarge("resp_coalesce_1", "a".repeat(8_000));
    rememberLarge("resp_coalesce_2", "b".repeat(8_000));
    await flushPendingResponseSpillsForTests();

    const dirFsyncs = events.filter(event => event === "dir-fsync");
    const stubSwaps = events.filter(event => event === "stub-swap");
    expect(dirFsyncs).toHaveLength(2);
    expect(stubSwaps).toHaveLength(2);
    expect(events.indexOf("dir-fsync")).toBeLessThan(events.indexOf("stub-swap"));
    expect(events.lastIndexOf("dir-fsync")).toBeLessThan(events.lastIndexOf("stub-swap"));
  });

  test("breaks createdAt ties on the response id, not on insertion order", async () => {
    const realNow = Date.now;
    try {
      setResponseStateByteCapForTests(1_024);
      const base = realNow();
      Date.now = () => base;
      const before = new Set(spillFileNames(home));
      rememberLarge("resp_tie_b", "x".repeat(8_000));
      await flushPendingResponseSpillsForTests();
      const bFile = spillFileNames(home).find(name => !before.has(name))!;
      const beforeA = new Set(spillFileNames(home));
      rememberLarge("resp_tie_a", "x".repeat(8_000));
      await flushPendingResponseSpillsForTests();
      const aFile = spillFileNames(home).find(name => !beforeA.has(name))!;

      setSpilledResponseByteCapForTests(20_000);
      rememberLarge("resp_tie_trigger", "y");
      await flushPendingResponseSpillsForTests();

      const dir = responseSpillDirectory(home);
      expect(existsSync(join(dir, aFile))).toBe(false);
      expect(existsSync(join(dir, bFile))).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  test("survives a single spill payload larger than the whole disk budget", async () => {
    setResponseStateByteCapForTests(1_024);
    setSpilledResponseByteCapForTests(1_000);
    rememberLarge("resp_over_budget_a", "x".repeat(8_000));
    rememberLarge("resp_over_budget_b", "x".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(spillFileNames(home)).toHaveLength(0);
    expect(getSpilledResponseBytesForTests()).toBe(0);
    setSpilledResponseByteCapForTests(1_000_000);
    rememberLarge("resp_over_budget_c", "x".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(spillFileNames(home)).toHaveLength(1);
  });

  test("counts deferred spill generations against the disk cap and drains them first", async () => {
    setResponseStateByteCapForTests(1_024);
    setSpilledResponseByteCapForTests(60_000);
    for (let i = 0; i < 8; i += 1) {
      rememberLarge("resp_deferred_gen", `gen-${i}-${"x".repeat(8_000)}`);
      await flushPendingResponseSpillsForTests();
    }
    expect(getSpilledResponseBytesForTests()).toBeLessThanOrEqual(60_000);
    const onDisk = spillFileNames(home);
    expect(onDisk.length).toBeLessThanOrEqual(4);
    expect((expandPreviousResponseInput({
      previous_response_id: "resp_deferred_gen", input: "next",
    }) as { input: unknown[] }).input).toHaveLength(3);
  });

  test("reclaims an over-budget snapshot without a new continuation mutation", async () => {
    const realNow = Date.now;
    try {
      setResponseStateByteCapForTests(4_000);
      const base = realNow();
      const files: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        Date.now = () => base - (10 - i) * 60_000;
        const before = new Set(spillFileNames(home));
        rememberResponseState(
          { model: "test/model", input: "z".repeat(8_000), store: false },
          fixedResponse(`resp_budget_restart_${i}`, [{ type: "message", role: "assistant", content: "stored" }]),
          undefined,
          { force: true, clientThreadId: "task-budget" },
        );
        await flushPendingResponseSpillsForTests();
        files.push(spillFileNames(home).find(name => !before.has(name))!);
      }
      Date.now = () => base;
      await flushResponseState();
      clearResponseStateMemoryForTests();

      setResponseStateByteCapForTests(4_000);
      setSpilledResponseByteCapForTests(20_000);
      expect(spillFileNames(home).length).toBe(4);

      const expanded = expandPreviousResponseInput(
        { previous_response_id: "resp_budget_restart_3", input: "next" },
        "task-budget",
      );

      expect(getSpilledResponseBytesForTests()).toBeLessThanOrEqual(20_000);
      expect(existsSync(join(responseSpillDirectory(home), files[0]!))).toBe(false);
      expect(existsSync(join(responseSpillDirectory(home), files[3]!))).toBe(true);
      expect((expanded as { input: unknown[] }).input).toHaveLength(3);

      setSpilledResponseByteCapForTests(10_000);
      sweepExpiredResponseStates();
      expect(getSpilledResponseBytesForTests()).toBeLessThanOrEqual(10_000);
    } finally {
      Date.now = realNow;
    }
  });

  test("TTL and count eviction delete dedicated spill files and release stub bytes", async () => {
    const realNow = Date.now;
    setResponseStateByteCapForTests(1_024);
    try {
      Date.now = () => realNow() - 25 * 60 * 60 * 1_000;
      rememberLarge("resp_ttl_spill", "t".repeat(8_000));
      await flushPendingResponseSpillsForTests();
      const ttlFile = spillFileNames(home)[0]!;
      Date.now = realNow;
      rememberLarge("resp_after_ttl", "u".repeat(8_000));
      await flushPendingResponseSpillsForTests();
      expect(existsSync(join(responseSpillDirectory(home), ttlFile))).toBe(false);

      clearResponseStateForTests();
      setResponseStateByteCapForTests(1_024);
      rememberLarge("resp_count_spill", "v".repeat(8_000));
      await flushPendingResponseSpillsForTests();
      const countFile = spillFileNames(home)[0]!;
      setResponseStateByteCapForTests(1_000_000_000);
      for (let i = 0; i < 1_000; i++) rememberLarge(`resp_count_${i}`, "x");
      expect(existsSync(join(responseSpillDirectory(home), countFile))).toBe(false);
      expect(responseStateMetrics().count).toBe(1_000);
    } finally {
      Date.now = realNow;
    }
  });

  test("startup orphan cleanup removes only old unreferenced regular spill files", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_live_orphan_gc", "l".repeat(8_000));
    await flushResponseState();
    const live = spillFileNames(home)[0]!;
    const orphanRef = writeResponseSpillDurably("resp_orphan_gc", {
      createdAt: Date.now(), items: ["orphan"],
    });
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(join(responseSpillDirectory(home), orphanRef.fileName), old, old);
    clearResponseStateMemoryForTests();
    expandPreviousResponseInput({ previous_response_id: "resp_live_orphan_gc", input: "next" });
    expect(existsSync(join(responseSpillDirectory(home), live))).toBe(true);
    expect(existsSync(join(responseSpillDirectory(home), orphanRef.fileName))).toBe(false);
  });

  test("startup orphan cleanup preserves referenced young live and unrelated files", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_gc_preserve", "g".repeat(8_000));
    await flushResponseState();
    const live = spillFileNames(home)[0]!;
    const young = writeResponseSpillDurably("resp_young", { createdAt: Date.now(), items: ["young"] });
    const unrelated = join(responseSpillDirectory(home), "unrelated.txt");
    writeFileSync(unrelated, "keep");
    clearResponseStateMemoryForTests();
    expandPreviousResponseInput({ previous_response_id: "resp_gc_preserve", input: "next" });
    expect(existsSync(join(responseSpillDirectory(home), live))).toBe(true);
    expect(existsSync(join(responseSpillDirectory(home), young.fileName))).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  test("concurrent flush and async demotion cannot inline or lose the spill stub", async () => {
    rememberLarge("resp_before_flush", "small");
    const flushing = flushResponseState();
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_during_flush", "d".repeat(8_000));
    await flushing;
    await flushResponseState();
    const snapshot = JSON.parse(readFileSync(join(home, "responses-state.json"), "utf8")) as { states: [string, Record<string, unknown>][] };
    const row = snapshot.states.find(([id]) => id === "resp_during_flush")?.[1];
    expect(row).toMatchObject({ kind: "spill" });
    expect(row?.items).toBeUndefined();
  });

  test("small entries retain the legacy v2 debounced snapshot representation", async () => {
    rememberLarge("resp_legacy_small", "small");
    await flushResponseState();
    const snapshot = JSON.parse(readFileSync(join(home, "responses-state.json"), "utf8")) as { version: number; states: [string, Record<string, unknown>][] };
    expect(snapshot.version).toBe(2);
    const row = snapshot.states.find(([id]) => id === "resp_legacy_small")?.[1];
    expect(row).toMatchObject({ items: expect.any(Array) });
    expect(row?.kind).toBeUndefined();
    expect(row?.sizeBytes).toBeUndefined();
  });

  test("same-id spill replacement keeps the row replay-addressable during async publication and retains old file until flush", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_atomic_replace", "old".repeat(3_000));
    await flushPendingResponseSpillsForTests();
    const oldFile = spillFileNames(home)[0]!;
    let observedReplayAtPublish = false;
    setSpillIoForTest({
      record(event) {
        if (event !== "publish") return;
        const replay = expandPreviousResponseInput({ previous_response_id: "resp_atomic_replace", input: "delta" });
        observedReplayAtPublish = JSON.stringify(replay).includes("newnewnew");
        expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(true);
      },
    });
    rememberLarge("resp_atomic_replace", "new".repeat(3_000));
    await flushPendingResponseSpillsForTests();
    expect(observedReplayAtPublish).toBe(true);
    expect(JSON.stringify(expandPreviousResponseInput({ previous_response_id: "resp_atomic_replace", input: "delta" })))
      .toContain("newnewnew");
    await flushResponseState();
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(false);
  });

  test("existing spill replacement stays a direct stub-to-stub swap even when the candidate fits RAM", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_direct_b2", "old".repeat(3_000));
    await flushPendingResponseSpillsForTests();
    const oldFile = spillFileNames(home)[0]!;
    const events: string[] = [];
    setSpillIoForTest({ record: event => events.push(event) });
    setResponseStateByteCapForTests(1_000_000);

    rememberLarge("resp_direct_b2", "small replacement");
    await flushPendingResponseSpillsForTests();

    expect(events).toContain("publish");
    expect(events).toContain("stub-swap");
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, spillStubCount: 1 });
    await flushResponseState();
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(false);
    expect(JSON.stringify(expandPreviousResponseInput({ previous_response_id: "resp_direct_b2", input: "delta" })))
      .toContain("small replacement");
  });

  test("crash between new-generation publication and stub swap preserves the old row and reclaims the new orphan", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_crash_window", "old".repeat(3_000));
    await flushResponseState();
    const oldFile = spillFileNames(home)[0]!;
    const orphan = writeResponseSpillDurably("resp_crash_window", {
      createdAt: Date.now(), items: ["new".repeat(3_000)],
    });
    const oldTime = new Date(Date.now() - 20 * 60_000);
    utimesSync(join(responseSpillDirectory(home), orphan.fileName), oldTime, oldTime);
    clearResponseStateMemoryForTests();
    setResponseStateByteCapForTests(1_024);
    expect(JSON.stringify(expandPreviousResponseInput({ previous_response_id: "resp_crash_window", input: "delta" })))
      .toContain("oldoldold");
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(true);
    expect(existsSync(join(responseSpillDirectory(home), orphan.fileName))).toBe(false);
  });

  test("same response id and equal-size replacement use distinct basenames and unlink old only after stub swap", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_equal_size", "a".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    const old = spillFileNames(home)[0]!;
    let published: string[] = [];
    setSpillIoForTest({ record: event => { if (event === "publish") published = spillFileNames(home); } });
    rememberLarge("resp_equal_size", "b".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(published).toHaveLength(2);
    expect(new Set(published).size).toBe(2);
    await flushResponseState();
    expect(spillFileNames(home)).toHaveLength(1);
    expect(existsSync(join(responseSpillDirectory(home), old))).toBe(false);
  });

  test("identical-content re-spill still allocates a generation-unique basename", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_identical", "i".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    const old = spillFileNames(home)[0]!;
    let duringPublish: string[] = [];
    setSpillIoForTest({ record: event => { if (event === "publish") duringPublish = spillFileNames(home); } });
    rememberLarge("resp_identical", "i".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(duringPublish).toHaveLength(2);
    expect(duringPublish.some(name => name !== old)).toBe(true);
  });

  test("spill-failed tombstone survives simulated process restart and returns the canonical failure", async () => {
    setSpillIoForTest({ write: () => { throw new Error("fail"); } });
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_failed_restart", "f".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    setSpillIoForTest(null);
    await flushResponseState();
    clearResponseStateMemoryForTests();
    const body = { previous_response_id: "resp_failed_restart", input: "delta" };
    expect(expandPreviousResponseInput(body)).toBe(body);
    expect(previousResponseReplayFailure(body)).toEqual({
      code: "previous_response_not_found", reason: "spill_failed",
    });
  });

  test("spill replay preserves replay-prefix provenance and compaction-marker acknowledgement", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberResponseState(
      { input: [{ type: "context_compaction" }, { role: "user", content: "x".repeat(8_000) }] },
      fixedResponse("resp_spill_provenance", [{ role: "assistant", content: "done" }]),
    );
    await flushPendingResponseSpillsForTests();
    const expanded = expandPreviousResponseInput({
      model: "test/model", previous_response_id: "resp_spill_provenance", input: "next",
    });
    expect(previousResponseReplayPrefixLength(expanded)).toBe(3);
    expect(parseRequest(expanded)._contextCompactionBoundary).toBeUndefined();
  });

  test("multibyte resident payload accounting uses complete UTF-8 bytes including provider metadata", () => {
    const realNow = Date.now;
    const at = 1_900_000_000_000;
    Date.now = () => at;
    try {
      const output = [{ role: "assistant", content: "🙂" }];
      const providers = { kiro: { conversationId: "대화🙂" } };
      rememberResponseState(
        { input: "한글🙂" },
        fixedResponse("resp_다국어", output),
        providers,
      );
      const items = [{ role: "user", content: "한글🙂" }, ...output];
      const expected = Buffer.byteLength(JSON.stringify({
        responseId: "resp_다국어", createdAt: at, items, providerOutputStart: 1, providers, selfContained: true,
      }), "utf8");
      expect(getStoredResponseBytesForTests()).toBe(expected);
    } finally {
      Date.now = realNow;
    }
  });

  test("serialization failure rejects the candidate and records a bounded tombstone", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    rememberResponseState({ input: "safe" }, fixedResponse("resp_circular", [circular]));
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, tombstoneCount: 1 });
    const body = { previous_response_id: "resp_circular", input: "delta" };
    expandPreviousResponseInput(body);
    expect(previousResponseReplayFailure(body)?.reason).toBe("spill_failed");

    clearResponseStateForTests();
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_circular_replace", "old".repeat(3_000));
    await flushPendingResponseSpillsForTests();
    const oldFile = spillFileNames(home)[0]!;
    rememberResponseState({ input: "replacement" }, fixedResponse("resp_circular_replace", [circular]));
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, spillStubCount: 0, tombstoneCount: 1 });
    // Old generation unlink is deferred until the replacement tombstone is durable in the snapshot.
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(true);
    await flushResponseState();
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(false);
  });

  test("serialization-failure tombstone still submits to the hard cap (C2-1)", () => {
    setResponseStateByteCapForTests(1);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    rememberResponseState({ input: "safe" }, fixedResponse("resp_tiny_cap_circular", [circular]));
    const metrics = responseStateMetrics();
    expect(metrics.totalBytes).toBeLessThanOrEqual(1);
    expect(metrics.tombstoneCount).toBe(0);
  });

  test("pending spill-unlink deferral is bounded at 128 superseded generations (C2-2)", async () => {
    setSpillIoForTest({ write: undefined });
    setResponseStateByteCapForTests(1_024);
    for (let i = 0; i < 140; i++) {
      rememberLarge("resp_unlink_bound", `payload-${i}-${"x".repeat(4_000)}`);
      await flushPendingResponseSpillsForTests();
    }
    const files = spillFileNames(home);
    expect(files.length).toBeLessThanOrEqual(129);
    expect(files.length).toBeGreaterThan(1);
  }, BULK_DURABLE_IO_BUDGET_MS);

  test("persistNow settles within the bounded rewrite attempts under revision churn", async () => {
    rememberLarge("resp_churn_seed", "seed");
    let attempts = 0;
    setResponseStatePersistAttemptHookForTests(() => {
      attempts += 1;
      rememberLarge(`resp_churn_${attempts}`, `churn-${attempts}`);
    });
    await flushResponseState();
    expect(attempts).toBe(8);
    setResponseStatePersistAttemptHookForTests(null);
    await flushResponseState();
  });

  test("persistent snapshot I/O failure does not schedule background retry passes", async () => {
    const blockedHome = join(home, "not-a-directory");
    writeFileSync(blockedHome, "file blocks config directory creation");
    process.env["OPENCODEX_HOME"] = blockedHome;
    rememberLarge("resp_persist_failure", "payload");
    expect(responseStatePersistPendingForTests()).toBe(true);

    await runPendingResponseStatePersistForTests();

    expect(responseStatePersistPendingForTests()).toBe(false);
  });

  test("background revision churn schedules exactly one follow-up pass", async () => {
    rememberLarge("resp_background_churn_seed", "seed");
    let attempts = 0;
    setResponseStatePersistAttemptHookForTests(() => {
      attempts += 1;
      rememberLarge(`resp_background_churn_${attempts}`, `churn-${attempts}`);
    });

    await runPendingResponseStatePersistForTests();

    expect(attempts).toBe(1);
    expect(responseStatePersistPendingForTests()).toBe(true);
    setResponseStatePersistAttemptHookForTests(null);
    await runPendingResponseStatePersistForTests();
    expect(responseStatePersistPendingForTests()).toBe(false);
  });

  test("unstable final snapshot defers spill unlinks until a stable snapshot", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_unstable_unlink", "old".repeat(3_000));
    await flushResponseState();
    const oldFile = spillFileNames(home)[0]!;
    rememberLarge("resp_unstable_unlink", "new".repeat(3_000));
    await flushPendingResponseSpillsForTests();
    expect(spillFileNames(home)).toHaveLength(2);
    let attempts = 0;
    setResponseStatePersistAttemptHookForTests(() => {
      attempts += 1;
      rememberLarge(`resp_unstable_revision_${attempts}`, `r-${attempts}`);
    });
    await flushResponseState();
    expect(attempts).toBe(8);
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(true);
    setResponseStatePersistAttemptHookForTests(null);
    await flushResponseState();
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(false);
  });

  test("RAM cap demotes the oldest resident before deleting any older spill stub", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_older_stub", "old".repeat(3_000));
    await flushResponseState();
    const oldFile = spillFileNames(home)[0]!;
    setResponseStateByteCapForTests(1_000_000);
    rememberLarge("resp_newer_resident", "new".repeat(1_000));
    expect(responseStateMetrics()).toMatchObject({ residentCount: 1, spillStubCount: 1 });
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_prune_trigger", "trigger");
    await flushPendingResponseSpillsForTests();
    expect(existsSync(join(responseSpillDirectory(home), oldFile))).toBe(true);
    expect(responseStateMetrics().spillStubCount).toBeGreaterThanOrEqual(2);
  });

  test("continuation demotion releases resident bytes minus retained replacement stub bytes", async () => {
    setResponseStateByteCapForTests(1_000_000);
    rememberLarge("resp_budget_net_release", "resident".repeat(1_000));
    const before = responseContinuationRetainedStoreSnapshot();

    evictOldestResponseContinuationForBudget();
    await flushPendingResponseSpillsForTests();
    const after = responseContinuationRetainedStoreSnapshot();

    expect(after.pinnedBytes).toBeGreaterThan(0);
    expect(after.bytes).toBeLessThan(before.bytes);
  });

  test("stub-only over-cap state still deletes bounded metadata oldest-first", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_stub_oldest", "a".repeat(4_000));
    rememberLarge("resp_stub_newer", "b".repeat(4_000));
    await flushPendingResponseSpillsForTests();
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, spillStubCount: 2 });
    setResponseStateByteCapForTests(1);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    rememberResponseState({ input: "trigger" }, fixedResponse("resp_stub_prune", [circular]));
    expect(responseStateMetrics()).toMatchObject({ count: 0, residentCount: 0, spillStubCount: 0, tombstoneCount: 0 });
    expect(spillFileNames(home)).toEqual([]);
  });

  test("write fsync or publication failure cleans its temp and preserves no unmeasured resident payload", async () => {
    const failures = [
      { write: () => { throw new Error("write"); } },
      { fsync: () => { throw new Error("fsync"); } },
      { link: () => { throw Object.assign(new Error("publish"), { code: "EIO" }); } },
    ];
    for (const [index, io] of failures.entries()) {
      clearResponseStateForTests();
      setSpillIoForTest(io);
      setResponseStateByteCapForTests(1_024);
      rememberLarge(`resp_io_failure_${index}`, "x".repeat(8_000));
      await flushPendingResponseSpillsForTests();
      expect(responseStateMetrics()).toMatchObject({ residentCount: 0, tombstoneCount: 1, spillWriteFailures: 1 });
      const dir = responseSpillDirectory(home);
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    }
  });

  test("EEXIST publication loss advances the generation and retries within the bound", async () => {
    let links = 0;
    setSpillIoForTest({
      link(temp, destination) {
        links += 1;
        if (links === 1) throw Object.assign(new Error("lost generation"), { code: "EEXIST" });
        linkSync(temp, destination);
      },
    });
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_eexist", "e".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(links).toBe(2);
    expect(responseStateMetrics()).toMatchObject({ spillStubCount: 1, spillWriteFailures: 0 });
  });

  test("tombstoning a pending-spill replacement cancels the queued job and reclaims its superseded spill", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_pending_tombstone", "a".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(spillFileNames(home)).toHaveLength(1);

    // Queue a replacement spill that inherits G1, then tombstone it with an unmeasurable circular value before settle.
    rememberLarge("resp_pending_tombstone", "b".repeat(8_000));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    rememberResponseState({ input: "tombstone" }, fixedResponse("resp_pending_tombstone", [circular]), undefined, { force: true });

    await flushPendingResponseSpillsForTests();
    await flushResponseState();
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, tombstoneCount: 1 });
    expect(getSpilledResponseBytesForTests()).toBe(0);
    expect(spillFileNames(home)).toEqual([]);
  });

  test("post-publish temp unlink error cleans up the newly published spill destination file", async () => {
    setSpillIoForTest({
      unlink(path) {
        if (path.endsWith(".tmp")) throw Object.assign(new Error("temp unlink denied"), { code: "EACCES" });
        unlinkSync(path);
      },
    });
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_post_publish_fail", "p".repeat(8_000));
    await flushPendingResponseSpillsForTests();
    expect(responseStateMetrics()).toMatchObject({ residentCount: 0, tombstoneCount: 1, spillWriteFailures: 1 });
    expect(spillFileNames(home)).toEqual([]);
  });
});
