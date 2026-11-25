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

/** REFERENCE IMPLEMENTATION: the project lookup from c03d7feb6^ (before the one-pass scan), copied verbatim apart from renames. */
const utf8Decoder = new TextDecoder();
function refSkipWs(bytes: Uint8Array, pos: number): number {
  while (pos < bytes.length) {
    const b = bytes[pos]!;
    if (b !== 0x20 && b !== 0x09 && b !== 0x0A && b !== 0x0D) break;
    pos += 1;
  }
  return pos;
}

function refScanStr(bytes: Uint8Array, start: number): { end: number; escaped: boolean } | null {
  if (bytes[start] !== 0x22) return null;
  let escaped = false;
  let pos = start + 1;
  while (pos < bytes.length) {
    const b = bytes[pos]!;
    if (b === 0x5C) {
      escaped = true;
      pos += 2;
      continue;
    }
    if (b === 0x22) return { end: pos, escaped };
    pos += 1;
  }
  return null;
}

function refSkipVal(bytes: Uint8Array, start: number): number {
  const b = bytes[start];
  if (b === undefined) return -1;
  if (b === 0x22) {
    const str = refScanStr(bytes, start);
    return str ? str.end + 1 : -1;
  }
  if (b === 0x7B || b === 0x5B) {
    let depth = 1;
    let pos = start + 1;
    while (pos < bytes.length && depth > 0) {
      const ch = bytes[pos]!;
      if (ch === 0x22) {
        const str = refScanStr(bytes, pos);
        if (!str) return -1;
        pos = str.end + 1;
        continue;
      }
      if (ch === 0x7B || ch === 0x5B) depth += 1;
      else if (ch === 0x7D || ch === 0x5D) depth -= 1;
      pos += 1;
    }
    return depth === 0 ? pos : -1;
  }
  let pos = start;
  while (pos < bytes.length) {
    const ch = bytes[pos]!;
    if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D || ch === 0x2C || ch === 0x7D || ch === 0x5D) break;
    pos += 1;
  }
  return pos > start ? pos : -1;
}

