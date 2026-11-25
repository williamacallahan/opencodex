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

const log = (body: unknown) => logUnlabelledGenerateShape(enc(body), AGY_JSON_SCANNERS);

describe("unlabelled generate shape", () => {
  test("logs names, types, classes and a size bucket, in the hub's info format", () => {
    log({ project: MARKER, model: "m", requestType: "agent", requestId: MARKER, request: { contents: [{ parts: [{ text: MARKER }] }], sessionId: 5, labels: { request_id: MARKER, cascade_id: MARKER } } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('[opencodex] level=info event=agy.unlabelled_generate_shape top_keys="project,model,requestType,requestId,request" '
      + 'request_keys="contents,sessionId,labels" label_keys="request_id,cascade_id" session_id=number request_type=string/5/other '
      + 'request_type_value=agent trajectory_id=absent body_bytes_bucket=512');
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
    expect(lines[0]).toContain("<other>");
    expect(lines[0]).toContain("request_type_value=absent");
  });

  test("one line per shape, at most 20 lines, and nothing is computed after the cap", () => {
    for (let round = 0; round < 3; round += 1) log({ request: { a: 1 } });
    expect(lines).toHaveLength(1);
    for (let shape = 0; shape < 60; shape += 1) log({ request: { [`field_${shape}`]: 1 } });
    expect(lines).toHaveLength(20);
    const bytes = enc({ request: { never_seen: 1 } });
    let reads = 0;
    const counting = { skipWs: (b: Uint8Array, p: number) => { reads += 1; return AGY_JSON_SCANNERS.skipWs(b, p); }, scanStr: AGY_JSON_SCANNERS.scanStr, skipVal: AGY_JSON_SCANNERS.skipVal };
    logUnlabelledGenerateShape(bytes, counting);
    expect(reads).toBe(0);
    expect(lines).toHaveLength(20);
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
