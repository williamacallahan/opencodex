import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { registerUpstreamRewriter } from "../../src/plugins/upstream-hooks";
import { appOwnedBytesSnapshot } from "../../src/lib/app-owned-memory";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum } from "../../src/oauth/anthropic-routing";
import { getAccountSet, getAccountCredential, saveAccountCredential, saveCredential, setAccountPaused, setActiveAccount } from "../../src/oauth/store";
import { routeModel } from "../../src/router";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { handleNativeMessages } from "../../src/server/messages-native";
import { tapAnthropicSseForLog } from "../../src/server/messages-shared";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { beginInferenceAttempt } from "../../src/server/inference/attempt";
import { stopNativePromptCacheObservations, workerRecovery } from "../../src/server/prompt-cache-observer";
import { addFinalRequestLog, type RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const model = "claude-sonnet-4-5";
const accessToken = (name: string) => `synthetic-cache-access-${name}`;
const authorization = (name: string) => `Bearer ${accessToken(name)}`;
const marker = { type: "ephemeral", ttl: "5m" };
const requestBody = (stream = false) => ({ model, max_tokens: 64, stream,
  messages: [{ role: "user", content: [{ type: "text", text: "stable context ".repeat(500), cache_control: marker }] }],
});
const reply = (read = 0, write = 2048) => ({ id: "msg_cache_fixture", type: "message", role: "assistant", model,
  content: [{ type: "text", text: "reply" }], stop_reason: "end_turn",
  usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write },
});
const frame = (event: string, payload: unknown) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
const sse = (read: number, write: number) => frame("message_start", { type: "message_start", message: reply(read, write) })
  + frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "reply" } })
  + frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })
  + frame("message_stop", { type: "message_stop" });
