import { describe, expect, test } from "bun:test";
import {
  ambiguousResendAllowanceFor,
  selfContainedChatBody,
  selfContainedResponsesBody,
} from "../../src/server/responses/reset-replay";
import { authorizeResendForRecovery } from "../../src/lib/request-resend-gate";
import { attachCredentialMask, createOutboundCredentialMask, responseCredentialMask } from "../../src/lib/outbound-credential-registry";
import { credentialComponents } from "../../src/lib/outbound-credential-registry";
import { inspectPolicyRefusal } from "../../src/lib/upstream-retry";
import { maskTerminalResponseJson, createTerminalErrorRedactionBlockRewrite } from "../../src/server/responses/terminal-error-redaction";
import { deferProtocolSafeResetRecovery } from "../../src/server/responses/combo-stream-preflight";

const clientTurn = {
  store: false,
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", name: "read", call_id: "c1", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "ok" },
  ],
  tools: [{ type: "function", name: "read" }],
};

describe("selfContainedResponsesBody", () => {
  test("accepts a turn whose second send can only repeat the inference", () => {
    expect(selfContainedResponsesBody(clientTurn)).toBe(true);
    expect(selfContainedResponsesBody({ store: false, input: "plain prompt" })).toBe(true);
    expect(selfContainedResponsesBody({
      store: false,
      input: [{ role: "user", content: "hi" }],
    })).toBe(true);
  });

  test("refuses anything that leaves state behind or continues someone else's turn", () => {
    for (const override of [
      { store: true },
      { store: undefined },
      { background: true },
      { previous_response_id: "resp_1" },
      { conversation: "conv_1" },
      { stream_id: undefined },
      { input: undefined },
      { input: { not: "a list" } },
    ]) {
      expect(selfContainedResponsesBody({ ...clientTurn, ...override })).toBe(false);
    }
    expect(selfContainedResponsesBody(null)).toBe(false);
    expect(selfContainedResponsesBody([clientTurn])).toBe(false);
  });

  test("refuses a catalog carrying anything the origin would execute", () => {
    for (const tools of [
      [{ type: "web_search" }],
      [{ type: "function", name: "read" }, { type: "mcp", server_label: "s" }],
      [{ type: "tool_search", execution: "server" }],
      [{ type: "namespace", name: "ns", tools: [{ type: "code_interpreter" }] }],
      [{ type: "namespace" }],
      "not a list",
    ]) {
      expect(selfContainedResponsesBody({ ...clientTurn, tools })).toBe(false);
    }
    expect(selfContainedResponsesBody({
      ...clientTurn,
      tools: [{ type: "namespace", name: "ns", tools: [{ type: "function", name: "read" }] }],
    })).toBe(true);
  });

  test("a hosted tool cannot ride in through a deferred declaration", () => {
    expect(selfContainedResponsesBody({
      ...clientTurn,
      input: [...clientTurn.input, { type: "additional_tools", tools: [{ type: "web_search" }] }],
    })).toBe(false);
    expect(selfContainedResponsesBody({
      ...clientTurn,
      input: [...clientTurn.input, { type: "tool_search_output", tools: [{ type: "function", name: "read" }] }],
    })).toBe(true);
  });

  test("an input item type this proxy does not recognise is refused", () => {
    expect(selfContainedResponsesBody({
      ...clientTurn,
      input: [{ type: "image_generation_call", id: "ig1" }],
    })).toBe(false);
  });
});

describe("selfContainedChatBody", () => {
  const chatTurn = {
    model: "mock/test-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "read" } }],
  };

  test("accepts a Chat turn whose second send can only repeat the inference", () => {
    expect(selfContainedChatBody(chatTurn)).toBe(true);
    expect(selfContainedChatBody({ model: "m", messages: [] })).toBe(true);
  });

  test("refuses anything that leaves state behind or continues someone else's turn", () => {
    for (const override of [
      { store: true },
      { previous_response_id: "resp_1" },
      { messages: undefined },
      { messages: "not a list" },
    ]) {
      expect(selfContainedChatBody({ ...chatTurn, ...override })).toBe(false);
    }
    expect(selfContainedChatBody(null)).toBe(false);
    expect(selfContainedChatBody([chatTurn])).toBe(false);
  });

  test("refuses hosted execution requested outside the tool catalog", () => {
    expect(selfContainedChatBody({ ...chatTurn, web_search_options: {} })).toBe(false);
    expect(selfContainedChatBody({ ...chatTurn, web_search_options: undefined })).toBe(true);
  });

  test("refuses a catalog carrying a tool the origin would execute", () => {
    for (const tools of [
      [{ type: "web_search" }],
      [{ type: "function", function: { name: "read" } }, { type: "code_interpreter" }],
      [{ function: { name: "read" } }],
      "not a list",
    ]) {
      expect(selfContainedChatBody({ ...chatTurn, tools })).toBe(false);
    }
  });
});

