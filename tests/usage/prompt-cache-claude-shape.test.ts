import { describe, expect, test } from "bun:test";
import fixture from "../fixtures/claude-code-cache-shape.json";
import { walkPromptCachePrefix } from "../../src/server/prompt-cache-prefix";
import { PromptCacheReuseLedger } from "../../src/server/prompt-cache-reuse";

// Sanitized shape reconstructed from Claude Code 2.1.321's XZ, hGr, yGr and JGr
// builders and request-block schemas. No captured prompt, signature or credential is retained.
const marker = { type: "ephemeral", ttl: "1h" };
const wire = (request: object) => Buffer.from(JSON.stringify(request).replace("synthetic cached history", "cached context ".repeat(50000)));
const simple = (content: object[], extra: object = {}) => ({ model: fixture.model, messages: [{ role: "assistant", content }], ...extra });
function supported(request: object) {
  const result = walkPromptCachePrefix(wire(request));
  if (result.status !== "supported") throw new Error(`fixture rejected: ${result.reason}`);
  return result;
}
function event(read: number, write: number) {
  return { type: "message_start", message: { id: "msg_shape", type: "message", role: "assistant", model: fixture.model,
    usage: { input_tokens: 24, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write } } };
}
const withoutMessageMarkers = fixture.messages.map(message => ({ ...message, content: message.content.map(block => {
  if (!("cache_control" in block)) return block;
  const { cache_control, ...content } = block;
  return content;
}) }));