/** The byte range `[start, end)` of one top-level member's value in a JSON object, without building an AST. */
function refTopLevelJsonValue(bytes: Uint8Array, field: string): { start: number; end: number } | undefined {
  let pos = refSkipWs(bytes, 0);
  if (bytes[pos] !== 0x7B) return undefined;
  pos += 1;
  const fieldBytes = Buffer.from(field, "utf8");
  while (pos < bytes.length) {
    pos = refSkipWs(bytes, pos);
    if (bytes[pos] === 0x7D) return undefined;
    const keyToken = refScanStr(bytes, pos);
    if (!keyToken) return undefined;
    let matched = false;
    if (!keyToken.escaped) {
      const rawKeyLen = keyToken.end - (pos + 1);
      if (rawKeyLen === fieldBytes.length) {
        matched = true;
        for (let i = 0; i < rawKeyLen; i += 1) {
          if (bytes[pos + 1 + i] !== fieldBytes[i]) {
            matched = false;
            break;
          }
        }
      }
    } else {
      try {
        matched = JSON.parse(utf8Decoder.decode(bytes.subarray(pos, keyToken.end + 1))) === field;
      } catch {
        return undefined;
      }
    }
    pos = refSkipWs(bytes, keyToken.end + 1);
    if (bytes[pos] !== 0x3A) return undefined;
    pos = refSkipWs(bytes, pos + 1);
    if (pos >= bytes.length) return undefined;
    const valueEnd = refSkipVal(bytes, pos);
    if (valueEnd < 0) return undefined;
    if (matched) return { start: pos, end: valueEnd };
    pos = refSkipWs(bytes, valueEnd);
    if (bytes[pos] === 0x2C) {
      pos += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Extract one top-level string field from raw UTF-8 JSON bytes without constructing
 * an AST or decoding the whole request buffer into UTF-16.
 */
function referenceProject(bytes: Uint8Array, field: string): string | undefined {
  const range = refTopLevelJsonValue(bytes, field);
  if (!range || bytes[range.start] !== 0x22) return undefined;
  const valToken = refScanStr(bytes, range.start);
  if (!valToken) return undefined;
  if (!valToken.escaped) {
    if (valToken.end === range.start + 1) return undefined;
    return utf8Decoder.decode(bytes.subarray(range.start + 1, valToken.end));
  }
  try {
    const value: unknown = JSON.parse(utf8Decoder.decode(bytes.subarray(range.start, valToken.end + 1)));
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

describe("routing project never differs from the reference", () => {
  const ref = (body: string) => referenceProject(enc(body), "project");
  const agree = (body: string) => {
    const got = project(body);
    const want = ref(body);
    if (got !== undefined) expect(got).toBe(want!);
    return got;
  };

  test("the reviewed differentials", () => {
    expect(agree('{"request":{"a":1{},"project":"evil"},"project":"real"}')).not.toBe("evil");
    expect(agree('{"request":{"a" 1},"project":"real"}')).toBe("real");
    expect(agree('{"request":{"\\x":1},"project":"real"}')).toBe("real");
  });

  test("malformed and unusual shapes", () => {
    const cases = [
      '{"\\x":1,"project":"p"}', '{"project":"p"}garbage', '{"project":"p","request":{"labels":{"trajectory_id":"x"},"sessionId":"5"}}\u0000\u0001junk{{{',
      ' \n\t{"project":"p"}', '\ufeff{"project":"p"}', '{\n  "project": "p",\n  "request": {\n    "sessionId": "5"\n  }\n}',
      '{"request":"s","project":"p"}', '{"request":null,"project":"p"}', '{"request":12,"project":"p"}',
      '{"request":{"a":1},"request":{"project":"n"},"project":"p"}', '{"projectId":"x","requests":{},"project":"p"}',
      '{"\\u0072equest":{"project":"n"},"project":"p"}', '{"request":{"a":1e+5,"project":"n"},"project":"p"}',
      `{"request":${"[".repeat(2000)}${"]".repeat(2000)},"project":"p"}`, `{"request":${'{"a":'.repeat(2000)}1${"}".repeat(2000)},"project":"p"}`,
    ];
    for (const body of cases) agree(body);
    expect(project(cases[cases.length - 1]!)).toBe("p");
    expect(project('{"projectId":"x","requests":{},"project":"p"}')).toBe("p");
    expect(project('{"request":{"a":1e+5,"project":"n"},"project":"p"}')).toBe("p");
    expect(project('{"request":"s","project":"p"}')).toBe("p");
    expect(project('{"request":null,"project":"p"}')).toBe("p");
    expect(project('{"request":12,"project":"p"}')).toBe("p");
    expect(project('{"request":{"a":1},"request":{"project":"n"},"project":"p"}')).toBe("p");
    expect(project('{"\\u0072equest":{"project":"n"},"project":"p"}')).toBe("p");
    expect(project('{\n  "project": "p",\n  "request": {\n    "sessionId": "5"\n  }\n}')).toBe("p");
    expect(project(' \n\t{"project":"p"}')).toBe("p");
  });

  test("an unreadable key escape aborts the walk, as before", () => {
    expect(ref('{"\\x":1,"project":"p"}')).toBeUndefined();
    expect(project('{"\\x":1,"project":"p"}')).toBeUndefined();
    expect(project('\ufeff{"project":"p"}')).toBeUndefined();
  });

  test("property: over generated valid and mutated bodies the project is the reference's or undefined, and the scan never throws", () => {
    let seed = 20261124;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const alphabet = ["{", "}", "[", "]", '"', ":", ",", "\\", "1", "a", " ", "\n", "\t"];
    const requests = ['{}', '{"a":1}', '{"labels":{"trajectory_id":"3f0b6c1e-8d2a-4b7e-9c51-2a6d8e4f1b07"},"sessionId":"5"}', '{"a":[1,{"b":"c"}],"project":"nested"}', '"s"', 'null', '12', '[1,2]', '{"a":"x\\"y"}'];
    const projects = ['"project":"real"', '"project":"real","project":"dup"', '"\\u0070roject":"esc"', '"project":""', '"project":7',
      '"requestId":"agent_monitoring/3f0b6c1e-8d2a-4b7e-9c51-2a6d8e4f1b07","project":"real"', '"project":"real","requestId":"m/u"', '"requestId":{"project":"inner"},"project":"real"'];
    const build = (): string => {
      const request = `"request":${pick(requests)}`;
      const head = pick(projects);
      switch (Math.floor(random() * 4)) {
        case 0: return `{${head},${request}}`;
        case 1: return `{${request},${head}}`;
        case 2: return `{"request":${pick(requests).replace(/\}$/, `,${head}}`)},"model":"m"}`;
        default: return `{"model":"m",${request},${head},"z":1}`;
      }
    };
    const mutate = (body: string): string => {
      let text = body;
      for (let edits = Math.floor(random() * 3); edits >= 0; edits -= 1) {
        const at = Math.floor(random() * (text.length + 1));
        const kind = Math.floor(random() * 3);
        if (kind === 0) text = text.slice(0, at) + text.slice(at + 1);
        else if (kind === 1) text = text.slice(0, at) + text.slice(at, at + 1) + text.slice(at);
        else text = text.slice(0, at) + pick(alphabet) + text.slice(at);
      }
      return text;
    };
    const total = 30_000;
    let malformed = 0;
    let found = 0;
    for (let i = 0; i < total; i += 1) {
      const valid = build();
      const body = random() < 0.2 ? valid : mutate(valid);
      try { JSON.parse(body); } catch { malformed += 1; }
      const bytes = enc(body);
      let scanned: ReturnType<typeof scanAgyBody>;
      try { scanned = scanAgyBody(bytes, i % 2 ? acl : generate, {}); } catch (error) { throw new Error(`threw on ${JSON.stringify(body)}: ${String(error)}`); }
      const want = referenceProject(bytes, "project");
      if (scanned.project !== undefined) {
        if (scanned.project !== want) throw new Error(`differs on ${JSON.stringify(body)}: got ${scanned.project}, reference ${String(want)}`);
        found += 1;
      }
    }
    expect(malformed / total).toBeGreaterThan(0.3);
    expect(found).toBeGreaterThan(total / 4);
  });
});

describe("session edge shapes", () => {
  const scan = (text: string, method = generate) => scanAgyBody(enc(text), method);

  test("a body cut right after a complete sessionId, and garbage after the needed fields", () => {
    expect(scan('{"project":"p","request":{"sessionId":"77"').session).toBe("77");
    expect(scan('{"project":"p","request":{"sessionId":"77"},"x":{{{{ garbage')).toEqual({ project: "p", session: "77" });
    expect(scan(`{"project":"p","request":{"labels":{"trajectory_id":"${trajectory}"}} !!!`).session).toBe(trajectory);
  });

  test("prefix keys and escaped key names", () => {
    expect(scan('{"request":{"labelsX":{"trajectory_id":"' + trajectory + '"},"label":{},"sessionIdX":"5"}}').session).toBeUndefined();
    expect(scan('{"\\u0072equest":{"\\u006cabels":{"trajectory_id":"' + trajectory + '"}}}').session).toBe(trajectory);
    expect(scan('{"request":{"\\u0073essionId":"5"}}').session).toBe("5");
  });

  test("malformed request content yields no session and keeps the project", () => {
    expect(scan('{"request":{"sessionId":"5","a" 1},"project":"real"}')).toEqual({ project: "real" });
    expect(scan('{"request":{"sessionId":"5","a":1{}},"project":"real"}').project).toBe("real");
  });

  test("a number with an exponent and a pretty-printed body", () => {
    expect(scan('{"request":{"n":1.5e-10,"sessionId":"5"}}').session).toBe("5");
    expect(scan('{\n  "request": {\n    "labels": {\n      "trajectory_id": "' + trajectory + '"\n    }\n  }\n}').session).toBe(trajectory);
  });
});
