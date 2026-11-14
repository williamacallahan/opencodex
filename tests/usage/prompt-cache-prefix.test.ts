import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { isCachePositionReachable, walkPromptCachePrefix } from "../../src/server/prompt-cache-prefix";

const marker = { type: "ephemeral" };
const text = (label: string) => ({ type: "text", text: label });
const body = (content: unknown[], extra: object = {}) => ({
  model: "test-model", messages: [{ role: "user", content }], ...extra,
});
function walk(request: object) {
  const result = walkPromptCachePrefix(Buffer.from(JSON.stringify(request)));
  if (result.status !== "supported") throw new Error(`unsupported fixture: ${result.reason}`);
  return result;
}

describe("prompt cache byte prefixes", () => {
  test.each([19, 20, 21])("the lookback at distance %i includes only nineteen predecessors", distance => {
    const request = body(Array.from({ length: distance + 1 }, (_, index) => text(`${index}`)), { cache_control: marker });
    const prefix = walk(request);
    expect(prefix.breakpoints).toEqual([{ index: distance, ttl: 300000 }]);
    expect(isCachePositionReachable(0, prefix.breakpoints)).toBe(distance === 19);
  });

  test.each(["tool_use", "tool_result"])("collapses %s runs without dropping any block's bytes", kind => {
    const calls = Array.from({ length: 25 }, (_, index) => kind === "tool_use"
      ? { type: kind, id: `call-${index}`, name: "lookup", input: { index } }
      : { type: kind, tool_use_id: `call-${index}`, content: `${index}` });
    const prefix = walk(body([text("before"), ...calls, text("after")], { cache_control: marker }));
    expect(prefix.positions.map(position => position.index)).toEqual([0, 1, 2]);
    expect(prefix.breakpoints).toEqual([{ index: 2, ttl: 300000 }]);
    const changed = walk(body([text("before"), { ...calls[0], content: "changed" }, ...calls.slice(1), text("after")]));
    expect(changed.positions[0]).toEqual(prefix.positions[0]);
    expect(changed.positions[1]?.digest).not.toBe(prefix.positions[1]?.digest);
    expect(changed.positions[2]?.digest).not.toBe(prefix.positions[2]?.digest);
  });

  test("a marker within a tool run is unsupported rather than assigned to the wrong prefix", () => {
    const request = body([
      { type: "tool_use", id: "a", name: "lookup", input: {}, cache_control: marker },
      { type: "tool_use", id: "b", name: "lookup", input: {} },
    ]);
    expect(walkPromptCachePrefix(Buffer.from(JSON.stringify(request)))).toEqual({ status: "unsupported", reason: "tool_run_breakpoint" });
    request.messages[0]!.content.reverse();
    expect(walk(request).breakpoints).toEqual([{ index: 0, ttl: 300000 }]);
  });

  test("roles and message boundaries change identities and end tool runs", () => {
    const call = { type: "tool_use", id: "a", name: "lookup", input: {} };
    const single = walk({ model: "test-model", messages: [{ role: "assistant", content: [call, call] }] });
    const split = walk({ model: "test-model", messages: [{ role: "assistant", content: [call] }, { role: "assistant", content: [call] }] });
    const user = walk(body([call, call]));
    expect(single.positions).toHaveLength(1);
    expect(split.positions).toHaveLength(2);
    expect(split.positions[1]?.digest).not.toBe(single.positions[0]?.digest);
    expect(user.positions[0]?.digest).not.toBe(single.positions[0]?.digest);
  });

  test("moving legal markers changes placement but not content identity", () => {
    const old = walk(body([{ ...text("first"), cache_control: marker }, text("second")]));
    for (const first of [text("first"), { cache_control: marker, ...text("first") }, { type: "text", cache_control: marker, text: "first" }]) {
      const next = walk(body([first, { ...text("second"), cache_control: marker }]));
      expect(next.positions).toEqual(old.positions);
    }
    expect(walk(body([text("first"), { ...text("second"), cache_control: marker }])).breakpoints).toEqual([{ index: 1, ttl: 300000 }]);
  });

  test("cache_control inside input or schema remains content, and field order is preserved", () => {
    const request = (literal: string, reversed = false) => body([
      { type: "tool_use", id: "a", name: "lookup", input: reversed ? { other: 1, cache_control: literal } : { cache_control: literal, other: 1 } },
    ], { tools: [{ name: "lookup", input_schema: { type: "object", properties: { cache_control: { const: literal } } }, cache_control: marker }] });
    const original = walk(request("kept"));
    expect(walk(request("different")).positions[0]?.digest).not.toBe(original.positions[0]?.digest);
    expect(walk(request("kept", true)).positions[0]?.digest).toBe(original.positions[0]?.digest);
    expect(walk(request("kept", true)).positions[1]?.digest).not.toBe(original.positions[1]?.digest);
  });

  test("automatic caching uses the last cacheable position and coalesces a matching explicit marker", () => {
    const prefix = walk(body([text("first"), { ...text("second"), cache_control: marker }], { cache_control: marker }));
    expect(prefix.breakpoints).toEqual([{ index: 1, ttl: 300000 }]);
    expect(walk({ model: "test-model", system: "system only", messages: [], cache_control: marker }).breakpoints).toEqual([{ index: 0, ttl: 300000 }]);
    const conflict = body([{ ...text("first"), cache_control: marker }], { cache_control: { type: "ephemeral", ttl: "1h" } });
    expect(walkPromptCachePrefix(Buffer.from(JSON.stringify(conflict)))).toEqual({ status: "unsupported", reason: "invalid_marker" });
  });

  test("mixed TTLs require long-lived entries before short-lived entries", () => {
    const hour = { type: "ephemeral", ttl: "1h" };
    const prefix = walk(body([{ ...text("first"), cache_control: hour }, { ...text("second"), cache_control: marker }]));
    expect(prefix.breakpoints).toEqual([{ index: 0, ttl: 3600000 }, { index: 1, ttl: 300000 }]);
    expect(walkPromptCachePrefix(Buffer.from(JSON.stringify(body([
      { ...text("first"), cache_control: marker }, { ...text("second"), cache_control: hour },
    ]))))).toEqual({ status: "unsupported", reason: "ttl_order" });
    expect(walkPromptCachePrefix(Buffer.from(JSON.stringify(body(Array.from({ length: 5 }, () => ({ ...text("x"), cache_control: marker }))))))).toEqual({ status: "unsupported", reason: "breakpoint_limit" });
  });

  test("tier invalidators preserve only unaffected upper tiers", () => {
    const tools = [{ name: "lookup", input_schema: { type: "object" } }];
    const request = body([text("message")], { tools, system: [text("system")] });
    const baseline = walk(request).positions;
    const addedTool = walk({ ...request, tools: [...tools, { name: "second", input_schema: { type: "object" } }] });
    expect(addedTool.positions[0]?.digest).not.toBe(baseline[0]?.digest);
    const choice = walk({ ...request, tool_choice: { type: "auto" } }).positions;
    expect(choice.slice(0, 2)).toEqual(baseline.slice(0, 2));
    expect(choice[2]?.digest).not.toBe(baseline[2]?.digest);
    const fast = walk({ ...request, speed: "fast" }).positions;
    expect(fast[0]).toEqual(baseline[0]);
    expect(fast[1]?.digest).not.toBe(baseline[1]?.digest);
    for (const changed of [{ ...request, model: "other-model" }, { ...request, thinking: { type: "adaptive" } }, { ...request, output_config: { effort: "high" } }]) {
      expect(walk(changed).positions.every((position, index) => position.digest !== baseline[index]?.digest)).toBe(true);
    }
    expect(walk({ ...request, max_tokens: 100, stream: true, metadata: { user_id: "another-turn" } }).positions).toEqual(baseline);
  });

  test("escaped and Unicode spans match an independently serialized, framed fixture", () => {
    const blocks = [text('snow 雪, emoji 🦊, newline\n, quote ", slash \\'), text("next")];
    const wire = Buffer.from(JSON.stringify(body([{ ...blocks[0], cache_control: marker }, blocks[1]])));
    const before = Buffer.from(wire);
    const result = walkPromptCachePrefix(wire);
    const hash = createHash("sha256");
    const frame = (kind: string, serialized: string) => {
      hash.update(`${kind}:${Buffer.byteLength(serialized)}:`).update(serialized);
    };
    frame("version", "1");
    frame("parameter:model", JSON.stringify("test-model"));
    frame("message", JSON.stringify("user"));
    const digests = blocks.map(block => {
      frame("messages", JSON.stringify(block));
      return hash.copy().digest("hex");
    });
    expect(result.status === "supported" && result.positions.map(position => position.digest)).toEqual(digests);
    expect(wire).toEqual(before);
    const escaped = Buffer.from(wire.toString().replace("雪", "\\u96ea"));
    const altered = walkPromptCachePrefix(escaped);
    expect(altered.status === "supported" && altered.positions[0]?.digest).not.toBe(digests[0]);
  });

  test("compressed bytes use the existing decoder with a bounded inflated size", () => {
    const wire = Buffer.from(JSON.stringify(body([text("same")], { cache_control: marker })));
    expect(walkPromptCachePrefix(gzipSync(wire), "gzip")).toEqual(walkPromptCachePrefix(wire));
    expect(walkPromptCachePrefix(wire, "unknown")).toEqual({ status: "unsupported", reason: "content_encoding" });
    expect(walkPromptCachePrefix(gzipSync(Buffer.alloc(32 * 1024 * 1024 + 1, 32)), "gzip")).toEqual({ status: "unsupported", reason: "body_limit" });
  });

  test.each([
    '{"messages":[],"messages":[]}', '{"messages":[,]}', '{"messages":[],}',
    '{"messages":[],"n":truth}', '{"messages":[],"n":01}', '{"messages":[],"s":"\\q"}',
  ])("malformed or ambiguous JSON is unsupported: %s", wire => {
    expect(walkPromptCachePrefix(Buffer.from(wire))).toEqual({ status: "unsupported", reason: "invalid_json" });
  });

  test("provider transformations and unknown content reduce coverage explicitly", () => {
    for (const request of [
      body([{ type: "thinking", thinking: "opaque", signature: "signed" }]),
      body([{ type: "image", source: { type: "url", url: "https://example.com/image.png" } }]),
      body([text("x")], { context_management: { edits: [] } }),
      body([text("x")], { tools: [{ type: "web_search", name: "web_search" }] }),
      body([{ type: "tool_result", tool_use_id: "a", content: [{ type: "image" }] }]),
    ]) expect(walkPromptCachePrefix(Buffer.from(JSON.stringify(request)))).toEqual({ status: "unsupported", reason: "unsupported_shape" });
  });
});