function streamingReply(read = 0, write = 2048): Response {
  return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
    controller.enqueue(new TextEncoder().encode(sse(read, write).replace(frame("message_stop", { type: "message_stop" }), "")));
    // Model generation continues while the observation worker hashes the confirmed prefill.
    await Bun.sleep(40);
    controller.enqueue(new TextEncoder().encode(frame("message_stop", { type: "message_stop" })));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
const retainedObservations = () => Object.entries(appOwnedBytesSnapshot().stores)
  .filter(([id]) => id.startsWith("prompt-cache-reuse:")).reduce((count, [, store]) => count + store.count, 0);

test("verbatim chunk readiness precedes observer-scheduled work", async () => {
  const phases: string[] = [];
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  const response = tapAnthropicSseForLog(upstream, { model, provider: "anthropic" }, () => {}, {
    stallMs: 0, maxBytes: 0, verbatim: { status: 200, inspectSse: true },
    onPrefill: () => queueMicrotask(() => phases.push("observer")),
  });
  const reader = response.getReader();
  try {
    const first = reader.read().then(chunk => { phases.push("client"); return chunk; });
    const opening = frame("message_start", { type: "message_start", message: reply() });
    source.enqueue(new TextEncoder().encode(opening));
    expect(new TextDecoder().decode((await first).value)).toBe(opening);
    expect(phases).toEqual(["client", "observer"]);
  } finally {
    source.close();
    await reader.cancel();
    reader.releaseLock();
  }
});

describe("native prompt cache observation paths", () => {
  let originalFetch: typeof fetch;
  let home: string;
  let savedHome: string | undefined;
  let releaseSpendHome: () => void;
  let upstream: ReturnType<typeof Bun.serve>;
  let config: OcxConfig;
  let lines: string[];
  let captureLog: ReturnType<typeof spyOn<typeof console, "info">>;
  let received: { bytes: Buffer; key: string | null; path: string }[];
  let respond: (request: Request) => Response;
  let unexpectedNetwork: number;
  let accountIds: string[];
  let warnings: string[];
  let captureWarnings: ReturnType<typeof spyOn<typeof console, "warn">>;
  let allowRefusalWarnings: boolean;

  beforeEach(async () => {
    stopNativePromptCacheObservations();
    clearKeyCooldowns();
    savedHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-cache-paths-"));
    process.env.OPENCODEX_HOME = home;
    releaseSpendHome = acquireOwnedSpendHome();
    clearAnthropicAccountPoolState();
    for (const name of ["a", "b"]) await saveCredential("anthropic", {
      access: accessToken(name), refresh: `synthetic-cache-refresh-${name}`,
      accountId: `synthetic-cache-account-${name}`, expires: Date.now() + 3600000, source: "oauth",
    });
    accountIds = getAccountSet("anthropic")!.accounts.map(account => account.id);
    await setActiveAccount("anthropic", accountIds[1]!);
    await setAccountPaused("anthropic", accountIds[0]!, true);
    forgetAnthropicFailoverQuorum();
    lines = [];
    warnings = [];
    allowRefusalWarnings = false;
    captureWarnings = spyOn(console, "warn").mockImplementation((...messages: unknown[]) => { warnings.push(messages.map(String).join(" ")); });
    received = [];
    unexpectedNetwork = 0;
    captureLog = spyOn(console, "info").mockImplementation((message: unknown) => {
      if (typeof message === "string" && message.includes("event=prompt_cache.outcome")) lines.push(message);
    });
    respond = () => Response.json(reply());
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      received.push({ bytes: Buffer.from(await request.arrayBuffer()), key: request.headers.get("authorization") ?? request.headers.get("x-api-key"), path: new URL(request.url).pathname });
      return respond(request);
    } });
    originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === "https://api.anthropic.com" && ["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)) {
        return originalFetch(new URL(url.pathname + url.search, upstream.url), init);
      }
      if (url.origin === upstream.url.origin) return originalFetch(input, init);
      unexpectedNetwork++;
      throw new Error("cache fixture refused non-local network");
    }, { preconnect(input: Parameters<typeof fetch.preconnect>[0]) {
      const url = new URL(String(input));
      if (url.origin !== "https://api.anthropic.com" && url.origin !== upstream.url.origin) {
        unexpectedNetwork++;
        throw new Error("cache fixture refused non-local preconnect");
      }
    } });
    config = { port: 0, defaultProvider: "anthropic", anthropicAccountPool: { enabled: true }, providers: { anthropic: {
      adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com",
      models: [model], liveModels: false,
    } }, protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } },
      claudeCode: { strictPassthrough: true, intercept: { enabled: false } },
      checkForUpdates: false, clientIntegrations: { codex: false }, syncResumeHistory: false };
    saveConfig(config);
  });
  afterEach(async () => {
    stopNativePromptCacheObservations();
    await upstream.stop(true);
    await drainAndRemoveFixtureRoots({ roots: [], restoreEnvironment() {} });
    releaseSpendHome();
    globalThis.fetch = originalFetch;
    captureLog.mockRestore();
    captureWarnings.mockRestore();
    clearKeyCooldowns();
    clearAnthropicAccountPoolState();
    forgetAnthropicFailoverQuorum();
    if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = savedHome;
    removeTreeWithRetry(home);
    expect(warnings.filter(warning => !allowRefusalWarnings || (!warning.includes("account unavailable (403)") && !warning.includes("status=403")))).toEqual([]);
    expect(unexpectedNetwork).toBe(0);
  });

  async function send(raw = JSON.stringify(requestBody()), path = "/strict/v1/messages") {
    const context: RequestLogContext = { model: "", provider: "" };
    const request = new Request(`http://localhost${path}`, { method: "POST", body: raw,
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(5000) });
    const response = await handleClaudeMessages(request, config, context,
      { requestId: crypto.randomUUID(), start: Date.now() }, config, { hybridMessages: path.startsWith("/hybrid/") });
    const bytes = await response.text();
    expect(response.status).toBe(200);
    return { context, bytes, line: lines.at(-1)! };
  }
  async function warm(raw = JSON.stringify(requestBody(true)), path = "/strict/v1/messages", read = 0) {
    respond = () => streamingReply(read, 2048 - read);
    // The public result is intentionally unknown while the worker is unfinished.
    // Poll only this local fixture's observable outcome, under a fixed request/deadline cap.
    const deadline = Date.now() + 4000;
    for (let attempt = 0; attempt < 40 && Date.now() < deadline; attempt++) {
      const result = await send(raw, path);
      if (result.line.includes("reuse_expectation=reuse")) return result;
      await Bun.sleep(20);
    }
    throw new Error(`native cache did not become observable: ${lines.at(-1)}`);
  }

  test.each(["/strict/v1/messages", "/hybrid/v1/messages"])("%s forwards unchanged bytes and reports a measured warm miss", async path => {
    const raw = JSON.stringify(requestBody(), null, 1).replace("stable context", "caf\\u00e9 context");
    const first = await send(raw, path);
    expect(first.bytes).toBe(JSON.stringify(reply()));
    expect(received[0]?.bytes).toEqual(Buffer.from(raw));
    expect(first.line).toContain("reuse_expectation=unknown");
    const warmRaw = raw.replace('"stream": false', '"stream": true');
    const warmMiss = await warm(warmRaw, path);
    expect(received.slice(1).every(request => request.bytes.equals(Buffer.from(warmRaw)))).toBe(true);
    expect(warmMiss.line).toContain("cache_eligible=true");
    expect(warmMiss.line).toContain("expected_cached_tokens=2048 lost_cached_tokens=2048");
    expect(warmMiss.line).toContain("reuse_schema=1 reuse_expectation=reuse reuse_reason=same_account_anchor reuse_scope=process");
    expect(warmMiss.line).toMatch(/reuse_epoch=[a-f0-9-]{36}/);
    expect(warmMiss.line).toContain("prompt_tokens=2050 cached_tokens=0 cache_write_tokens=2048");
  });
  test("a worker fault names its path, blinds only its backoff, and observation recovers without a restart", async () => {
    const post = spyOn(Worker.prototype, "postMessage").mockImplementationOnce(() => { throw new Error("synthetic post failure"); });
    respond = () => streamingReply();
    // Response completion does not await the handoff, so hold the injector until the fault is logged.
    try { await send(JSON.stringify(requestBody(true))); for (let wait = 0; wait < 100 && !warnings.length; wait++) await Bun.sleep(10); } finally { post.mockRestore(); }
    expect(warnings).toEqual([expect.stringContaining('fault=handoff_failed detail="Error: synthetic post failure" affected=1 retry_ms=1000')]);
    warnings.length = 0;
    expect((await send(JSON.stringify(requestBody(true)))).line).toContain("reuse_reason=worker_failed");
    await Bun.sleep(1000);
    expect((await warm()).line).toContain("reuse_expectation=reuse reuse_reason=same_account_anchor");
  });

  // Production faulted 13 times in 11 h with timers firing up to 5.7 s late on a CPU-starved hub
  // while the walk itself takes milliseconds: a stalled main thread is not a dead worker.
  // A stall before the post stands in for a slow cooperative copy; one after it, for a starved loop.
  async function withShortWatchdog(stall: "before_post" | "after_post", stallMs: number, swallowJobs: boolean, run: () => Promise<void>) {
    const saved = { ...workerRecovery };
    Object.assign(workerRecovery, { deadlineMs: 400, checkMs: 50, maxTimerLagMs: 50 });
    const hold = () => { const until = performance.now() + stallMs; while (performance.now() < until) { /* hold the main thread */ } };
    const original = Worker.prototype.postMessage;
    const post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      if (stall === "before_post") hold();
      if (!swallowJobs) original.apply(this, args);
      if (stall === "after_post") setTimeout(hold, 10);
    });
    try { await run(); } finally { post.mockRestore(); Object.assign(workerRecovery, saved); }
  }
  test("main-thread time spent before the job reaches the worker does not count against it", async () => {
    await withShortWatchdog("before_post", 1500, false, async () => {
      respond = () => streamingReply();
      await send(JSON.stringify(requestBody(true)));
      await Bun.sleep(1800);
    });
    expect(warnings).toEqual([]);
    expect((await warm()).line).toContain("reuse_expectation=reuse reuse_reason=same_account_anchor");
  });
  test("a silent worker still faults on the deadline, and stalled main-thread time is not counted", async () => {
    await withShortWatchdog("after_post", 1000, true, async () => {
      respond = () => streamingReply();
      await send(JSON.stringify(requestBody(true)));
      for (let wait = 0; wait < 300 && !warnings.length; wait++) await Bun.sleep(10);
    });
    expect(warnings).toEqual([expect.stringMatching(/fault=deadline detail="posted=1 no_progress_ms=(\d+) timer_lag_ms=\d+" affected=1 retry_ms=1000/)]);
    const quiet = Number(/no_progress_ms=(\d+)/.exec(warnings[0]!)![1]);
    expect(quiet).toBeGreaterThanOrEqual(400);
    expect(quiet).toBeLessThan(1000);
    warnings.length = 0;
  });

  test("streaming begins before completion and valid message_start warms later turns", async () => {
    const opening = frame("message_start", { type: "message_start", message: reply() });
    let close: (() => void) | undefined;
    respond = () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(opening));
      close = () => { controller.enqueue(new TextEncoder().encode(frame("message_stop", { type: "message_stop" }))); controller.close(); };
    } }), { headers: { "content-type": "text/event-stream" } });
    const raw = JSON.stringify(requestBody(true));
    const response = await handleClaudeMessages(new Request("http://localhost/strict/v1/messages", {
      method: "POST", body: raw, headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    }), config, { model: "", provider: "" }, { requestId: crypto.randomUUID(), start: Date.now() });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(opening);
    close!();
    while (!(await reader.read()).done) { /* drain the actual response */ }
    reader.releaseLock();
    const later = await warm(raw, "/strict/v1/messages", 2048);
    expect(later.bytes).toBe(sse(2048, 0));
    expect(later.line).toContain("expected_cached_tokens=2048 lost_cached_tokens=0");
  });

  test("provider-qualified selectors observe raw prefill before client model echo", async () => {
    config.claudeCode!.strictPassthrough = false;
    saveConfig(config);
    await warm(JSON.stringify(requestBody(true)), "/v1/messages");
    const result = await send(JSON.stringify({ ...requestBody(true), model: `anthropic/${model}` }), "/v1/messages");
    expect(result.bytes).toContain(`"model":"anthropic/${model}"`);
    expect(result.line).toContain(`served_model=${model}`);
    expect(result.line).toContain("reuse_expectation=reuse reuse_reason=same_account_anchor");
  });

  test("client echo cannot hide an actual upstream model mismatch", async () => {
    config.claudeCode!.strictPassthrough = false;
    saveConfig(config);
    respond = () => new Response(sse(0, 2048).replaceAll(`"model":"${model}"`, '"model":"different-model"'), {
      headers: { "content-type": "text/event-stream" },
    });
    const result = await send(JSON.stringify(requestBody(true)), "/v1/messages");
    expect(result.bytes).toContain(`"model":"${model}"`);
    expect(result.line).toContain("reuse_expectation=unknown reuse_reason=model_mismatch");
  });

  test("completed per-send usage replaces opening cache counters and determines loss", async () => {
    await warm();
    respond = () => new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      controller.enqueue(new TextEncoder().encode(frame("message_start", { type: "message_start", message: reply() })));
      await Bun.sleep(40);
      controller.enqueue(new TextEncoder().encode(frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 1024, cache_creation_input_tokens: 1024 } })
        + frame("message_stop", { type: "message_stop" })));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
    const result = await send(JSON.stringify(requestBody(true)));
    expect(result.line).toContain("prompt_tokens=2055 cached_tokens=1024 cache_write_tokens=1024");
    expect(result.line).toContain("expected_cached_tokens=2048 lost_cached_tokens=1024");
  });

  test("the next request uses the preceding send's finalized anchor size", async () => {
    respond = () => new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      controller.enqueue(new TextEncoder().encode(frame("message_start", { type: "message_start", message: reply() })));
      await Bun.sleep(40);
      controller.enqueue(new TextEncoder().encode(frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 1024 } })
        + frame("message_stop", { type: "message_stop" })));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
    const raw = JSON.stringify(requestBody(true));
    const written = await send(raw);
    expect(written.line).toContain("cache_write_tokens=1024");
    respond = () => streamingReply(1024, 0);
    const next = await send(raw);
    expect(next.line).toContain("cached_tokens=1024 cache_write_tokens=0");
    expect(next.line).toContain("expected_cached_tokens=1024 lost_cached_tokens=0");
  });

  test("a reader finishing before its predecessor finalizes has no loss denominator", async () => {
    let finishWriter!: () => void;
    respond = () => received.length === 1 ? new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame("message_start", { type: "message_start", message: reply() })));
      finishWriter = () => { controller.enqueue(new TextEncoder().encode(frame("message_stop", { type: "message_stop" }))); controller.close(); };
    } }), { headers: { "content-type": "text/event-stream" } }) : streamingReply(1024, 0);
    const raw = JSON.stringify(requestBody(true));
    const writing = await handleClaudeMessages(new Request("http://localhost/strict/v1/messages", {
      method: "POST", body: raw, headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    }), config, { model: "", provider: "" });
    const reader = writing.body!.getReader();
    try {
      await reader.read();
      const next = await send(raw);
      expect(next.line).toContain("reuse_expectation=unknown reuse_reason=predecessor_pending");
      expect(next.line).not.toContain("expected_cached_tokens=");
      expect(next.line).not.toContain("lost_cached_tokens=");
    } finally {
      finishWriter();
      while (!(await reader.read()).done) { /* drain the writer after the reader's outcome */ }
      reader.releaseLock();
    }
  });

  test("a real buffered native combo child creates no cache observations", async () => {
    config.claudeCode!.strictPassthrough = false;
    config.combos = { "cache-child": { strategy: "failover", targets: [{ provider: "anthropic", model }] } };
    saveConfig(config);
    const result = await send(JSON.stringify({ ...requestBody(), model: "combo/cache-child" }), "/v1/messages");
    expect(received.length).toBeGreaterThan(0);
    expect(result.line).toContain("reuse_reason=combo_parent");
    expect(retainedObservations()).toBe(0);
  });

  test("native completion without a final-log owner releases a failed send", async () => {
    respond = () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "synthetic rejection" } }, { status: 400 });
    const response = await handleClaudeMessages(new Request("http://localhost/strict/v1/messages", {
      method: "POST", body: JSON.stringify(requestBody()), headers: { "content-type": "application/json" },
    }), config, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(400);
    expect(retainedObservations()).toBe(0);
  });

  test("pending admission reserves the handoff copy without blocking response delivery", async () => {
    const body = requestBody(true);
    body.messages[0]!.content[0]!.text = "x".repeat(8 * 1024 * 1024);
    const raw = JSON.stringify(body);
    const held: Response[] = [];
    respond = () => received.length <= 3
      ? new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(": waiting for prefill\n\n"));
      } }), { headers: { "content-type": "text/event-stream" } })
      : streamingReply();
    try {
      for (let index = 0; index < 3; index++) {
        const response = await handleClaudeMessages(new Request("http://localhost/strict/v1/messages", {
          method: "POST", body: raw, headers: { "content-type": "application/json" },
        }), config, { model: "", provider: "" });
        expect(response.status).toBe(200);
        held.push(response);
      }
      const result = await send(raw);
      expect(result.bytes).toBe(sse(0, 2048));
      expect(result.line).toContain("reuse_expectation=unknown reuse_reason=worker_backlog");
      expect(received).toHaveLength(4);
    } finally {
      for (const response of held) await response.body?.cancel();
    }
  }, 20000);

  test.each(["/strict/v1/messages", "/v1/messages"])("%s preserves Unicode across observation chunks", async path => {
    config.claudeCode!.strictPassthrough = false;
    saveConfig(config);
    const body = requestBody(true);
    body.messages[0]!.content[0]!.text = "界\u{10437}".repeat(40000);
    const raw = JSON.stringify(body);
    await warm(raw, path);
    respond = () => streamingReply(2048, 0);
    const result = await send(raw, path);
    expect(result.bytes).toBe(sse(2048, 0));
    expect(JSON.parse(received.at(-1)!.bytes.toString()).messages[0].content[0].text).toBe(body.messages[0]!.content[0]!.text);
    expect(result.line).toContain("expected_cached_tokens=2048 lost_cached_tokens=0");
  });

  test("count-token requests cannot create cache entries", async () => {
    respond = () => Response.json({ input_tokens: 731 });
    const counted = await send(JSON.stringify(requestBody()), "/strict/v1/messages/count_tokens");
    expect(counted.bytes).toBe('{"input_tokens":731}');
    expect(counted.line).toContain("reuse_expectation=unknown reuse_reason=count_tokens");
    expect(retainedObservations()).toBe(0);
  });

  test("local answers and combo parent finalization never create entries", () => {
    const usage = { inputTokens: 2050, outputTokens: 1, cachedInputTokens: 0, cacheCreationInputTokens: 2048, upstreamReported: true };
    const local: RequestLogContext = { provider: "anthropic", model, providerAdapter: "anthropic", localTerminalReason: "local-fixture", usage };
    addFinalRequestLog(crypto.randomUUID(), Date.now(), local, 200);
    expect(lines.at(-1)).toContain("reuse_expectation=unknown reuse_reason=local_answer");
    const parent: RequestLogContext = { provider: "anthropic", model, providerAdapter: "anthropic", comboId: "fixture-combo", usage };
    beginInferenceAttempt(parent, { provider: "anthropic", model, adapter: "anthropic" }).finish(200, usage);
    addFinalRequestLog(crypto.randomUUID(), Date.now(), parent, 200);
    expect(lines.at(-1)).toContain("reuse_expectation=unknown reuse_reason=combo_parent");
    expect(retainedObservations()).toBe(0);
  });

  test("retry account replacement uses the answering send's cache expectation and usage", async () => {
    allowRefusalWarnings = true;
    config.claudeCode!.strictPassthrough = false;
    saveConfig(config);
    await warm(JSON.stringify(requestBody(true)), "/v1/messages");
    await setAccountPaused("anthropic", accountIds[0]!, false);
    await setActiveAccount("anthropic", accountIds[0]!);
    clearAnthropicAccountPoolState();
    forgetAnthropicFailoverQuorum();
    respond = request => request.headers.get("authorization") === authorization("a")
      ? Response.json({ type: "error", error: { type: "permission_error", message: "Your account does not have access to Claude Code" }, usage: { input_tokens: 90000 } }, { status: 403 })
      : streamingReply(2048, 0);
    const before = received.length;
    const result = await send(JSON.stringify(requestBody(true)), "/v1/messages");
    expect(received.slice(before).map(request => request.key)).toEqual([authorization("a"), authorization("b")]);
    expect(warnings.some(warning => warning.includes("status=403"))).toBe(true);
    expect(result.line).toContain("prompt_tokens=2050 cached_tokens=2048 cache_write_tokens=0");
    expect(result.line).toContain("reuse_expectation=reuse reuse_reason=same_account_anchor");
    expect(result.line).toContain("expected_cached_tokens=2048 lost_cached_tokens=0");
  });

  test("configured authentication headers cannot warm the selected key's identity", async () => {
    config.claudeCode!.strictPassthrough = false;
    config.providers["key-fixture"] = { adapter: "anthropic", authMode: "key", apiKey: accessToken("selected"),
      baseUrl: "https://api.anthropic.com", models: [model] };
    respond = () => streamingReply();
    const sendKey = async (headers?: Record<string, string>) => {
      config.providers["key-fixture"]!.headers = headers;
      saveConfig(config);
      const body = requestBody(true);
      const request = new Request("http://localhost/v1/messages", { method: "POST", body: JSON.stringify(body) });
      const budget = createTranslatorBudget();
      try {
        const response = await handleNativeMessages({ req: request, config, body, requestedModel: model,
          route: routeModel(config, `key-fixture/${model}`), translatorBudget: budget,
          logCtx: { model: "", provider: "" }, logIds: { requestId: crypto.randomUUID(), start: Date.now() } });
        await response.text();
        expect(response.status).toBe(200);
        return lines.at(-1)!;
      } finally { budget.dispose(); }
    };
    const overridden = await sendKey({ "X-Api-Key": accessToken("override") });
    const selected = await sendKey();
    expect(received.slice(-2).map(request => request.key)).toEqual([accessToken("override"), accessToken("selected")]);
    expect(selected).toContain("reuse_expectation=unknown");
    expect(overridden).toContain("reuse_reason=credential_override");
    expect(overridden).not.toContain("expected_cached_tokens=");
  });

  test("an OAuth generation replacement cannot borrow the local slot's previous cache", async () => {
    await warm();
    const current = getAccountCredential("anthropic", accountIds[1]!);
    if (!current) throw new Error("missing synthetic credential");
    const { accountId: omitted, ...identityless } = current;
    await saveAccountCredential("anthropic", accountIds[1]!, { ...identityless,
      access: accessToken("replacement"), refresh: "synthetic-replacement-refresh", expires: Date.now() + 3600000 });
    const result = await send(JSON.stringify(requestBody(true)));
    expect(received.at(-1)?.key).toBe(authorization("replacement"));
    expect(result.line).toContain("reuse_expectation=unknown reuse_reason=credential_changed");
    expect(result.line).not.toContain("expected_cached_tokens=");
  });

  test("a mutable native plugin path cannot borrow the selected credential's cache", async () => {
    config.claudeCode!.strictPassthrough = false;
    saveConfig(config);
    await warm(JSON.stringify(requestBody(true)), "/v1/messages");
    const unregister = registerUpstreamRewriter("cache-fixture-credential-change", target => {
      target.headers.set("authorization", authorization("other"));
    });
    try {
      const result = await send(JSON.stringify(requestBody(true)), "/v1/messages");
      expect(received.at(-1)?.key).toBe(authorization("other"));
      expect(result.line).toContain("reuse_expectation=unknown reuse_reason=unsupported_transport");
      expect(result.line).not.toContain("expected_cached_tokens=");
    } finally { unregister(); }
  });

  test("translated and hidden-account relay finalization remains explicitly unknown", () => {
    for (const context of [
      { provider: "anthropic", model, providerAdapter: "anthropic", inboundProtocol: "responses" as const },
      { provider: "relay", model: "fixture-model", providerAdapter: "openai-responses", nativeCacheProvider: "relay", sentProvider: "relay" },
      { provider: "other", model: "fixture-model", providerAdapter: "openai-responses", nativeCacheProvider: "relay", sentProvider: "other" },
    ]) {
      addFinalRequestLog(crypto.randomUUID(), Date.now(), context, 200);
      expect(lines.at(-1)).toContain("reuse_expectation=unknown");
      expect(lines.at(-1)).toContain(`reuse_reason=${"nativeCacheProvider" in context && context.nativeCacheProvider === context.sentProvider ? "hidden_account" : "unsupported_transport"}`);
      expect(lines.at(-1)).not.toContain("expected_cached_tokens=");
    }
    expect(retainedObservations()).toBe(0);
  });

  test("different destination query parameters cannot borrow a previous observation", async () => {
    const raw = JSON.stringify(requestBody(true));
    await warm(raw, "/strict/v1/messages?variant=first");
    const other = await send(raw, "/strict/v1/messages?variant=second");
    expect(other.line).toContain("reuse_expectation=unknown");
    expect(other.line).not.toContain("expected_cached_tokens=");
  });

  test("a mismatched SSE event name cannot confirm prefill", async () => {
    respond = () => new Response(frame("ping", { type: "message_start", message: reply() })
      + frame("message_stop", { type: "message_stop" }), { headers: { "content-type": "text/event-stream" } });
    const result = await send(JSON.stringify(requestBody(true)));
    expect(result.line).toContain("reuse_expectation=unknown reuse_reason=prefill_unconfirmed");
    expect(retainedObservations()).toBe(0);
  });
});
