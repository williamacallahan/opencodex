/**
 * `scanAgyBody`: the one walk over an agy request body that yields the routing project and the agy session.
 * Fixture ids are made up for these cases.
 */
import { describe, expect, test } from "bun:test";
import { scanAgyBody } from "../../src/server/agy-passthrough";

const enc = (text: string) => new TextEncoder().encode(text);
const generate = "/v1internal:streamGenerateContent";
const acl = "/v1internal:writeTrajectoryAcls";
const trajectory = "3f0b6c1e-8d2a-4b7e-9c51-2a6d8e4f1b07";
const cascade = "9a7c2e4b-1f3d-4c8a-b6e2-5d0f7a1c3e94";
const root = "c4e81a2f-6b9d-4e07-a3c5-8f2b1d6e9a40";
const project = (body: string) => scanAgyBody(enc(body), generate).project;

describe("routing project", () => {
  test("is the first top-level string value of project and nothing else", () => {
    expect(project('{"project":"example-project","model":"m"}')).toBe("example-project");
    expect(project('{"request":{"project":"nested"},"project":"top"}')).toBe("top");
    expect(project('{"arr":[{"project":"inner"}],"project":"top"}')).toBe("top");
    expect(project('{"note":"\\"project\\":\\"in-string\\"","project":"top"}')).toBe("top");
    expect(project('{"project":"first","project":"second"}')).toBe("first");
    expect(project('{"project":"first","request":{"labels":{}},"project":"second"}')).toBe("first");
    expect(project('{"\\u0070roject":"escaped-key"}')).toBe("escaped-key");
    expect(project('{"project":"a\\/b\\tc"}')).toBe("a/b\tc");
    expect(project('{"project":"first","project":123}')).toBe("first");
  });

  test("is undefined for an absent, non-string, empty, nested-only, array, non-JSON or truncated body", () => {
    for (const body of ['{"model":"m"}', '{"project":123}', '{"project":null}', '{"project":{"a":1}}', '{"project":""}',
      '{"request":{"project":"only-nested"}}', '[{"project":"x"}]', "[]", "not json", "", "{", '{"project":"unterminated', '{"project']) {
      expect(project(body)).toBeUndefined();
    }
    expect(project('{"project":123,"project":"second"}')).toBeUndefined();
  });

  test("survives a body that ends right after the value", () => {
    expect(project('{"project":"kept"')).toBe("kept");
    expect(project('{"project":"kept",')).toBe("kept");
  });

  test("is found whether it precedes or follows a large request", () => {
    const contents = `"contents":[{"parts":[{"text":"${"x".repeat(200_000)}"}]}]`;
    expect(project(`{"project":"before","request":{${contents}}}`)).toBe("before");
    expect(project(`{"request":{${contents},"labels":{"trajectory_id":"${trajectory}"}},"project":"after"}`)).toBe("after");
  });
});

describe("session and agent", () => {
  const scan = (body: unknown, method = generate) => scanAgyBody(enc(JSON.stringify(body)), method);

  test("labels placed after large contents are still read", () => {
    const contents = [{ role: "user", parts: [{ text: "x".repeat(300_000) }] }];
    const result = scan({ project: "example-project", request: { contents, labels: { trajectory_id: trajectory, cascade_id: cascade, root_cascade_id: root } } });
    expect(result).toEqual({ project: "example-project", session: trajectory, agent: cascade });
  });

  test("a string that spells out request labels is not the field", () => {
    const decoy = `"request":{"labels":{"trajectory_id":"${trajectory}"}}`;
    expect(scan({ project: "example-project", note: decoy, request: { text: decoy } })).toEqual({ project: "example-project" });
    expect(scan({ request: { contents: [{ text: decoy }], sessionId: "42" } }).session).toBe("42");
  });

  test("the decimal sessionId is the fallback and accepts the Cloud Code leading minus", () => {
    expect(scan({ request: { sessionId: "1234567890123456789" } }).session).toBe("1234567890123456789");
    expect(scan({ request: { sessionId: "-1234567890123456789" } }).session).toBe("1234567890123456789");
    for (const bad of ["--1", "-", "12ab", "", "1".repeat(33), "+5", " 5"]) expect(scan({ request: { sessionId: bad } })).toEqual({});
    expect(scan({ request: { sessionId: 5 } })).toEqual({});
    expect(scan({ request: { labels: { trajectory_id: trajectory }, sessionId: "7" } }).session).toBe(trajectory);
    expect(scan({ request: { labels: { trajectory_id: "nope" }, sessionId: "-7" } }).session).toBe("7");
  });

  test("the cascade is an agent only beside a different canonical root", () => {
    const labels = (extra: Record<string, string>) => ({ request: { labels: { trajectory_id: trajectory, cascade_id: cascade, ...extra } } });
    expect(scan(labels({ root_cascade_id: root })).agent).toBe(cascade);
    expect(scan(labels({})).agent).toBeUndefined();
    expect(scan(labels({ root_cascade_id: cascade.toUpperCase() })).agent).toBeUndefined();
    expect(scan(labels({ root_cascade_id: "not-a-uuid" })).agent).toBeUndefined();
  });

  test("writeTrajectoryAcls falls back to its top-level trajectoryId, and no other call does", () => {
    expect(scan({ trajectoryId: trajectory }, acl).session).toBe(trajectory);
    expect(scan({ trajectoryId: trajectory, request: { sessionId: "9" } }, acl).session).toBe("9");
    expect(scan({ request: { labels: { trajectory_id: cascade } }, trajectoryId: trajectory }, acl).session).toBe(cascade);
    expect(scan({ trajectoryId: "t" }, acl).session).toBeUndefined();
    expect(scan({ trajectoryId: trajectory }).session).toBeUndefined();
  });

  test("duplicate keys resolve to the first, and a non-object request or labels yields nothing", () => {
    expect(scanAgyBody(enc(`{"request":{"labels":{"trajectory_id":"${trajectory}"}},"request":{"sessionId":"1"}}`), generate).session).toBe(trajectory);
    expect(scanAgyBody(enc(`{"request":{"labels":"x","labels":{"trajectory_id":"${trajectory}"}}}`), generate).session).toBeUndefined();
    expect(scan({ request: [1], project: "example-project" })).toEqual({ project: "example-project" });
  });

  test("never throws on a body cut at any byte or on broken escapes", () => {
    const whole = enc(JSON.stringify({ project: "example-project", request: { contents: ['\\"é'], labels: { trajectory_id: trajectory, cascade_id: cascade, root_cascade_id: root }, sessionId: "5" } }));
    for (let cut = 0; cut <= whole.length; cut += 1) expect(() => scanAgyBody(whole.subarray(0, cut), acl)).not.toThrow();
    for (const junk of ['{"a":"\\', '{"a":"\\u12', '{"\\ud800":1}', '{"request":{"labels":{"trajectory_id":', "\u0000{", "{}}}"]) {
      expect(() => scanAgyBody(enc(junk), acl)).not.toThrow();
    }
  });

  test("per-request ids stay out of the result", () => {
    const result = scan({ requestId: "per-request-9", request: { labels: { trajectory_id: trajectory, request_id: "per-request-8" } } });
    expect(JSON.stringify(result)).not.toContain("per-request");
  });
});
