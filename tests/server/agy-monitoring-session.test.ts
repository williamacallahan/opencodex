/** The per-caller map from agy session ids to a trajectory, and its counter line. Ids are made up. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  agyMonitoringStateForTests, MAX_SESSION_IDENTITIES, rememberAgySession, resetAgyMonitoringStateForTests, resolveMonitoringSession,
  SESSION_IDENTITY_TTL_MS,
} from "../../src/server/agy-monitoring-session";
import { scanAgyBody } from "../../src/server/agy-passthrough";

const trajectory = "3f0b6c1e-8d2a-4b7e-9c51-2a6d8e4f1b07";
const cascade = "9a7c2e4b-1f3d-4c8a-b6e2-5d0f7a1c3e94";
const root = "c4e81a2f-6b9d-4e07-a3c5-8f2b1d6e9a40";
const asked = (uuid: string) => `agent_monitoring/${uuid}`;
let lines: string[];
let info: ReturnType<typeof spyOn>;
beforeEach(() => {
  resetAgyMonitoringStateForTests();
  lines = [];
  info = spyOn(console, "info").mockImplementation((line: unknown) => { lines.push(String(line)); });
});
afterEach(() => info.mockRestore());

describe("agy session identities", () => {
  test("each id the labelled request named resolves to its trajectory, for that caller only", () => {
    rememberAgySession("a", { trajectory, cascade, root });
    for (const id of [trajectory, cascade, root, trajectory.toUpperCase()]) expect(resolveMonitoringSession("a", asked(id))).toBe(trajectory);
    expect(resolveMonitoringSession("b", asked(trajectory))).toBeUndefined();
    expect(resolveMonitoringSession("a", asked("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"))).toBeUndefined();
    expect(agyMonitoringStateForTests().counts).toEqual({ matched_trajectory: 2, matched_cascade: 1, matched_root_cascade: 1, unmatched: 2, no_request_id_uuid: 0 });
  });

  test("a subagent naming the same root does not take the root agent's id over", () => {
    const sub = "5b1d9e3f-2a4c-4d6e-8f01-7a3b5c9d1e2f";
    const otherTrajectory = "0d2f4a6c-8e1b-4c3d-9a5f-1b7e3d9c5a20";
    rememberAgySession("a", { trajectory, cascade: root, root });
    rememberAgySession("a", { trajectory: otherTrajectory, cascade: sub, root });
    expect(resolveMonitoringSession("a", asked(root))).toBe(trajectory);
    expect(resolveMonitoringSession("a", asked(sub))).toBe(otherTrajectory);
    expect(resolveMonitoringSession("a", asked(otherTrajectory))).toBe(otherTrajectory);
  });

  test("only a request id of the monitoring shape is looked up", () => {
    rememberAgySession("a", { trajectory });
    for (const bad of [undefined, trajectory, `a-b/${trajectory}`, `mode/${trajectory}x`, `${"m".repeat(33)}/${trajectory}`, `mode/${trajectory}/more`]) {
      expect(resolveMonitoringSession("a", bad)).toBeUndefined();
    }
    expect(agyMonitoringStateForTests().counts.no_request_id_uuid).toBe(6);
  });

  test("an entry expires six hours after its last use, and use renews it", () => {
    const t0 = 1_000_000;
    rememberAgySession("a", { trajectory }, t0);
    expect(resolveMonitoringSession("a", asked(trajectory), t0 + SESSION_IDENTITY_TTL_MS - 1)).toBe(trajectory);
    expect(resolveMonitoringSession("a", asked(trajectory), t0 + 2 * SESSION_IDENTITY_TTL_MS - 2)).toBe(trajectory);
    expect(resolveMonitoringSession("a", asked(trajectory), t0 + 3 * SESSION_IDENTITY_TTL_MS)).toBeUndefined();
    expect(agyMonitoringStateForTests().size).toBe(0);
  });

  test("the map holds 4,096 entries and evicts the least recently used", () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
    for (let n = 0; n < MAX_SESSION_IDENTITIES; n += 1) rememberAgySession("a", { trajectory: uuid(n) });
    expect(resolveMonitoringSession("a", asked(uuid(0)))).toBe(uuid(0));
    rememberAgySession("a", { trajectory: uuid(MAX_SESSION_IDENTITIES) });
    expect(agyMonitoringStateForTests().size).toBe(MAX_SESSION_IDENTITIES);
    expect(resolveMonitoringSession("a", asked(uuid(1)))).toBeUndefined();
    expect(resolveMonitoringSession("a", asked(uuid(0)))).toBe(uuid(0));
  });

  test("the counter line carries numbers only, at most every ten minutes and only when counts changed", () => {
    const t0 = 5_000_000;
    rememberAgySession("a", { trajectory }, t0);
    resolveMonitoringSession("a", asked(trajectory), t0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("[opencodex] level=info event=agy.monitoring_session_match matched_trajectory=1 matched_cascade=0 matched_root_cascade=0 unmatched=0 no_request_id_uuid=0 map_size=1");
    resolveMonitoringSession("a", asked(trajectory), t0 + 60_000);
    expect(lines).toHaveLength(1);
    resolveMonitoringSession("a", asked(trajectory), t0 + 10 * 60_000 + 1);
    expect(lines).toHaveLength(2);
    resolveMonitoringSession("a", asked(trajectory), t0 + 30 * 60_000);
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain(trajectory);
  });
});

describe("the scan feeds the map in its one walk", () => {
  const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const generate = "/v1internal:streamGenerateContent";

  test("a labelled body yields its ids and no request id; an unlabelled one yields its request id", () => {
    const ids = {};
    scanAgyBody(enc({ project: "p", requestId: asked(cascade), request: { labels: { trajectory_id: trajectory, cascade_id: cascade, root_cascade_id: root } } }), generate, ids);
    expect(ids).toEqual({ trajectory, cascade, root });
    const unlabelled = {};
    const result = scanAgyBody(enc({ project: "p", requestId: asked(cascade), request: { contents: [], generationConfig: {} } }), generate, unlabelled);
    expect(unlabelled).toEqual({ requestId: asked(cascade) });
    expect(result).toEqual({ project: "p" });
  });

  test("a request id after the request, an over-long or non-string one, and a non-generate call", () => {
    const after = {};
    scanAgyBody(enc({ project: "p", request: { contents: [] }, requestId: asked(cascade) }), generate, after);
    expect(after).toEqual({ requestId: asked(cascade) });
    for (const requestId of ["x".repeat(201), 5, null, { a: 1 }]) {
      const ids: { requestId?: string } = {};
      scanAgyBody(enc({ project: "p", requestId, request: {} }), generate, ids);
      expect(ids.requestId).toBeUndefined();
    }
    const other = {};
    scanAgyBody(enc({ project: "p", requestId: asked(cascade) }), "/v1internal:loadCodeAssist", other);
    expect(other).toEqual({});
  });

  test("a labelled body stops before a trailing top-level request id is read", () => {
    const ids = {};
    const body = `{"project":"p","request":{"labels":{"trajectory_id":"${trajectory}"}},"requestId":"agent_monitoring/${cascade}","tail":{{{ broken`;
    expect(scanAgyBody(new TextEncoder().encode(body), generate, ids).session).toBe(trajectory);
    expect(ids).toEqual({ trajectory });
  });
});
