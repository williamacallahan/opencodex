/**
 * The content-free diagnostic for agy generate requests that carry no session. Fixture values are made up;
 * `MARKER` stands for anything that must never reach a log line.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AGY_JSON_SCANNERS, scanAgyBody } from "../../src/server/agy-passthrough";
import { logUnlabelledGenerateShape, resetUnlabelledShapeLogForTests } from "../../src/server/agy-unlabelled-shape";

const MARKER = "zz-secret-marker-9431";
const enc = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
let lines: string[];
let info: ReturnType<typeof spyOn>;

beforeEach(() => {
  resetUnlabelledShapeLogForTests();
  lines = [];
  info = spyOn(console, "info").mockImplementation((line: unknown) => { lines.push(String(line)); });
});
afterEach(() => info.mockRestore());

const readsOf = (bytes: Uint8Array): number => {
  let reads = 0;
  logUnlabelledGenerateShape(bytes, { ...AGY_JSON_SCANNERS, skipWs: (b, p) => { reads += 1; return AGY_JSON_SCANNERS.skipWs(b, p); } });
  return reads;
};
const log = (body: unknown) => logUnlabelledGenerateShape(enc(body), AGY_JSON_SCANNERS);

describe("unlabelled generate shape", () => {
  test("logs names, types, classes and a size bucket, in the hub's info format", () => {
    log({ project: MARKER, model: "m", requestType: "agent", requestId: MARKER, request: { contents: [{ parts: [{ text: MARKER }] }], sessionId: 5, labels: { request_id: MARKER, cascade_id: MARKER } } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('[opencodex] level=info event=agy.unlabelled_generate_shape top_keys="project,model,requestType,requestId,request" '
      + 'request_keys="contents,sessionId,labels" label_keys="request_id,cascade_id" session_id=number request_type=string/5/other '
      + 'request_type_value=agent trajectory_id=absent request_id_pattern=other body_bytes_bucket=512');
  });

  test("string classes", () => {
    const classes = (value: string) => { lines.length = 0; resetUnlabelledShapeLogForTests(); log({ request: { sessionId: value } }); return lines[0]!.match(/session_id=(\S+)/)![1]; };
    expect(classes("-1234567890123456789")).toBe("string/20/signed-digits");
    expect(classes("1234")).toBe("string/4/digits");
    expect(classes("ab12cd")).toBe("string/6/hex");
    expect(classes("")).toBe("string/0/empty");
    expect(classes("3f0b6c1e-8d2a-4b7e-9c51-2a6d8e4f1b07")).toBe("string/36/uuid");
    expect(classes(MARKER)).toBe(`string/${MARKER.length}/other`);
  });

  test("no value, odd key, project, id or prompt text reaches the line", () => {
    log({ project: MARKER, requestType: `${MARKER} mode`, [`${MARKER}-key`]: 1, [`bad key ${MARKER}`]: 2, "\\u0041": 3,
      request: { sessionId: MARKER, [`${MARKER}`]: { a: MARKER }, labels: { trajectory_id: `${MARKER}${MARKER}${MARKER}${MARKER}${MARKER}${MARKER}${MARKER}${MARKER}`, [`x-${MARKER}`]: MARKER } } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(MARKER);
    expect(lines[0]).toContain("top_keys=\"project,requestType,other,other,other,request\"");
    expect(lines[0]).toContain("request_type_value=other");
  });

  test("a caller-chosen key name or mode never reaches the line, even when it is spelled like a field name", () => {
    // Each passes the identifier and mode-name checks an earlier version used to decide what to copy verbatim.
    const word = "zzsecretmarker";
    log({ [word]: 1, requestType: word, requestId: `${word}::--//..__`,
      request: { [`${word}_body`]: 1, contents: [], labels: { [`${word}_label`]: MARKER } } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(word);
    expect(lines[0]).not.toContain("::");
    expect(lines[0]).toContain('top_keys="other,requestType,requestId,request"');
    expect(lines[0]).toContain('request_keys="other,contents,labels" label_keys=other');
    expect(lines[0]).toContain("request_type_value=other");
    expect(lines[0]).toContain("request_id_pattern=other");
  });

  test("the request id is logged only as a closed format label", () => {
    const format = (requestId: unknown) => { resetUnlabelledShapeLogForTests(); lines.length = 0; log({ requestId, request: { contents: [] } }); return lines[0]!.match(/request_id_pattern=(\S+)/)![1]; };
    const uuid = "3f0b6c1e-8d2a-4b7e-9c51-2a6d8e4f1b07";
    expect(format(uuid)).toBe("uuid");
    expect(format(`agent_monitoring/${uuid}`)).toBe("word/uuid");
    expect(format(`agent-${uuid}`)).toBe("word-uuid");
    expect(format("1234")).toBe("digits");
    expect(format("ab12cd")).toBe("hex");
    expect(format("")).toBe("empty");
    expect(format("agent/1234:5678_x.é")).toBe("other");
    expect(format(MARKER)).toBe("other");
    expect(lines.join("\n")).not.toContain(MARKER);
    expect(format("x".repeat(201))).toBe("toolong");
    expect(format(12345)).toBe("absent");
    expect(format(null)).toBe("absent");
    expect(format(undefined)).toBe("absent");
  });

  test("the request id pattern is not part of the shape, since its UUID varies per request", () => {
    log({ requestId: "ab-12", request: { a: 1 } });
    log({ requestId: "cd/9f", request: { a: 1 } });
    expect(lines).toHaveLength(1);
  });

  test("one line per shape, at most 8 lines, and the body is not read once the line cap is reached", () => {
    for (let round = 0; round < 3; round += 1) log({ request: { a: 1 } });
    expect(lines).toHaveLength(1);
    // Unknown names all read `other`, so shapes differ by how many there are.
    for (let shape = 0; shape < 30; shape += 1) log({ request: Object.fromEntries(Array.from({ length: shape + 2 }, (_, i) => [`field_${i}`, 1])) });
    expect(lines).toHaveLength(8);
    expect(readsOf(enc({ request: { never_seen: 1 } }))).toBe(0);
  });

  test("a body walked again for an already-seen shape counts, so a process walks at most 64 bodies", () => {
    let walked = 0;
    const counting = { ...AGY_JSON_SCANNERS, skipWs: (b: Uint8Array, p: number) => { walked += 1; return AGY_JSON_SCANNERS.skipWs(b, p); } };
    const bytes = enc({ request: { same: 1 } });
    for (let call = 0; call < 500; call += 1) logUnlabelledGenerateShape(bytes, counting);
    expect(lines).toHaveLength(1);
    const walksAfterBudget = walked;
    logUnlabelledGenerateShape(bytes, counting);
    expect(walked).toBe(walksAfterBudget);
    resetUnlabelledShapeLogForTests();
    walked = 0;
    for (let call = 0; call < 64; call += 1) logUnlabelledGenerateShape(bytes, counting);
    const full = walked;
    for (let call = 0; call < 64; call += 1) logUnlabelledGenerateShape(bytes, counting);
    expect(walked).toBe(full);
  });

  test("a labelled body is not a shape to log, and the scan says so", () => {
    const labelled = enc({ request: { labels: { trajectory_id: "3f0b6c1e-8d2a-4b7e-9c51-2a6d8e4f1b07" } } });
    expect(scanAgyBody(labelled, "/v1internal:streamGenerateContent").session).toBeDefined();
  });

  test("malformed bodies log nothing and do not throw", () => {
    for (const body of ["", "not json", "[]", '{"request":{"a" 1}}', '{"request":{"a":1', '{"a":']) {
      expect(() => log(body)).not.toThrow();
    }
    expect(lines).toEqual([]);
  });
});
