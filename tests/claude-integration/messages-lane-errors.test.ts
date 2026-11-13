import { comboFailureEvidence } from "../../src/lib/client-error-body";
import { expect, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import type { OcxConfig } from "../../src/types";
const sentinel = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const loopMessage = "reasoning_loop_detected: the model's reasoning repeated itself (12 distinct sentences among its last 800), so the gateway ended the reply after 45029 reasoning characters. Sending the same request again is likely to loop again; shorten or change the context.";
const errors = [
  { type: "invalid_request_error", message: `prompt is too long ${sentinel}` },
  { type: "request_too_large", message: `prompt is too long ${sentinel}` },
  { type: sentinel, code: sentinel, message: sentinel },
  { message: `Your input exceeds the context window of this model ${sentinel}` },
  { type: "server_error", code: "server_error", message: `Your input exceeds the context window of this model ${sentinel}` },
  { type: "rate_limit_error", status: 429, message: `too many tokens per minute ${sentinel}` },
];
for (const native of [false, true]) for (const folded of [false, true]) for (const [i, error] of errors.entries()) {
  test(`${native ? "native" : "translated"} ${folded ? "folded" : "HTTP"} ${i} keeps original decisions`, async () => {
    const release = acquireOwnedSpendHome(); clearKeyCooldowns();
    let calls = 0;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      calls++;
      const raw = { type: "error", error, request_id: sentinel, [sentinel]: sentinel };
      const body = native ? `event: error\ndata: ${JSON.stringify(raw)}\n\n`
        : `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error } })}\n\n`;
      return folded ? new Response(body, { headers: { "content-type": "text/event-stream" } })
        : Response.json(raw, { status: error.status ?? 400, headers: { "request-id": `req_${sentinel}` } });
    } });
    try {
      const config = { port: 0, defaultProvider: "fixture", providers: { fixture: {
        adapter: native ? "anthropic" : "openai-responses", baseUrl: upstream.url.toString(),
        authMode: "key", apiKey: "fixture", allowPrivateNetwork: true, models: ["wire-model"],
        transientRetry: { maxAttempts: 1 },
      } }, protocols: { rollout: { managedMessagesNative: native } } } as OcxConfig;
      saveConfig(config);
      const ctx: any = { model: "", provider: "" };
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture/wire-model", stream: false, max_tokens: 16, messages: [{ role: "user", content: "fixture" }] }) }), config, ctx);
      const text = await response.text();
      if (!folded) {
        const evidence = comboFailureEvidence(response);
        expect(evidence).toBeDefined();
        expect(Object.keys(JSON.parse(evidence!)).sort()).toEqual(["error", "type"]);
        if (native) expect(Object.hasOwn(JSON.parse(evidence!).error, "code")).toBe(false);
      }
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(sentinel);
      const headers = JSON.stringify([...response.headers]);
      expect(headers.length).toBeGreaterThan(0);
      expect(headers).not.toContain(sentinel);
      expect(calls).toBe(1);
      const body = JSON.parse(text);
      const overflow = i < 2 || (!native && (i === 3 || i === 4));
      expect(response.status).toBe(overflow ? 400 : folded ? 502 : error.status ?? 400);
      if (overflow) expect(body.error.message).toBe("prompt is too long: The request exceeds the model's context window.");
      if (native) expect(Object.hasOwn(body.error, "code")).toBe(false);
      if (!native && overflow) expect(body.error.code).toBe("context_length_exceeded");
    } finally { release(); await upstream.stop(true); }
  });
}