describe("Claude Code cache request shapes", () => {
  test.each([
    simple([{ type: "text", text: "system", cache_control: { ...marker, scope: "global" } }]),
    simple([{ type: "thinking", thinking: "inspect", signature: "synthetic-signature" }, { type: "redacted_thinking", data: "synthetic-redaction" }]),
    simple([{ type: "tool_result", tool_use_id: "read", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }]),
    simple([{ type: "tool_result", tool_use_id: "read", content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "report" } }] }]),
    simple([{ type: "tool_result", tool_use_id: "search", content: [{ type: "tool_reference", tool_name: "lookup" }] }],
      { tools: [{ name: "lookup", input_schema: { type: "object" }, defer_loading: true }] }),
    simple([{ type: "text", text: "normal" }], { diagnostics: { previous_message_id: "msg_synthetic" } }),
  ])("supports a client-emitted component without changing bytes: %j", request => {
    const bytes = wire(request), original = Buffer.from(bytes);
    expect(walkPromptCachePrefix(bytes).status).toBe("supported");
    expect(bytes).toEqual(original);
  });

  test("the complete long-history fixture keeps all four physical markers", () => {
    const bytes = wire(fixture), original = Buffer.from(bytes);
    const prefix = supported(fixture);
    expect(bytes.byteLength).toBeGreaterThan(512 * 1024);
    expect(prefix.breakpoints.map(point => point.ttl)).toEqual([3600000, 3600000, 3600000, 3600000]);
    expect(prefix.reuseBoundary).toBeGreaterThan(0);
    expect(bytes).toEqual(original);
    for (const [before, after] of [["synthetic-thinking-signature", "changed-signature"], ["synthetic-redacted-state", "changed-redaction"],
      ["Synthetic document body", "changed document"], ["iVBORw0KGgo", "iVBORw0KGgp"]]) {
      const changed = walkPromptCachePrefix(Buffer.from(bytes.toString().replace(before!, after!)));
      expect(changed.status).toBe("supported");
      if (changed.status !== "supported") throw new Error("unreachable");
      expect(changed.positions.at(-1)?.digest).not.toBe(prefix.positions.at(-1)?.digest);
    }
  });

  test("diagnostic ids do not invalidate content, but global and private scopes cannot alias", () => {
    expect(supported({ ...fixture, diagnostics: { previous_message_id: "msg_next" } }).positions).toEqual(supported(fixture).positions);
    const scoped = simple([{ type: "text", text: "same", cache_control: { ...marker, scope: "global" } }]);
    const privateScope = simple([{ type: "text", text: "same", cache_control: marker }]);
    expect(supported(scoped).positions[0]?.digest).not.toBe(supported(privateScope).positions[0]?.digest);
  });

  test("automatic caching walks back past thinking and explicit thinking markers remain invalid", () => {
    const thought = { type: "thinking", thinking: "inspect", signature: "synthetic-signature" };
    expect(supported(simple([{ type: "text", text: "before" }, thought], { cache_control: marker })).breakpoints).toEqual([{ index: 0, ttl: 3600000 }]);
    expect(walkPromptCachePrefix(wire(simple([{ ...thought, cache_control: marker }])))).toEqual({ status: "unsupported", reason: "invalid_marker" });
  });

  test("multiple markers measure only the final prefix: a warm history plus a small new turn", () => {
    const ledger = new PromptCacheReuseLedger();
    const initial = simple([{ type: "text", text: "synthetic cached history", cache_control: marker }], {
      tools: [{ name: "Read", input_schema: { type: "object" }, cache_control: marker }], system: [{ type: "text", text: "system", cache_control: marker }],
    });
    try {
      const first = ledger.observeSend({ sendId: "first", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(initial).length });
      ledger.confirmPrefill(first, event(180000, 1500));
      ledger.resolvePrefix(first, supported(initial));
      ledger.reconcileUsage(first, { read: 180000, write: 1500 });
      ledger.releaseSend(first);
      expect(ledger.coverage().records).toBe(1);
      const next = { ...initial, messages: [...initial.messages, { role: "user", content: [{ type: "text", text: "small new turn", cache_control: marker }] }] };
      const second = ledger.observeSend({ sendId: "second", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(next).length });
      ledger.confirmPrefill(second, event(181500, 500));
      ledger.resolvePrefix(second, supported(next));
      ledger.reconcileUsage(second, { read: 181500, write: 500 });
      expect(ledger.classify(second)).toMatchObject({ reuse_expectation: "reuse", expected_cached_tokens: 181500, lost_cached_tokens: 0 });
    } finally { ledger.close(); }
  });

  test("realistic tool-result turns reuse the final measured prefix, not an expanded tool reference", () => {
    const ledger = new PromptCacheReuseLedger();
    const next = { ...fixture, messages: [...withoutMessageMarkers,
      { role: "assistant", content: [{ type: "tool_use", id: "call_next", name: "Read", input: { file_path: "next.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_next", content: "Small new tool output", cache_control: marker }] },
    ] };
    try {
      const first = ledger.observeSend({ sendId: "first", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(fixture).length });
      ledger.confirmPrefill(first, event(180000, 1500));
      ledger.resolvePrefix(first, supported(fixture));
      ledger.reconcileUsage(first, { read: 180000, write: 1500 });
      ledger.releaseSend(first);
      const second = ledger.observeSend({ sendId: "next", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(next).length });
      ledger.confirmPrefill(second, event(181500, 500));
      ledger.resolvePrefix(second, supported(next));
      ledger.reconcileUsage(second, { read: 181500, write: 500 });
      expect(ledger.classify(second)).toMatchObject({ reuse_expectation: "reuse", expected_cached_tokens: 181500, lost_cached_tokens: 0 });
    } finally { ledger.close(); }
  });

  test("a genuine change inside the cached history is not classified as reuse", () => {
    const ledger = new PromptCacheReuseLedger();
    const changed = { ...fixture, system: [{ ...fixture.system[0]!, text: "A different system prefix" }, fixture.system[1]!] };
    try {
      const first = ledger.observeSend({ sendId: "first", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(fixture).length });
      ledger.confirmPrefill(first, event(180000, 1500));
      ledger.resolvePrefix(first, supported(fixture));
      ledger.reconcileUsage(first, { read: 180000, write: 1500 });
      ledger.releaseSend(first);
      const second = ledger.observeSend({ sendId: "changed", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(changed).length });
      ledger.confirmPrefill(second, event(0, 181500));
      ledger.resolvePrefix(second, supported(changed));
      ledger.reconcileUsage(second, { read: 0, write: 181500 });
      expect(ledger.classify(second).reuse_expectation).not.toBe("reuse");
    } finally { ledger.close(); }
  });

  test("the actual walker refusal survives the ledger boundary", () => {
    const prefix = walkPromptCachePrefix(wire(simple([{ type: "text", text: "x", cache_control: { ...marker, evict_on_complete: true } }])));
    expect(prefix).toEqual({ status: "unsupported", reason: "invalid_marker" });
    const ledger = new PromptCacheReuseLedger();
    try {
      const send = ledger.observeSend({ sendId: "bad-marker", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: 100 });
      ledger.confirmPrefill(send, event(0, 1500));
      ledger.resolvePrefix(send, prefix);
      expect(ledger.classify(send)).toMatchObject({ reuse_expectation: "unknown", reuse_reason: "invalid_marker", reuse_coverage: "partial" });
    } finally { ledger.close(); }
  });

  const reminder = { type: "text", text: "<system-reminder>synthetic</system-reminder>" };
  const toolTurn = (user: object[]) => [{ role: "assistant", content: [{ type: "tool_use", id: "call_next", name: "Read", input: { file_path: "next.txt" } }] },
    { role: "user", content: user }];
  const result = (extra: object = {}) => ({ type: "tool_result", tool_use_id: "call_next", content: "Small new tool output", ...extra });

  test("a user message that mixes tool_result with other blocks sets the thinking-strip boundary", () => {
    const only = supported({ ...fixture, messages: [...withoutMessageMarkers, ...toolTurn([result({ cache_control: marker })])] });
    const mixed = supported({ ...fixture, messages: [...withoutMessageMarkers, ...toolTurn([result(), { ...reminder, cache_control: marker }])] });
    expect(only.reuseBoundary).toBe(supported({ ...fixture, messages: withoutMessageMarkers }).reuseBoundary);
    expect(mixed.reuseBoundary).toBeGreaterThan(only.reuseBoundary ?? 0);
  });

  test("a warm follow-up whose user turn mixes tool_result and reminder text is never reuse", () => {
    const ledger = new PromptCacheReuseLedger();
    const next = { ...fixture, messages: [...withoutMessageMarkers, ...toolTurn([result(), { ...reminder, cache_control: marker }])] };
    try {
      const first = ledger.observeSend({ sendId: "first", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(fixture).length });
      ledger.confirmPrefill(first, event(180000, 1500));
      ledger.resolvePrefix(first, supported(fixture));
      ledger.reconcileUsage(first, { read: 180000, write: 1500 });
      ledger.releaseSend(first);
      const second = ledger.observeSend({ sendId: "next", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(next).length });
      ledger.confirmPrefill(second, event(181500, 500));
      ledger.resolvePrefix(second, supported(next));
      ledger.reconcileUsage(second, { read: 181500, write: 500 });
      expect(ledger.classify(second)).toMatchObject({ reuse_expectation: "unknown", reuse_reason: "unmeasured_anchor" });
    } finally { ledger.close(); }
  });

  test("a reuse boundary on one send leaves another send's coverage untouched", () => {
    const ledger = new PromptCacheReuseLedger();
    const boundary = { ...fixture, messages: [...withoutMessageMarkers, ...toolTurn([result(), { ...reminder, cache_control: marker }])] };
    const plain = simple([{ type: "text", text: "plain", cache_control: marker }]);
    try {
      const other = ledger.observeSend({ sendId: "other", destination: "direct", model: "claude-other", account: "other-seat", bodyBytes: 100 });
      const edge = ledger.observeSend({ sendId: "edge", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(boundary).length });
      ledger.confirmPrefill(other, event(0, 10));
      ledger.confirmPrefill(edge, event(0, 181500));
      ledger.resolvePrefix(other, supported(plain));
      const before = ledger.classify(other);
      ledger.resolvePrefix(edge, supported(boundary));
      ledger.reconcileUsage(edge, { read: 0, write: 181500 });
      ledger.reconcileUsage(other, { read: 0, write: 10 });
      expect(ledger.classify(other)).toEqual(before);
    } finally { ledger.close(); }
  });

  const parallel = (count: number, extra: object = {}) => [
    { role: "assistant", content: Array.from({ length: count }, (_, index) => ({ type: "tool_use", id: `p${index}`, name: "Read", input: { index } })) },
    { role: "user", content: Array.from({ length: count }, (_, index) => ({ type: "tool_result", tool_use_id: `p${index}`,
      content: [{ type: "text", text: `out ${index}` }], ...(index === count - 1 ? extra : {}) })) },
  ];

  test("a predecessor marker behind eight parallel tool calls and their results is a lookback gap", () => {
    const ledger = new PromptCacheReuseLedger();
    const base = simple([{ type: "text", text: "synthetic cached history", cache_control: marker }]);
    const next = { ...base, messages: [{ role: "assistant", content: [{ type: "text", text: "synthetic cached history" }] }, ...parallel(8, { cache_control: marker })] };
    try {
      const first = ledger.observeSend({ sendId: "first", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(base).length });
      ledger.confirmPrefill(first, event(0, 180000));
      ledger.resolvePrefix(first, supported(base));
      ledger.reconcileUsage(first, { read: 0, write: 180000 });
      ledger.releaseSend(first);
      const second = ledger.observeSend({ sendId: "second", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(next).length });
      ledger.confirmPrefill(second, event(180000, 500));
      ledger.resolvePrefix(second, supported(next));
      ledger.reconcileUsage(second, { read: 180000, write: 500 });
      expect(ledger.classify(second)).toMatchObject({ reuse_expectation: "unknown", reuse_reason: "lookback_gap" });
    } finally { ledger.close(); }
  });

  test("a multi-marker reader more than nineteen blocks past the predecessor still reuses through its own earlier marker", () => {
    const ledger = new PromptCacheReuseLedger();
    const base = simple([{ type: "text", text: "synthetic cached history", cache_control: marker }]);
    const next = { ...base, messages: [...base.messages, ...parallel(8, { cache_control: marker })] };
    try {
      const first = ledger.observeSend({ sendId: "first", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(base).length });
      ledger.confirmPrefill(first, event(0, 180000));
      ledger.resolvePrefix(first, supported(base));
      ledger.reconcileUsage(first, { read: 0, write: 180000 });
      ledger.releaseSend(first);
      const second = ledger.observeSend({ sendId: "second", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(next).length });
      ledger.confirmPrefill(second, event(180000, 500));
      const walked = supported(next);
      expect(walked.positions.at(-1)!.blockEnd - walked.positions[0]!.blockEnd).toBeGreaterThan(19);
      ledger.resolvePrefix(second, walked);
      ledger.reconcileUsage(second, { read: 180000, write: 500 });
      expect(ledger.classify(second)).toMatchObject({ reuse_expectation: "reuse", expected_cached_tokens: 180000, lost_cached_tokens: 0 });
    } finally { ledger.close(); }
  });

  const keepAll = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
  const mixedTurn = (extra: object) => ({ ...fixture, ...extra, messages: [...withoutMessageMarkers, ...toolTurn([result(), { ...reminder, cache_control: marker }])] });
  function followUp(extra: object) {
    const ledger = new PromptCacheReuseLedger();
    const initial = { ...fixture, ...extra };
    const next = mixedTurn(extra);
    try {
      const first = ledger.observeSend({ sendId: "first", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(initial).length });
      ledger.confirmPrefill(first, event(180000, 1500));
      ledger.resolvePrefix(first, walkPromptCachePrefix(wire(initial)));
      ledger.reconcileUsage(first, { read: 180000, write: 1500 });
      ledger.releaseSend(first);
      const second = ledger.observeSend({ sendId: "next", destination: "direct", model: fixture.model, account: "synthetic-seat", bodyBytes: wire(next).length });
      ledger.confirmPrefill(second, event(181500, 500));
      ledger.resolvePrefix(second, walkPromptCachePrefix(wire(next)));
      ledger.reconcileUsage(second, { read: 181500, write: 500 });
      return ledger.classify(second);
    } finally { ledger.close(); }
  }

  test("a keep-all clear_thinking edit keeps thinking, so a mixed tool_result and reminder turn still reuses", () => {
    expect(followUp({ context_management: keepAll })).toMatchObject({ reuse_expectation: "reuse", expected_cached_tokens: 181500, lost_cached_tokens: 0 });
    expect(followUp({})).toMatchObject({ reuse_expectation: "unknown", reuse_reason: "unmeasured_anchor" });
  });

  test("the keep-all edit is part of the prefix identity", () => {
    const withEdit = supported({ ...fixture, context_management: keepAll });
    expect(withEdit.positions.at(-1)?.digest).not.toBe(supported(fixture).positions.at(-1)?.digest);
  });

  test.each([
    ["clear_tool_uses", { edits: [{ type: "clear_thinking_20251015", keep: "all" }, { type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 30000 }, keep: { type: "tool_uses", value: 3 } }] }],
    ["thinking_turns", { edits: [{ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 1 } }] }],
    ["unknown edit field", { edits: [{ type: "clear_thinking_20251015", keep: "all", extra: true }] }],
    ["unknown top field", { edits: [{ type: "clear_thinking_20251015", keep: "all" }], other: 1 }],
    ["unknown edit type", { edits: [{ type: "compact_20260112" }] }],
  ])("%s context management is a context transform and stays unknown", (_name, contextManagement) => {
    expect(walkPromptCachePrefix(wire({ ...fixture, context_management: contextManagement }))).toEqual({ status: "unsupported", reason: "context_transform" });
    expect(followUp({ context_management: contextManagement })).toMatchObject({ reuse_expectation: "unknown", reuse_reason: "context_transform" });
  });
});