describe("ambiguousResendAllowanceFor", () => {
  test("absent or disabled policy grants nothing", () => {
    const claim = () => true;
    expect(ambiguousResendAllowanceFor({}, () => true, claim)).toBeUndefined();
    expect(ambiguousResendAllowanceFor({ retryOnReset: { enabled: false } }, () => true, claim)).toBeUndefined();
  });

  test("a bare opt-in spends one replacement for the whole request", () => {
    const limits: number[] = [];
    let left = 1;
    const grant = ambiguousResendAllowanceFor({ retryOnReset: {} }, () => true, limit => {
      limits.push(limit);
      return left-- > 0;
    })!;
    expect(grant.selfContained).toBe(true);
    expect(grant.claim()).toBe(true);
    expect(grant.claim()).toBe(false);
    // Both questions were asked at the same ceiling, against the one request-wide counter.
    expect(limits).toEqual([1, 1]);
  });

  test("the body judgment is lazy and reaches the gate as a refusal reason", () => {
    let judged = 0;
    const grant = ambiguousResendAllowanceFor({ retryOnReset: {} }, () => { judged += 1; return false; }, () => true)!;
    expect(judged).toBe(0);
    const decision = authorizeResendForRecovery("pre-header", "connection-reset", grant);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.refusal).toBe("ambiguous-request-not-replayable");
    expect(judged).toBe(1);
  });

  test("a provider that opted in still funds only what the operator asked for", () => {
    const seen: number[] = [];
    const grant = ambiguousResendAllowanceFor(
      { retryOnReset: { replacements: 2 } },
      () => true,
      limit => { seen.push(limit); return true; },
    )!;
    expect(grant.claim()).toBe(true);
    expect(seen).toEqual([2]);
  });
});

describe("a reset-recovered stream keeps the credential masks of every body it can relay", () => {
  const prelude = 'event: response.created\ndata: {"type":"response.created","response":{"id":"first","output":[]}}\n\n';
  const resetAfterPrelude = (): Response => {
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return Promise.reject(new Error("fixture-reset"));
        sent = true;
        controller.enqueue(new TextEncoder().encode(prelude));
      },
    }), { headers: { "content-type": "text/event-stream" } });
  };

  test("the published head masks the original and the replacement key", async () => {
    const original = attachCredentialMask(resetAfterPrelude(), createOutboundCredentialMask({ "x-api-key": "fixture-original" }));
    const replacement = attachCredentialMask(
      new Response(prelude, { headers: { "content-type": "text/event-stream" } }),
      createOutboundCredentialMask({ "x-api-key": "fixture-replacement" }));
    const published = deferProtocolSafeResetRecovery(original, { model: "m1", provider: "a" }, async () => replacement);
    const mask = responseCredentialMask(published);
    expect(mask("fixture-original")).toBe("[REDACTED]");
    // The replacement is adopted only after the first pull settles the reset.
    expect(mask("fixture-replacement")).toBe("fixture-replacement");
    await published.text();
    expect(mask("fixture-replacement")).toBe("[REDACTED]");
    expect(mask("fixture-original")).toBe("[REDACTED]");
  });
});

describe("credential masking keeps protocol syntax and finds every echo", () => {
  test("a scheme word after the scheme is a credential part", () => {
    expect(credentialComponents("Bearer negotiate")).toContain("negotiate");
    expect(credentialComponents("Bearer abc")).not.toContain("Bearer");
  });

  test("buffered failed JSON masks keys and exact numeric echoes, and keeps counters and output text", () => {
    const mask = createOutboundCredentialMask({ "x-api-key": "424242" });
    const json = JSON.stringify({ status: "failed", usage: { input_tokens: 424242 },
      error: { message: "m", metadata: { "424242": "k", detail: 424242 } },
      output: [{ type: "message", content: [{ type: "output_text", text: "Authorization: Bearer example" }] }] });
    const masked = maskTerminalResponseJson(json, mask);
    expect(JSON.parse(masked).usage.input_tokens).toBe(424242);
    expect(masked).not.toContain('"424242":');
    expect(JSON.parse(masked).error.metadata.detail).toBe("[REDACTED]");
    expect(masked).toContain("Authorization: Bearer example");
  });

  test("a short credential never rewrites SSE field names", () => {
    const rewrite = createTerminalErrorRedactionBlockRewrite({ authorization: "Basic YTpi" });
    const block = 'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"a b"}}}';
    expect(rewrite(block)[0]).toMatch(/^event: response\.failed\ndata: /);
  });

  test("an upstream-chosen SSE event name carrying the credential is masked", () => {
    const rewrite = createTerminalErrorRedactionBlockRewrite({ authorization: "Bearer fixture-secret-value" });
    const out = rewrite('event: fixture-secret-value\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"x"}}}')[0]!;
    expect(out).not.toContain("fixture-secret-value");
    expect(rewrite('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"x"}}}')[0]).toMatch(/^event: response\.failed\n/);
  });

  test("a typed-refusal verdict that timed out is final, not re-peeked", async () => {
    const slow = new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 503 });
    expect(await inspectPolicyRefusal(slow)).toBeUndefined();
    const started = performance.now();
    expect(await inspectPolicyRefusal(slow)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("cancelling a deferred reset stream releases a silent source", async () => {
    let cancelled = false;
    const silent = new Response(new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
    const published = deferProtocolSafeResetRecovery(silent, { model: "m1", provider: "a" }, async () => null);
    const reader = published.body!.getReader();
    const pending = reader.read().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 20));
    await reader.cancel("downstream gone");
    await pending;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(cancelled).toBe(true);
  });
});