for (const beforeStream of [false, true]) for (const stream of [false, true]) for (const directEncoder of [false, true]) for (const route of ["direct", "combo", "policy"] as const) test(`Chat reasoning loop ${beforeStream ? "HTTP" : "stream"} to ${stream ? "streamed" : "buffered"} Messages via ${route}, direct encoder=${directEncoder}, is terminal`, async () => {
  const release = acquireOwnedSpendHome(); clearKeyCooldowns();
  let calls = 0;
  const error = { type: "upstream_error", code: "reasoning_loop_detected", message: loopMessage };
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    calls++;
    if (beforeStream) return Response.json({ error }, { status: 502, headers: { "x-should-retry": "false" } });
    const delta = { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { reasoning_content: "thinking" }, finish_reason: null }] };
    return new Response(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify({ error })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const config = { port: 0, defaultProvider: "fixture", providers: { fixture: {
      adapter: "openai-chat", baseUrl: upstream.url.toString(), authMode: "key", apiKey: "fixture",
      allowPrivateNetwork: true, models: ["wire-model"],
    }, backup: { adapter: "openai-chat", baseUrl: upstream.url.toString(), authMode: "key", apiKey: "fixture2", allowPrivateNetwork: true, models: ["wire-model"] } }, combos: { fixture: { strategy: "failover", targets: [{ provider: "fixture", model: "wire-model" }, { provider: "backup", model: "wire-model" }] } }, routingProfiles: { daily: { candidates: [{ provider: "fixture", model: "wire-model" }, { provider: "backup", model: "wire-model" }] } }, protocols: { rollout: { directEncoders: directEncoder } } } as OcxConfig;
    saveConfig(config);
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: route === "combo" ? "combo/fixture" : route === "policy" ? "daily" : "fixture/wire-model", stream, max_tokens: 16, messages: [{ role: "user", content: "fixture" }] }) }), config, { model: "", provider: "" });
    const text = await response.text();
    const payload = beforeStream || !stream ? JSON.parse(text) : JSON.parse(text.split("event: error\ndata: ")[1]!.split("\n")[0]!);
    expect(payload).toEqual({ type: "error", error: { type: "api_error", code: error.code, message: "The model's reasoning repeated itself, so the provider ended the reply. Sending the same request again is likely to loop again; shorten or change the context." } });
    if (beforeStream || !stream) { expect(response.status).toBe(502); expect(response.headers.get("x-should-retry")).toBe("false"); }
    expect(calls).toBe(1);
  } finally { release(); await upstream.stop(true); }
});

for (const httpFailure of [false, true]) test(`empty completion replacement preserves reasoning loop (HTTP=${httpFailure})`, async () => {
  const release = acquireOwnedSpendHome(); clearKeyCooldowns();
  let calls = 0;
  const error = { type: "upstream_error", code: "reasoning_loop_detected", message: loopMessage };
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    calls++;
    if (calls === 1) return new Response(`data: ${JSON.stringify({ id: "first", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    return httpFailure ? Response.json({ error }, { status: 502, headers: { "x-should-retry": "false" } }) : new Response(`data: ${JSON.stringify({ error })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", emptyCompletionRetry: true, providers: { fixture: { adapter: "openai-chat", baseUrl: upstream.url.toString(), authMode: "key", apiKey: "fixture", allowPrivateNetwork: true, models: ["wire-model"] } } };
    saveConfig(config);
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "fixture/wire-model", stream: true, max_tokens: 16, messages: [{ role: "user", content: "fixture" }] }) }), config, { model: "", provider: "" });
    const text = await response.text();
    const payload = JSON.parse(text.split("event: error\ndata: ")[1]!.split("\n")[0]!);
    expect(payload.error).toEqual({ type: "api_error", code: error.code, message: "The model's reasoning repeated itself, so the provider ended the reply. Sending the same request again is likely to loop again; shorten or change the context." });
    expect(calls).toBe(2);
  } finally { release(); await upstream.stop(true); }
});

for (const httpFailure of [false, true]) test(`reasoning loop is neutral to recorded routing health (HTTP=${httpFailure})`, async () => {
  const release = acquireOwnedSpendHome(); clearKeyCooldowns();
  const { clearHealthHistoryCacheForTests, healthEvidenceForCandidate } = await import("../../src/routing/health");
  clearHealthHistoryCacheForTests();
  const error = { type: "upstream_error", code: "reasoning_loop_detected", message: loopMessage };
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => httpFailure
    ? Response.json({ error }, { status: 502, headers: { "x-should-retry": "false" } })
    : new Response(`data: ${JSON.stringify({ error })}\n\n`, { headers: { "content-type": "text/event-stream" } }) });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-chat", baseUrl: upstream.url.toString(), authMode: "key", apiKey: "fixture", allowPrivateNetwork: true, models: ["wire-model"] } } };
    saveConfig(config);
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "fixture/wire-model", stream: true, max_tokens: 16, messages: [{ role: "user", content: "fixture" }] }) }), config, { model: "", provider: "" }, { requestId: crypto.randomUUID(), start: Date.now() });
    await response.text();
    const { readUsageEntries } = await import("../../src/usage/log");
    const logged = readUsageEntries().at(-1);
    expect(logged?.errorCode).toBe(error.code);
    expect(logged?.attempts?.at(-1)?.errorCode).toBe(error.code);
    expect(healthEvidenceForCandidate({ provider: logged!.provider, model: logged!.model }).sampleCount).toBeUndefined();
  } finally { release(); await upstream.stop(true); }
});

