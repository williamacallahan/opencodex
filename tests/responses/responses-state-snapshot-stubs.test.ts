import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushResponseState,
  rememberResponseState,
  previousResponseReplayFailure,
  responseStateMetrics,
  setResponseStateByteCapForTests,
  setResponseStateSnapshotByteCapForTests,
  type StoredResponseState,
} from "../../src/responses/state";
import { responseSpillDirectory } from "../../src/responses/spill-store";
import { setPlatformForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function fixedResponse(id: string, output: unknown[]): { id: string; output: unknown[]; status: string } {
  return { id, output, status: "completed" };
}

function rememberLarge(id: string, text: string): void {
  rememberResponseState(
    { model: "test/model", input: text, store: false },
    fixedResponse(id, [{ type: "message", role: "assistant", content: text }]),
    undefined,
    { force: true },
  );
}

describe("Responses snapshot spill stub retention", () => {
  // Sandbox OPENCODEX_HOME: the state store snapshots to disk, and these tests must never
  // touch the real ~/.opencodex.
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-state-snapshot-test-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
    // Generic cases assert the synchronous spill lane. A Windows host would otherwise route
    // them through the queued async publication and they would read stale state.
    setPlatformForTests("linux");
  });

  afterEach(() => {
    setPlatformForTests(null);
    setResponseStateByteCapForTests(null);
    setResponseStateSnapshotByteCapForTests(null);
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  test.each([false, true])("restart cannot promote an upstream append to full history (spilled: %s)", async spilled => {
    setResponseStateByteCapForTests(spilled ? 1_024 : 1_000_000);
    rememberResponseState({ conversation: "upstream-only-history", input: "x".repeat(2_048) }, fixedResponse("resp_append", []));
    expect(responseStateMetrics().spillStubCount).toBe(spilled ? 1 : 0);
    await flushResponseState(); clearResponseStateMemoryForTests();
    const delta = { previous_response_id: "resp_append", input: "next" };
    expect(expandPreviousResponseInput(delta)).toBe(delta);
    expect(previousResponseReplayFailure(delta)?.reason).toBe("upstream_history");
  });

  test("a restart keeps spilled continuations replayable when residents fill the snapshot budget", async () => {
    setResponseStateSnapshotByteCapForTests(8_192);
    // Demote two older entries to durable spill; demotion is oldest-first, so
    // these sit at the tail of the newest-first snapshot selection.
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_spill_oldest", "a".repeat(2_048));
    rememberLarge("resp_spill_second", "b".repeat(2_048));
    expect(responseStateMetrics().spillStubCount).toBe(2);
    const spillDir = responseSpillDirectory();
    const stubFileNames = readdirSync(spillDir).filter(name => name.endsWith(".spill.json"));
    expect(stubFileNames).toBeArrayOfSize(2);

    // Newer resident payloads together exceed the snapshot budget; each is still
    // under the 2 MiB per-entry cap that would exclude it individually.
    setResponseStateByteCapForTests(null);
    rememberLarge("resp_resident_older", "r".repeat(2_600));
    rememberLarge("resp_resident_newest", "s".repeat(2_600));
    expect(responseStateMetrics().residentCount).toBe(2);
    await flushResponseState();

    // The stubs are the only durable references the spill files have: the
    // snapshot must still name them even when the budget cannot hold the
    // newest residents as well.
    const snapshotText = readFileSync(join(home, "responses-state.json"), "utf8");
    for (const fileName of stubFileNames) {
      expect(snapshotText).toContain(fileName);
    }

    clearResponseStateMemoryForTests();
    for (const [id, payload] of [["resp_spill_oldest", "aaaa"], ["resp_spill_second", "bbbb"]] as const) {
      const replay = JSON.stringify(expandPreviousResponseInput({
        previous_response_id: id,
        input: "next",
      }));
      expect(replay).toContain(payload);
    }
    // The stubs survive the reload, and their files remain on disk for replay.
    expect(responseStateMetrics().spillStubCount).toBe(2);
    for (const fileName of stubFileNames) {
      expect(existsSync(join(spillDir, fileName))).toBe(true);
    }
    // The newest resident still wins the remaining budget.
    const newestReplay = JSON.stringify(expandPreviousResponseInput({
      previous_response_id: "resp_resident_newest",
      input: "next",
    }));
    expect(newestReplay).toContain("ssss");
  });

  test("randomized resident-cap pruning retains the same continuations and spill references", async () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    setResponseStateByteCapForTests(1_000_000);
    const ids = Array.from({ length: 24 }, (_, index) => `resp_random_${String(index).padStart(2, "0")}`);
    for (const id of ids) rememberLarge(id, "x".repeat(400 + Math.floor(random() * 1_600)));
    // Same-id replacements move entries behind their older neighbors in map order.
    for (const index of [1, 4, 9, 15, 20]) {
      rememberLarge(ids[index]!, `replacement-${index}-${"r".repeat(400 + Math.floor(random() * 1_600))}`);
    }
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_random_trigger", "trigger");
    await flushResponseState();

    const snapshot = JSON.parse(readFileSync(join(home, "responses-state.json"), "utf8")) as {
      states: Array<[string, StoredResponseState]>;
    };
    const expectedPayloads = new Map([
      ["resp_random_15", "replacement-15-"],
      ["resp_random_20", "replacement-20-"],
      ["resp_random_trigger", "trigger"],
    ]);
    expect(snapshot.states.map(([id]) => id)).toEqual([...expectedPayloads.keys()]);
    const spillFileNames: string[] = [];
    for (const [id, entry] of snapshot.states) {
      expect(entry.kind).toBe("spill");
      if (entry.kind !== "spill") continue;
      spillFileNames.push(entry.spill.fileName);
      const replay = JSON.stringify(expandPreviousResponseInput({ previous_response_id: id, input: "next" }));
      expect(replay).toContain(expectedPayloads.get(id));
    }
    expect(readdirSync(responseSpillDirectory(home)).filter(name => name.endsWith(".spill.json")).sort())
      .toEqual(spillFileNames.sort());
  });
});