test("ordinary Chat 502 still becomes a Messages overload", async () => {
  const release = acquireOwnedSpendHome(); clearKeyCooldowns();
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { type: "upstream_error", message: "unavailable" } }, { status: 502 }) });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-chat", baseUrl: upstream.url.toString(), authMode: "key", apiKey: "fixture", allowPrivateNetwork: true, models: ["wire-model"], transientRetryOn5xx: { attempts: 1 } } } };
    saveConfig(config);
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "fixture/wire-model", stream: true, max_tokens: 16, messages: [{ role: "user", content: "fixture" }] }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(529);
    expect((await response.json()).error.type).toBe("overloaded_error");
  } finally { release(); await upstream.stop(true); }
});

for (const surface of ["chat", "responses"] as const) for (const beforeStream of [false, true]) for (const stream of [false, true]) for (const policy of [false, true]) test(`${surface} preserves a terminal Chat reasoning loop ${beforeStream ? "HTTP" : "stream"} with stream=${stream} policy=${policy}`, async () => {
  const release = acquireOwnedSpendHome(); clearKeyCooldowns();
  let calls = 0;
  const error = { type: "upstream_error", code: "reasoning_loop_detected", message: loopMessage };
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    calls++;
    if (beforeStream || (!stream && surface === "responses")) return Response.json({ error }, { status: 502, headers: { "x-should-retry": "false" } });
    return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { reasoning_content: "thinking" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ error })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-chat", baseUrl: upstream.url.toString(), authMode: "key", apiKey: "fixture", allowPrivateNetwork: true, models: ["wire-model"] } }, routingProfiles: { daily: { candidates: [{ provider: "fixture", model: "wire-model" }] } } };
    const handler = surface === "chat" ? (await import("../../src/server/chat-completions")).handleChatCompletions : (await import("../../src/server/responses")).handleResponses;
    const model = policy ? "daily" : "fixture/wire-model";
    const body = surface === "chat" ? { model, stream, messages: [{ role: "user", content: "fixture" }] } : { model, stream, input: "fixture" };
    const response = await handler(new Request(`http://localhost/v1/${surface === "chat" ? "chat/completions" : "responses"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), config, { model: "", provider: "" });
    const text = await response.text();
    expect(text).toContain(error.code);
    expect(text).not.toContain(loopMessage);
    if (surface === "chat" && response.status >= 400) expect(response.headers.get("x-should-retry")).toBe("false");
    expect(calls).toBe(1);
  } finally { release(); await upstream.stop(true); }
});

test("policy Chat preserves a loop returned in upstream JSON", async () => {
  const release = acquireOwnedSpendHome();
  const error = { type: "upstream_error", code: "reasoning_loop_detected", message: loopMessage };
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error }) });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-chat", baseUrl: upstream.url.toString(), authMode: "key", apiKey: "fixture", allowPrivateNetwork: true, models: ["wire-model"] } }, routingProfiles: { daily: { candidates: [{ provider: "fixture", model: "wire-model" }] } } };
    const { handleChatCompletions } = await import("../../src/server/chat-completions");
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "daily", stream: false, messages: [{ role: "user", content: "fixture" }] }) }), config, { model: "", provider: "" });
    expect((await response.json()).error.code).toBe(error.code);
    expect(response.headers.get("x-should-retry")).toBe("false");
  } finally { release(); await upstream.stop(true); }
});

test("native buffered reader retains a primitive original diagnostic internally", async () => {
  const release = acquireOwnedSpendHome();
  const config: any = { defaultProvider: "fixture", providers: { fixture: {
    adapter: "anthropic", authMode: "key", apiKey: "fixture", models: ["wire-model"], baseUrl: "http://127.0.0.1:1", allowPrivateNetwork: true,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ pull() { throw sentinel; } }), { headers: { "content-type": "application/json" } }),
  } }, protocols: { rollout: { managedMessagesNative: true } } };
  saveConfig(config);
  try {
    const context: any = { model: "", provider: "" };
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify({ model: "fixture/wire-model", messages: [{ role: "user", content: "fixture" }], max_tokens: 16, stream: false }) }), config, context);
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(sentinel);
    expect(context.upstreamError).toBe(sentinel);
  } finally { release(); }
});
