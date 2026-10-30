/**
 * Managed native Messages lane (PF-08) against fake upstreams. With
 * `protocols.rollout.managedMessagesNative` on, a direct route to a key-auth `anthropic`
 * provider receives the caller's Messages body itself (allowlisted, wire model, the provider's
 * key) instead of the Responses replay. Everything here is a local fixture: no real credential
 * or service is reached.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearKeyCooldowns, forgetApiKeyRotationCursor } from "../../src/providers/key-failover";
import { estimateClaudeRequestTokens, handleClaudeCountTokens, handleClaudeMessages } from "../../src/server/claude-messages";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import type { AdmissionLease } from "../../src/lib/admission";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { startTruncatedSseUpstream } from "../helpers/truncated-sse-upstream";
import { configureSharedSpendLedger, sharedSpendLedger, spendPolicyFromConfig, waitForSharedSpendReporterDrain } from "../../src/lib/spend-reservation-ledger";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { registerUpstreamRewriter } from "../../src/plugins/upstream-hooks";
import { activeRegistryMetrics } from "../../src/server/lifecycle";

interface Seen {
  path: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Reply = (seen: Seen, index: number) => Response;

let upstream: ReturnType<typeof Bun.serve> | undefined;
let callerForward: ReturnType<typeof Bun.serve> | undefined;
let seen: Seen[] = [];
let callerForwardSeen: Seen[] = [];
let releaseSpendHome: (() => void) | undefined;
let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-messages-native-"));
  process.env.OPENCODEX_HOME = testDir;
  clearKeyCooldowns();
  seen = [];
  callerForwardSeen = [];
});

afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  await upstream?.stop(true);
  upstream = undefined;
  await callerForward?.stop(true);
  callerForward = undefined;
  clearKeyCooldowns();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

const MESSAGE_JSON = {
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: "claude-x",
  content: [{ type: "text", text: "fixture reply" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 3 },
};

const SSE_FRAMES = [
  { event: "message_start", data: { type: "message_start", message: { ...MESSAGE_JSON, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 2 } } } },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } } },
  { event: "message_stop", data: { type: "message_stop" } },
];
const sseText = (frames: readonly { event: string; data: unknown }[]) => frames.map(frame => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join("");
const SSE_TEXT = sseText(SSE_FRAMES);
/** What the client receives: the upstream stream with its selector echoed in message_start. */
const ECHOED_SSE_TEXT = sseText(SSE_FRAMES.map((frame, index) => index === 0
  ? { ...frame, data: { ...frame.data, message: { ...(frame.data as { message: Record<string, unknown> }).message, model: "anth/claude-x" } } }
  : frame));

function ok(seenRequest: Seen): Response {
  if (seenRequest.body.stream === true) {
    return new Response(SSE_TEXT, { headers: { "content-type": "text/event-stream" } });
  }
  return Response.json(MESSAGE_JSON);
}

function startUpstream(reply: Reply = ok): number {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const entry = { path: new URL(req.url).pathname, headers: req.headers, body: await req.json() as Record<string, unknown> };
    seen.push(entry);
    return reply(entry, seen.length - 1);
  } });
  return upstream.port!;
}

function fixtureConfig(port: number, options: { on?: boolean; pool?: boolean; claudeCode?: OcxConfig["claudeCode"] } = {}): OcxConfig {
  const { on = true, pool = false } = options;
  releaseSpendHome ??= acquireOwnedSpendHome();
  const config = {
    port: 0,
    defaultProvider: "anth",
    providers: { anth: {
      adapter: "anthropic",
      baseUrl: `http://127.0.0.1:${port}`,
      authMode: "key",
      apiKey: "fixture-key-alpha",
      allowPrivateNetwork: true,
      models: ["claude-x"],
      ...(pool ? { apiKeyPool: [
        { id: "k1", key: "fixture-key-alpha", addedAt: 1 },
        { id: "k2", key: "fixture-key-beta", addedAt: 2 },
      ] } : {}),
    } },
    ...(on ? { protocols: { rollout: { managedMessagesNative: true } } } : {}),
    ...(options.claudeCode ? { claudeCode: options.claudeCode } : {}),
  } as OcxConfig;
  saveConfig(config);
  return config;
}

const SOURCE_BODY = {
  model: "anth/claude-x",
  max_tokens: 64,
  top_k: 5,
  temperature: 0.3,
  thinking: { type: "enabled", budget_tokens: 1024 },
  metadata: { user_id: "fixture-user" },
  system: [{ type: "text", text: "fixture system", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "fixture question", cache_control: { type: "ephemeral" } }] }],
  tools: [{ name: "lookup", description: "fixture tool", input_schema: { type: "object", properties: {} } }],
  // Not on the allowlist: must not reach the provider.
  context_management: { edits: [] },
};

function messagesRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function rowFor(requestId: string) {
  const rows = getRequestLogEntries().filter(entry => entry.requestId === requestId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function send(config: OcxConfig, body: Record<string, unknown>, headers?: Record<string, string>) {
  const requestId = `pf08-${crypto.randomUUID()}`;
  const response = await handleClaudeMessages(messagesRequest(body, headers), config, { model: "", provider: "" },
    { requestId, start: Date.now() });
  const text = await response.text();
  return { requestId, response, text };
}

/** Streams the first frames of a turn, then stays open until the request is aborted. */
function hangingAfterPartialTurn(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseText(SSE_FRAMES.slice(0, 3))));
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return text;
  }
}

async function settledRowFor(requestId: string) {
  for (let i = 0; i < 100 && !getRequestLogEntries().some(entry => entry.requestId === requestId); i++) {
    await Bun.sleep(10);
  }
  return rowFor(requestId);
}

describe("managed native Messages", () => {
  for (const stream of [false, true]) {
    const cases: { name: string; controls: Record<string, unknown>; expected?: string }[] = [
      ...["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(effort => ({
        name: `explicit ${effort}`, controls: { output_config: { effort }, thinking: { type: "adaptive" } }, expected: effort,
      })),
      { name: "explicit effort wins over budget", controls: { output_config: { effort: "xhigh" }, thinking: { type: "enabled", budget_tokens: 1024 } }, expected: "xhigh" },
      { name: "explicit effort wins over disabled thinking", controls: { output_config: { effort: "low" }, thinking: { type: "disabled" } }, expected: "low" },
      { name: "disabled thinking", controls: { thinking: { type: "disabled" } }, expected: "none" },
      { name: "enabled budget", controls: { thinking: { type: "enabled", budget_tokens: 1024 } }, expected: "budget:1024" },
      { name: "large enabled budget", controls: { thinking: { type: "enabled", budget_tokens: 32768 } }, expected: "budget:32768" },
      { name: "invalid effort falls back to budget", controls: { output_config: { effort: "future-tier" }, thinking: { type: "enabled", budget_tokens: 2048 } }, expected: "budget:2048" },
      { name: "invalid effort falls back to disabled", controls: { output_config: { effort: "future-tier" }, thinking: { type: "disabled" } }, expected: "none" },
      { name: "adaptive without effort", controls: { thinking: { type: "adaptive" } } },
      { name: "missing controls", controls: {} },
      ...[null, [], "high", { effort: "" }, { effort: "future-tier" }, { effort: "HIGH" }, { effort: " high " }, { effort: 3 }, { effort: "none" }].map((output_config, index) => ({
        name: `invalid output_config ${index}`, controls: { output_config },
      })),
      ...[null, [], "enabled", { type: "unknown", budget_tokens: 1024 }].map((thinking, index) => ({
        name: `invalid thinking ${index}`, controls: { thinking },
      })),
      ...[undefined, null, "1024", 0, -1, 1024.5, Number.MAX_SAFE_INTEGER + 1].map((budget_tokens, index) => ({
        name: `invalid budget ${index}`, controls: { thinking: { type: "enabled", budget_tokens } },
      })),
    ];
    for (const { name, controls, expected } of cases) test(`logs requested effort: ${name}, stream=${stream}`, async () => {
      const config = fixtureConfig(startUpstream());
      const body = { model: "anth/claude-x", max_tokens: 64, messages: [{ role: "user", content: "fixture" }], ...controls, stream };
      const wireBody = { ...JSON.parse(JSON.stringify(body)), model: "claude-x" };
      const { requestId, response } = await send(config, body);
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body).toEqual(wireBody);
      const row = rowFor(requestId);
      expect(row.protocolTrace?.mode).toBe("native");
      expect(row.requestedEffort).toBe(expected);
      expect(row.attempts).toHaveLength(1);
      expect(row.attempts![0]!.requestedEffort).toBe(expected);
      expect(row.effectiveEffort).toBeUndefined();
      expect(row.reasoningWireField).toBeUndefined();
      const persisted = readFileSync(join(testDir, "usage.jsonl"), "utf8").trim().split("\n")
        .map(line => JSON.parse(line)).filter(entry => entry.requestId === requestId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].requestedEffort).toBe(expected);
      expect(persisted[0].attempts[0].requestedEffort).toBe(expected);
    });
  }

  for (const annotation of ["high->low", ""]) test(`preserves existing requested effort ${JSON.stringify(annotation)}`, async () => {
    const config = fixtureConfig(startUpstream());
    const body = { model: "anth/claude-x", max_tokens: 64, messages: [{ role: "user", content: "fixture" }], output_config: { effort: "xhigh" }, stream: false };
    const logCtx = { model: "", provider: "", requestedEffort: annotation };
    const requestId = `pf08-${crypto.randomUUID()}`;
    const response = await handleClaudeMessages(messagesRequest(body), config, logCtx, { requestId, start: Date.now() });
    await response.text();
    expect(response.status).toBe(200);
    expect(logCtx.requestedEffort).toBe(annotation);
    expect(seen[0]!.body.output_config).toEqual(body.output_config);
    const row = rowFor(requestId);
    expect(row.protocolTrace?.mode).toBe("native");
    expect(row.requestedEffort).toBe(annotation || undefined);
    expect(row.attempts![0]!.requestedEffort).toBe(annotation || undefined);
  });

  test("key failover keeps requested effort on both physical attempts", async () => {
    const config = fixtureConfig(startUpstream((entry, index) => index === 0
      ? Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })
      : ok(entry)), { pool: true });
    const { response, requestId } = await send(config, { ...SOURCE_BODY, output_config: { effort: "xhigh" }, stream: false });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body).toEqual(seen[0]!.body);
    const row = rowFor(requestId);
    expect(row.protocolTrace?.mode).toBe("native");
    expect(row.requestedEffort).toBe("xhigh");
    expect(row.attempts).toHaveLength(2);
    expect(row.attempts!.map(attempt => attempt.requestedEffort)).toEqual(["xhigh", "xhigh"]);
  });

  for (const initiallyEnforced of [false, true]) test(`freezes ${initiallyEnforced ? "enforced" : "observe-only"} policy across retries`, async () => {
    const config = fixtureConfig(startUpstream((_entry, index) => {
      if (index === 0) configureSharedSpendLedger(spendPolicyFromConfig(
        initiallyEnforced ? {} : { pool: { maxTokens: 1 } }, undefined, ["anth"]));
      return Response.json({ type: "error", error: { type: "rate_limit_error", message: "temporary" } }, { status: 429 });
    }));
    config.providers.anth!.retryOn429 = { attempts: 5, intervalMs: 1, maxIntervalMs: 1, respectRetryAfter: false };
    configureSharedSpendLedger(spendPolicyFromConfig(initiallyEnforced ? { pool: { maxTokens: 100_000 } } : {}, undefined, ["anth"]));
    const body = { model: "anth/claude-x", messages: [{ role: "user", content: "hello" }], max_tokens: 1 };
    const { response, requestId } = await send(config, body);
    expect(rowFor(requestId).protocolTrace?.mode).toBe("native");
    expect(seen).toHaveLength(initiallyEnforced ? 4 : 6);
    expect(response.status).toBe(429);
    const records = readFileSync(join(testDir, "spend-ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records.filter(record => record.kind === "reserve")).toHaveLength(seen.length);
    if (!initiallyEnforced) {
      const next = await send(config, body);
      expect(next.response.status).toBe(429);
      expect(next.response.headers.get("x-opencodex-local-refusal")).toBe("workflow_spend_exhausted");
      expect(seen).toHaveLength(6);
    }
  }, 20_000);

  for (const change of ["disable", "raise"] as const) test(`retains its initial ceiling when ${change} occurs before key failover`, async () => {
    const body = { model: "anth/claude-x", messages: [{ role: "user", content: "hello" }], max_tokens: 1 };
    const config = fixtureConfig(startUpstream((entry, index) => {
      if (index === 0) {
        configureSharedSpendLedger(spendPolicyFromConfig(change === "disable" ? {} : { pool: { maxTokens: 100_000 } }, undefined, ["anth"]));
        return Response.json({ type: "error", error: { type: "rate_limit_error", message: "key rate limited" } },
          { status: 429, headers: { "retry-after": "30" } });
      }
      return ok(entry);
    }), { pool: true });
    configureSharedSpendLedger(spendPolicyFromConfig({ pool: { maxTokens: estimateClaudeRequestTokens(body, body.model) + 1 } }, undefined, ["anth"]));
    const { response, requestId } = await send(config, body);
    expect(rowFor(requestId).protocolTrace?.mode).toBe("native");
    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-local-refusal")).toBe("workflow_spend_exhausted");
    expect(seen).toHaveLength(1);
    const next = await send(config, body);
    expect(next.response.status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  test("sends exactly the allowlisted source body with the provider key and no caller credential", async () => {
    const config = fixtureConfig(startUpstream());
    const { requestId, response, text } = await send(config, { ...SOURCE_BODY, stream: false }, {
      authorization: "Bearer fixture-admission-token",
      "x-api-key": "fixture-caller-key",
      "anthropic-beta": "fixture-beta",
    });
    expect(response.status).toBe(200);
    // The client's selector is echoed, as on the translated lane.
    expect(JSON.parse(text)).toEqual({ ...MESSAGE_JSON, model: "anth/claude-x" });
    expect(seen).toHaveLength(1);
    const sent = seen[0]!;
    expect(sent.path).toBe("/v1/messages");
    const { context_management: _dropped, ...allowlisted } = SOURCE_BODY;
    expect(sent.body).toEqual({ ...allowlisted, stream: false, model: "claude-x" });
    expect(sent.headers.get("x-api-key")).toBe("fixture-key-alpha");
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.headers.get("anthropic-beta")).toBeNull();
    expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");

    const row = rowFor(requestId);
    expect(row.status).toBe(200);
    expect(row.usage).toMatchObject({ inputTokens: 11, outputTokens: 3 });
    expect(row.protocolTrace).toMatchObject({ inbound: "messages", mode: "native", requestPath: ["messages", "messages"] });
    expect(JSON.stringify(row)).not.toContain("fixture-key-alpha");
  });

  test("relays the upstream stream (selector echoed in message_start) and records its usage", async () => {
    const config = fixtureConfig(startUpstream());
    const { requestId, response, text } = await send(config, { ...SOURCE_BODY, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toBe(ECHOED_SSE_TEXT);
    expect(seen[0]!.body.stream).toBe(true);
    const row = rowFor(requestId);
    expect(row.status).toBe(200);
    expect(row.usage).toMatchObject({ inputTokens: 7, outputTokens: 7, cacheReadInputTokens: 2 });
  });

  test("a 401 on the first pooled key fails over to the next key", async () => {
    const config = fixtureConfig(startUpstream((entry, index) => index === 0
      ? Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })
      : ok(entry)), { pool: true });
    const { response } = await send(config, { ...SOURCE_BODY, stream: false });
    expect(response.status).toBe(200);
    expect(seen.map(entry => entry.headers.get("x-api-key"))).toEqual(["fixture-key-alpha", "fixture-key-beta"]);
    expect(seen[1]!.body).toEqual(seen[0]!.body);
  });

  test("round-robin native sends preserve per-request keys and the saved active key", async () => {
    const config = fixtureConfig(startUpstream(), { pool: true });
    config.providers.anth!.requestPacing = { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } };
    forgetApiKeyRotationCursor("anth"); saveConfig(config);
    const results = await Promise.all(Array.from({ length: 4 }, () => send(config, { ...SOURCE_BODY, stream: false })));
    expect(results.map(result => result.response.status)).toEqual([200, 200, 200, 200]);
    expect(seen.map(entry => entry.headers.get("x-api-key")).sort()).toEqual([
      "fixture-key-alpha", "fixture-key-alpha", "fixture-key-beta", "fixture-key-beta",
    ]);
    expect(config.providers.anth!.apiKey).toBe("fixture-key-alpha");
  });

  test("an exhausted distributed pool refuses the next native request without an upstream send", async () => {
    const config = fixtureConfig(startUpstream(() => Response.json({ type: "error", error: { type: "rate_limit_error", message: "fixture cooldown" } },
      { status: 429, headers: { "retry-after": "30" } })), { pool: true });
    config.providers.anth!.requestPacing = { enabled: true, keySelection: "round-robin" };
    forgetApiKeyRotationCursor("anth"); saveConfig(config);
    expect((await send(config, { ...SOURCE_BODY, stream: false })).response.status).toBe(429);
    expect(seen).toHaveLength(2);
    const next = await send(config, { ...SOURCE_BODY, stream: false });
    expect(next.response.status).toBe(429); expect(seen).toHaveLength(2);
    expect(Number(next.response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("a 429 on the first pooled key fails over to the next key", async () => {
    const config = fixtureConfig(startUpstream((entry, index) => index === 0
      ? Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        { status: 429, headers: { "retry-after": "30" } })
      : ok(entry)), { pool: true });
    const { response } = await send(config, { ...SOURCE_BODY, stream: false });
    expect(response.status).toBe(200);
    expect(seen.map(entry => entry.headers.get("x-api-key"))).toEqual(["fixture-key-alpha", "fixture-key-beta"]);
  });

  for (const { providerName, upstreamRetryAfter, expectedRetryAfter, upstreamMessage = "Rate limit exceeded", upstreamCode, expectedGuidance = providerName === "opencode-zen" } of [
    { providerName: "opencode-zen", upstreamRetryAfter: undefined, expectedRetryAfter: "15" },
    { providerName: "opencode-zen", upstreamRetryAfter: "37", expectedRetryAfter: "37" },
    { providerName: "anth", upstreamRetryAfter: undefined, expectedRetryAfter: "2" },
    { providerName: "opencode-zen", upstreamRetryAfter: undefined, expectedRetryAfter: "15", upstreamMessage: "Too Many Requests" },
    { providerName: "opencode-zen", upstreamRetryAfter: undefined, expectedRetryAfter: "2", upstreamMessage: "The usage limit has been reached", expectedGuidance: false },
    { providerName: "opencode-zen", upstreamRetryAfter: undefined, expectedRetryAfter: "2", upstreamCode: "insufficient_quota", expectedGuidance: false },
  ]) test(`native ${providerName} 429 preserves pacing policy with Retry-After ${upstreamRetryAfter ?? "absent"} and ${upstreamMessage}`, async () => {
    const config = fixtureConfig(1);
    if (providerName !== "anth") {
      config.providers[providerName] = config.providers.anth!;
      delete config.providers.anth;
      config.defaultProvider = providerName;
      config.providers[providerName]!.baseUrl = "https://opencode.ai/zen/v1";
    }
    saveConfig(config);
    // The Zen preset pins its public URL; intercept fetch so no external service is contacted.
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      seen.push({ path: new URL(request.url).pathname, headers: request.headers, body: await request.json() as Record<string, unknown> });
      return Response.json({ type: "error", error: { type: "rate_limit_error", code: upstreamCode, message: upstreamMessage } },
        { status: 429, headers: upstreamRetryAfter ? { "retry-after": upstreamRetryAfter } : {} });
    });
    let result: Awaited<ReturnType<typeof send>>;
    try {
      result = await send(config, { ...SOURCE_BODY, model: `${providerName}/claude-x`, stream: false });
    } finally {
      fetchMock.mockRestore();
    }
    const { requestId, response, text } = result;
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(expectedRetryAfter);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe(providerName === "opencode-zen" ? "/zen/v1/messages" : "/v1/messages");
    const row = rowFor(requestId);
    expect(row.protocolTrace?.mode).toBe("native");
    const envelope = JSON.parse(text);
    expect(envelope).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
    const message = envelope.error.message;
    if (expectedGuidance) {
      expect(message).toContain("15-20 requests per minute");
      expect(message).toContain("Slow the request pace");
      expect(message).toContain("providers.opencode-zen.retryOn429");
      if (upstreamRetryAfter) expect(message).not.toContain("Try again in 15s");
      else expect(message).toContain("Try again in 15s");
    } else {
      expect(message).toBe(upstreamMessage);
    }
    expect(row.upstreamError).toBe(message);
    expect(text).not.toContain("fixture-key-alpha");
  });
  test("an upstream error answers in Anthropic shape without the key", async () => {
    const config = fixtureConfig(startUpstream(() => Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "bad fixture" } }, { status: 400 })));
    const { response, text } = await send(config, { ...SOURCE_BODY, stream: false });
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ type: "error", error: { type: "invalid_request_error", message: "bad fixture" } });
    expect(text).not.toContain("fixture-key-alpha");
  });

  test("switch off: the same request still takes the Responses bridge", async () => {
    const config = fixtureConfig(startUpstream(), { on: false });
    const { requestId, response } = await send(config, { ...SOURCE_BODY, stream: false });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    // The bridge rebuilds the body through the adapter, which has no top_k.
    expect(seen[0]!.body).not.toHaveProperty("top_k");
    expect(seen[0]!.body.stream).toBe(true);
    expect(rowFor(requestId).protocolTrace).toMatchObject({ inbound: "messages", mode: "legacy-bridge" });
  });

  test("caller-forward passthrough is decided first and keeps the caller's credential", async () => {
    callerForward = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      callerForwardSeen.push({ path: new URL(req.url).pathname, headers: req.headers, body: await req.json() as Record<string, unknown> });
      return Response.json(MESSAGE_JSON);
    } });
    const config = fixtureConfig(startUpstream(), {
      claudeCode: { anthropicBaseUrl: `http://127.0.0.1:${callerForward.port}` } as OcxConfig["claudeCode"],
    });
    const { response } = await send(config, { model: "claude-haiku-4-5", max_tokens: 16, stream: false,
      messages: [{ role: "user", content: "fixture" }] }, { "x-api-key": "sk-ant-fixture-caller" });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(0);
    expect(callerForwardSeen).toHaveLength(1);
    expect(callerForwardSeen[0]!.headers.get("x-api-key")).toBe("sk-ant-fixture-caller");
  });

  test("a mid-stream upstream reset ends the relayed stream with an Anthropic error event and a failed row", async () => {
    const truncated = startTruncatedSseUpstream(sseText(SSE_FRAMES.slice(0, 3)));
    try {
      const config = fixtureConfig(truncated.port);
      const { requestId, response, text } = await send(config, { ...SOURCE_BODY, stream: true });
      expect(response.status).toBe(200);
      expect(text).toContain("streamed");
      expect(text).toContain("\n\nevent: error\ndata: ");
      expect(text).toContain('"type":"api_error"');
      expect(text).toContain("anthropic passthrough upstream stream failed: ");
      expect(truncated.requests()).toBe(1);
      const row = rowFor(requestId);
      expect(row.status).toBe(502);
      expect(row.terminalStatus).toBe("failed");
      expect(row.closeReason).toBe("terminal");
      expect(row.transportPhase).toBe("mid_stream");
      expect(row.terminalSource).toBe("synthetic");
      expect(row.failureCause).toBe("transport-ambiguous");
      expect(row.attempts?.at(-1)?.streamAborted).toBe(true);
      expect(row.upstreamError).toContain("anthropic passthrough upstream stream failed: ");
      expect(JSON.stringify(row)).not.toContain("fixture-key-alpha");
    } finally {
      truncated.stop();
    }
  });

  test("a non-streaming caller whose upstream stream resets still gets an Anthropic 502", async () => {
    const truncated = startTruncatedSseUpstream(sseText(SSE_FRAMES.slice(0, 3)));
    try {
      const config = fixtureConfig(truncated.port);
      const { requestId, response, text } = await send(config, { ...SOURCE_BODY, stream: false });
      expect(response.status).toBe(502);
      expect(JSON.parse(text)).toMatchObject({ type: "error", error: { type: "api_error" } });
      expect(text).toContain("anthropic passthrough upstream stream failed: ");
      const row = rowFor(requestId);
      // Same row as the streaming lane for the same reset.
      expect(row.status).toBe(502);
      expect(row.terminalStatus).toBe("failed");
      expect(row.closeReason).toBe("terminal");
      expect(row.transportPhase).toBe("mid_stream");
      expect(row.failureCause).toBe("transport-ambiguous");
    } finally {
      truncated.stop();
    }
  });

  test("a non-streaming fold that hits the body byte cap keeps the tap's close reason", async () => {
    const config = fixtureConfig(startUpstream(() => new Response(SSE_TEXT, { headers: { "content-type": "text/event-stream" } })),
      { claudeCode: { bodyMaxBytes: 64 } as OcxConfig["claudeCode"] });
    const { requestId, response, text } = await send(config, { ...SOURCE_BODY, stream: false });
    expect(response.status).toBe(502);
    expect(text).toContain("exceeded 64 bytes");
    const row = rowFor(requestId);
    expect(row.status).toBe(502);
    expect(row.closeReason).toBe("body_overflow");
    expect(row.terminalStatus).toBe("incomplete");
  });

  test("a relayed stream over the byte cap is a 502 incomplete row, like the passthrough", async () => {
    const config = fixtureConfig(startUpstream(ok), { claudeCode: { bodyMaxBytes: 64 } as OcxConfig["claudeCode"] });
    const { requestId, response, text } = await send(config, { ...SOURCE_BODY, stream: true });
    expect(response.status).toBe(200);
    expect(text).toContain("exceeded 64 bytes");
    const row = rowFor(requestId);
    expect(row.status).toBe(502);
    expect(row.terminalStatus).toBe("incomplete");
    expect(row.closeReason).toBe("body_overflow");
  });

  test("a relayed stream that stalls is a 502 incomplete row with the tap's reason", async () => {
    const config = fixtureConfig(startUpstream(hangingAfterPartialTurn), { claudeCode: { bodyStallSec: 1 } as OcxConfig["claudeCode"] });
    const { requestId, response, text } = await send(config, { ...SOURCE_BODY, stream: true });
    expect(response.status).toBe(200);
    expect(text).toContain('"type":"timeout_error"');
    const row = rowFor(requestId);
    expect(row.status).toBe(502);
    expect(row.terminalStatus).toBe("incomplete");
    expect(row.closeReason).toBe("body_stall");
    expect(row.upstreamError).toBe("anthropic passthrough body stalled: no upstream bytes for 1s");
  });

  test("a client that disconnects mid-stream is logged as a cancel, not an upstream failure", async () => {
    const config = fixtureConfig(startUpstream(hangingAfterPartialTurn));
    const client = new AbortController();
    const requestId = `pf08-${crypto.randomUUID()}`;
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...SOURCE_BODY, stream: true }),
      signal: client.signal,
    }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    client.abort(new DOMException("client went away", "AbortError"));
    await drain(reader);
    const row = await settledRowFor(requestId);
    expect(row.status).toBe(499);
    expect(row.closeReason).toBe("client_cancel");
    expect(row.transportPhase).toBeUndefined();
  });

  test("the lane aborting its own upstream (shutdown, turn release) is logged as a cancel", async () => {
    const config = fixtureConfig(startUpstream(hangingAfterPartialTurn));
    let turn: AbortController | undefined;
    const lease = { bindAbortController(controller: AbortController) { turn = controller; }, release() {} };
    const requestId = `pf08-${crypto.randomUUID()}`;
    const response = await handleClaudeMessages(messagesRequest({ ...SOURCE_BODY, stream: true }), config,
      { model: "", provider: "" }, { requestId, start: Date.now(), turnAdmissionLease: lease as unknown as AdmissionLease });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(turn).toBeDefined();
    turn!.abort(new Error("server shutdown"));
    const text = await drain(reader);
    expect(text).not.toContain("event: error");
    const row = await settledRowFor(requestId);
    expect(row.status).toBe(499);
    expect(row.closeReason).toBe("client_cancel");
    expect(row.upstreamError).toBeUndefined();
  });

  test("count_tokens counts the body the native lane sends", async () => {
    const config = fixtureConfig(startUpstream());
    await send(config, { ...SOURCE_BODY, stream: false });
    const sentBody = seen[0]!.body;
    const response = await handleClaudeCountTokens(new Request("http://localhost/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(SOURCE_BODY),
    }), config);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: estimateClaudeRequestTokens(sentBody, "anth/claude-x") });
    // Counting sends nothing.
    expect(seen).toHaveLength(1);
  });
});

describe("strict Messages public HTTP transport", () => {
  type Captured = { url: URL; method: string; headers: Headers; bytes: Uint8Array };
  let proxy: ReturnType<typeof import("../../src/server").startServer> | undefined;
  let physical: ReturnType<typeof Bun.serve> | undefined;
  let savedFetch: typeof fetch;
  let savedClaudeHome: string | undefined;
  let savedCodexHome: string | undefined;
  let calls: Captured[];
  let denied: number;
  let priorLogIds: Set<string>;
  const allowed = new Set<string>();
  const encode = (text: string) => new TextEncoder().encode(text);
  const raw = String.raw`{
 "model" : "claude-x", "max_tokens":64, "stream":false,
 "messages":[{"role":"user","content":"café and escaped \u0061"}],
 "future_731":{"n":9007199254740993,"exp":1e+02,"negativeZero":-0,"dup":1,"dup":2}
}`;
  const reply = encode(String.raw`{ "id":"msg_strict", "type":"message", "role":"assistant", "model":"upstream-model", "content":[{"type":"text","text":"reply","opaque":"\u0061"}], "stop_reason":"end_turn", "stop_sequence":null, "usage":{"input_tokens":7,"output_tokens":2,"future":-0} }`);
  const query = "?beta=true&future=a%2Fb&future=a+b&empty=&flag&x=%252F";

  beforeEach(() => {
    calls = []; denied = 0; allowed.clear();
    priorLogIds = new Set(getRequestLogEntries().map(row => row.requestId));
    savedFetch = globalThis.fetch;
    savedClaudeHome = process.env.CLAUDE_CONFIG_DIR;
    savedCodexHome = process.env.CODEX_HOME;
    process.env.CLAUDE_CONFIG_DIR = join(testDir, "claude");
    process.env.CODEX_HOME = join(testDir, "codex");
    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: "synthetic-unused-cli-access", refreshToken: "synthetic-unused-cli-refresh", expiresAt: Date.now() + 3_600_000,
    } }));
    const permit = (input: Parameters<typeof fetch>[0]) => {
      if (allowed.has(new URL(input instanceof Request ? input.url : String(input)).origin)) return;
      denied++;
      throw new Error("strict fixture blocked unexpected network");
    };
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      permit(input);
      return savedFetch(input, init);
    }, { preconnect: (...args: Parameters<typeof fetch.preconnect>) => { permit(args[0]); } }) as typeof fetch;
  });

  afterEach(async () => {
    try {
      await proxy?.stop(true); proxy = undefined;
      await physical?.stop(true); physical = undefined;
      await drainAndRemoveFixtureRoots({ roots: [], restoreEnvironment() {} });
      expect(denied).toBe(0);
    } finally {
      globalThis.fetch = savedFetch;
      if (savedClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedClaudeHome;
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
    }
  });

  async function launch(answer: (request: Captured) => Response = () => new Response(reply, {
    headers: { "content-type": "application/json", "request-id": "req_strict_upstream", "x-future-response": "kept" },
  }), change: (config: OcxConfig) => void = () => {}) {
    physical = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const captured = { url: new URL(request.url), method: request.method, headers: request.headers,
        bytes: new Uint8Array(await request.arrayBuffer()) };
      calls.push(captured);
      return answer(captured);
    } });
    allowed.add(physical.url.origin);
    const config = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "anth",
      providers: { anth: { adapter: "anthropic", baseUrl: physical.url.origin, authMode: "key",
        apiKey: "fixture-key-alpha", allowPrivateNetwork: true, liveModels: false, models: ["claude-x"] } },
      protocols: { rollout: { managedMessagesNative: true } },
      clientIntegrations: { codex: false }, checkForUpdates: false, syncResumeHistory: false,
      claudeCode: { strictPassthrough: true, intercept: { enabled: false } },
    } as OcxConfig;
    change(config);
    saveConfig(config);
    proxy = (await import("../../src/server")).startServer(0);
    allowed.add(proxy.url.origin);
    allowed.add(`http://127.0.0.1:${proxy.port}`);
  }

  function post(body: Uint8Array = encode(raw), path = "/v1/messages", headers: Record<string, string> = {}, signal?: AbortSignal) {
    return fetch(new URL(path + query, `http://127.0.0.1:${proxy!.port}`), { method: "POST", body, signal,
      decompress: false, redirect: "manual", headers: { "content-type": "application/json", ...headers } });
  }

  async function logged(response: Response) {
    const deadline = Date.now() + 2_000;
    while (!getRequestLogEntries().some(row => !priorLogIds.has(row.requestId)) && Date.now() < deadline) await Bun.sleep(5);
    await waitForSharedSpendReporterDrain();
    const rows = getRequestLogEntries().filter(row => !priorLogIds.has(row.requestId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(response.status);
    return rows[0]!;
  }

  test("strict lexical request and response bytes round trip through the public listener", async () => {
    await launch();
    const response = await post();
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bytes).toEqual(encode(raw));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(reply);
    expect(response.headers.get("request-id")).toBe("req_strict_upstream");
    expect(response.headers.get("x-future-response")).toBe("kept");
  });

  test("strict distributed-key refusals cool down later requests without replaying this request", async () => {
    const refusal = encode('{ "type":"error", "error":{"type":"rate_limit_error","message":"wait"} }');
    await launch(() => new Response(refusal, { status: 429, headers: { "retry-after": "30" } }), config => {
      config.providers.anth!.apiKeyPool = [{ id: "alpha", key: "fixture-key-alpha" }, { id: "beta", key: "fixture-key-beta" }];
      config.providers.anth!.requestPacing = { enabled: true, keySelection: "round-robin" };
      forgetApiKeyRotationCursor("anth");
    });
    for (let i = 0; i < 2; i++) {
      const response = await post();
      expect(response.status).toBe(429);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(refusal);
      expect(calls).toHaveLength(i + 1);
    }
    expect(new Set(calls.map(call => call.headers.get("x-api-key"))).size).toBe(2);
    const exhausted = await post();
    expect(exhausted.status).toBe(429);
    await exhausted.arrayBuffer();
    expect(calls).toHaveLength(2);
  });

  for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
    for (const compressed of [false, true]) test(`${path}: strict entity coding, query and headers (gzip=${compressed})`, async () => {
      const expected = path.endsWith("count_tokens") ? encode('{ "input_tokens" : 731, "future_count":{"n":1e+02} }') : reply;
      const requestBytes = compressed ? Bun.gzipSync(encode(raw)) : encode(raw);
      const responseBytes = compressed ? Bun.gzipSync(expected) : expected;
      await launch(() => new Response(responseBytes, { headers: {
        "content-type": "application/json; charset=utf-8", "x-future-response": "unchanged",
        "request-id": "req_strict_coded", ...(compressed ? { "content-encoding": "gzip" } : {}),
      } }), config => {
        config.upstreamRequestCompression = "gzip";
        config.spend = { pool: { maxTokens: 100_000 } };
      });
      const response = await post(requestBytes, path, {
        "anthropic-version": "2099-01-01", "anthropic-beta": "future-beta-2099,other-beta-2099",
        "x-future-client": "opaque", "x-api-key": "fixture-caller-key", authorization: "Bearer fixture-caller-token",
        "connection": "x-fixture-hop", "x-fixture-hop": "must-not-leak",
        ...(compressed ? { "content-encoding": "gzip" } : {}),
      });
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(responseBytes);
      expect(response.headers.get("content-encoding")).toBe(compressed ? "gzip" : null);
      expect(response.headers.get("request-id")).toBe("req_strict_coded");
      expect(response.headers.get("x-future-response")).toBe("unchanged");
      expect(calls).toHaveLength(1);
      const captured = calls[0]!;
      expect(captured.method).toBe("POST");
      expect(captured.url.pathname).toBe(path);
      expect(captured.url.search).toBe(query);
      expect(captured.bytes).toEqual(requestBytes);
      expect(captured.headers.get("content-encoding")).toBe(compressed ? "gzip" : null);
      expect(captured.headers.get("anthropic-version")).toBe("2099-01-01");
      expect(captured.headers.get("anthropic-beta")).toBe("future-beta-2099,other-beta-2099");
      expect(captured.headers.get("x-future-client")).toBe("opaque");
      expect(captured.headers.get("x-api-key")).toBe("fixture-key-alpha");
      expect(captured.headers.has("authorization")).toBe(false);
      expect(captured.headers.has("x-fixture-hop")).toBe(false);
      const row = await logged(response);
      const spend = sharedSpendLedger().snapshot("pool", "anth");
      if (path.endsWith("count_tokens")) {
        expect(row.usage?.inputTokens ?? 0).toBe(0);
        expect(row.usage?.outputTokens ?? 0).toBe(0);
        expect(spend?.settled ?? 0).toBe(0);
      } else {
        expect(row.usage).toMatchObject({ inputTokens: 7, outputTokens: 2 });
        expect(spend?.settled).toBe(9);
      }
      expect(spend?.reserved ?? 0).toBe(0);
      expect(spend?.unresolved ?? 0).toBe(0);
    });

    for (const prefix of ["", "/strict"]) test(`${prefix}${path}: strict configured-key scope still gates dispatch and never leaks gateway auth`, async () => {
      const key = (id: string) => `ocx_data_${id.repeat(40)}`;
      await launch(undefined, config => {
        // Authenticated listener policy; clients and the dummy upstream still use loopback only.
        config.hostname = "0.0.0.0";
        config.claudeCode!.strictPassthrough = prefix === "";
        config.apiKeys = [
          { id: "open", name: "fixture-open", key: key("a"), createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "model", name: "fixture-model", key: key("b"), createdAt: "2026-01-01T00:00:00.000Z", allowedModels: ["other-model"] },
          { id: "provider", name: "fixture-provider", key: key("c"), createdAt: "2026-01-01T00:00:00.000Z", allowedProviders: ["other-provider"] },
        ];
      });
      const unauthenticated = await post(encode(raw), prefix + path);
      expect(unauthenticated.status).toBe(401);
      await unauthenticated.arrayBuffer();
      expect(calls).toHaveLength(0);
      for (const id of ["b", "c"]) {
        const denied = await post(encode(raw), prefix + path, { "x-opencodex-api-key": key(id) });
        expect(denied.status).toBe(403);
        expect(await denied.text()).toContain("model_not_allowed_for_key");
        expect(calls).toHaveLength(0);
      }
      const permitted = await post(encode(raw), prefix + path, { "x-opencodex-api-key": key("a") });
      expect(permitted.status).toBe(200);
      await permitted.arrayBuffer();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.headers.has("x-opencodex-api-key")).toBe(false);
      expect(calls[0]!.headers.get("x-api-key")).toBe("fixture-key-alpha");
      expect(calls[0]!.bytes).toEqual(encode(raw));
    });

    test(`${path}: strict unknown fields and opaque tool history have no schema projection`, async () => {
      await launch(request => new Response(request.bytes, { headers: { "content-type": "application/json" } }));
      // Each location and spelling varies independently of any production field inventory.
      for (let i = 0; i < 4; i++) {
        const key = `future_${731 + i * 19}`;
        const body = encode(String.raw`{ "model":"claude-x", "max_tokens":64,
 "${key}":[null,false,0,[],{}], "metadata":{"${key}":1e+02}, "output_config":{"${key}":-0},
 "tools":[{"name":"custom.tool-${i}","${key}":true,"input_schema":{"type":"object","${key}":{"dup":1,"dup":2}}}],
 "messages":[{"role":"assistant","${key}":0,"content":[
 {"type":"thinking","thinking":"opaque","signature":"sig+/==\\\u0061","${key}":null},
 {"type":"redacted_thinking","data":"opaque==","${key}":false},
 {"type":"tool_use","id":"tool/id:${i}","name":"custom.tool-${i}","input":{"${key}":9007199254740993}},
 {"type":"future_block_${i}","${key}":["${String.fromCodePoint(0x1f98a)}", "\u0061"]}]},
 {"role":"user","content":[{"type":"tool_result","tool_use_id":"tool/id:${i}","content":"done","${key}":[]}]}] }`);
        expect(() => JSON.parse(new TextDecoder().decode(body))).not.toThrow();
        const response = await post(body, path);
        const returned = new Uint8Array(await response.arrayBuffer());
        expect(response.status, new TextDecoder().decode(returned)).toBe(200);
        expect(returned).toEqual(body);
        expect(calls.at(-1)!.bytes).toEqual(body);
      }
      expect(calls).toHaveLength(4);
    });
  }

  for (const status of [400, 401, 403, 429, 529, 307]) test(`strict preserves ${status} bytes without retry or redirect`, async () => {
    const bytes = encode(status === 529 ? "not JSON\u0000upstream error" : '{ "type":"error", "future":-0, "error":{"type":"future_error","message":"fixture refusal"} }');
    await launch(() => new Response(bytes, { status, headers: {
      "content-type": "application/octet-stream", "retry-after": "13", "request-id": "req_refused",
      location: `${physical!.url.origin}/redirect-target`,
    } }), config => {
      config.providers.anth!.apiKeyPool = [
        { id: "k1", key: "fixture-key-alpha", addedAt: 1 }, { id: "k2", key: "fixture-key-beta", addedAt: 2 },
      ];
    });
    const response = await post();
    expect(response.status).toBe(status);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("retry-after")).toBe("13");
    expect(response.headers.get("request-id")).toBe("req_refused");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/v1/messages");
  });

  for (const mutation of ["none", "url", "header", "auth", "connection-nomination", "rewrite-then-throw"] as const) {
    test(`strict final-send plugin mutation ${mutation} is checked before upstream`, async () => {
      await launch(undefined, config => { config.spend = { pool: { maxTokens: 100_000 } }; });
      let injected = 0;
      const unregister = registerUpstreamRewriter("strict-fixture-mutation", target => {
        injected++;
        if (mutation === "url") target.url += "&changed=1";
        if (mutation === "header") target.headers.set("anthropic-version", "changed");
        if (mutation === "auth") target.headers.set("x-api-key", "fixture-substituted-key");
        if (mutation === "connection-nomination") {
          target.headers.set("x-plugin-injected", "would-leak");
          target.headers.set("connection", "x-plugin-injected");
        }
        if (mutation === "rewrite-then-throw") {
          target.url += "&changed=1";
          throw new Error("synthetic plugin failure after rewrite");
        }
      });
      try {
        const response = await post();
        await response.arrayBuffer();
        expect(injected).toBeGreaterThan(0);
        if (mutation === "none") {
          expect(response.status).toBe(200);
          expect(calls).toHaveLength(1);
          expect(calls[0]!.bytes).toEqual(encode(raw));
        } else {
          expect(response.status).toBeGreaterThanOrEqual(400);
          expect(calls).toHaveLength(0);
        }
        await logged(response);
        const spend = sharedSpendLedger().snapshot("pool", "anth");
        expect(spend?.settled ?? 0).toBe(mutation === "none" ? 9 : 0);
        expect(spend?.reserved ?? 0).toBe(0);
        expect(spend?.unresolved ?? 0).toBe(0);
        const journal = join(testDir, "spend-ledger.jsonl");
        const records = existsSync(journal) ? readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
        expect(records.filter(record => record.kind === "dispatch")).toHaveLength(mutation === "none" ? 1 : 0);
      } finally { unregister(); }
    });
  }

  const refusals: Array<[string, (config: OcxConfig) => void, string]> = [
    ["nonboolean flag", config => { Object.assign(config.claudeCode!, { strictPassthrough: "true" }); }, raw],
    ["non-Anthropic provider", config => { config.providers.anth!.adapter = "openai-chat"; }, raw],
    ["provider-prefixed model", () => {}, raw.replace('"claude-x"', '"anth/claude-x"')],
    ["rewritten alias", config => { config.providers.anth!.modelAliases = { "claude-x": "fixture-alias" }; }, raw.replace('"claude-x"', '"fixture-alias"')],
    ["provider header override", config => { config.providers.anth!.headers = { "x-extra": "would-transform" }; }, raw],
    ["closed Messages surface", config => { config.apiSurfaces = { messages: { enabled: false } }; }, raw],
    ["missing credential", config => { config.providers.anth!.apiKey = ""; }, raw],
  ];
  for (const [name, change, body] of refusals) for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
    test(`strict ${name} refuses ${path} before network`, async () => {
      await launch(undefined, change);
      const response = await post(encode(body), path);
      await response.arrayBuffer();
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(calls).toHaveLength(0);
    });
  }

  for (const strict of [false, undefined]) test(`strict=${strict} retains managed-native projection`, async () => {
    await launch(undefined, config => { Object.assign(config.claudeCode!, { strictPassthrough: strict }); });
    for (const path of ["/strict/v1/messages", "/strict/v1/messages/count_tokens"]) {
      const preserved = await post(encode(raw), path);
      expect(preserved.status).toBe(200);
      expect(new Uint8Array(await preserved.arrayBuffer())).toEqual(reply);
      expect(calls.at(-1)!.bytes).toEqual(encode(raw));
      expect(calls.at(-1)!.url.pathname).toBe(path.slice("/strict".length));
      expect(calls.at(-1)!.url.search).toBe(query);
      expect(calls.at(-1)!.headers.has("session_id")).toBe(false);
    }
    const response = await post();
    await response.arrayBuffer();
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.bytes).not.toEqual(encode(raw));
    expect(JSON.parse(new TextDecoder().decode(calls[2]!.bytes))).not.toHaveProperty("future_731");
  });

  const opaqueSse = encode(': comment\r\nid: future-1\r\nretry: 17\r\nevent: future_event\r\ndata: {"opaque":"🦊"}\r\ndata: not-json\r\n\r\nevent: error\ndata: {"future_error":-0}\n\nevent: unfinished\ndata: {"cut":');
  test("strict gzip SSE preserves its entity while recording actual usage", async () => {
    const bytes = Bun.gzipSync(encode(SSE_TEXT));
    await launch(() => new Response(bytes, { headers: { "content-type": "text/event-stream", "content-encoding": "gzip" } }),
      config => { config.spend = { pool: { maxTokens: 100_000 } }; });
    const response = await post(encode(raw.replace('"stream":false', '"stream":true')));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect((await logged(response)).usage).toMatchObject({ inputTokens: 7, outputTokens: 7, cacheReadInputTokens: 2 });
    expect(sharedSpendLedger().snapshot("pool", "anth")).toMatchObject({ settled: 14, reserved: 0, unresolved: 0 });
    expect(calls).toHaveLength(1);
  });

  for (const end of ["eof", "cancel"] as const) test(`strict delayed count body retains its turn until ${end}`, async () => {
    let held: ReadableStreamDefaultController<Uint8Array> | undefined;
    const bytes = Bun.gzipSync(encode('{ "input_tokens":731 }'));
    const split = Math.floor(bytes.length / 2);
    const abort = new AbortController();
    await launch(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      held = controller; controller.enqueue(bytes.slice(0, split));
    } }), { headers: { "content-type": "application/json", "content-encoding": "gzip" } }),
    config => { config.spend = { pool: { maxTokens: 100_000 } }; });
    const response = await post(encode(raw), "/v1/messages/count_tokens", {}, AbortSignal.any([abort.signal, AbortSignal.timeout(3_000)]));
    const reader = response.body!.getReader();
    try {
      expect(response.status).toBe(200);
      // Observe actual client bytes before checking the lease, not merely upstream handler entry.
      const received: number[] = [];
      while (received.length < split) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false); received.push(...chunk.value!);
      }
      expect(Uint8Array.from(received)).toEqual(bytes.slice(0, split));
      expect(activeRegistryMetrics().activeTurns!.active).toBe(1);
      if (end === "eof") {
        held!.enqueue(bytes.slice(split)); held!.close();
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; received.push(...chunk.value); }
        expect(Uint8Array.from(received)).toEqual(bytes);
        await logged(response);
      } else { abort.abort(); await reader.cancel().catch(() => {}); }
      const deadline = Date.now() + 2_000;
      while (activeRegistryMetrics().activeTurns!.active !== 0 && Date.now() < deadline) await Bun.sleep(5);
      expect(activeRegistryMetrics().activeTurns!.active).toBe(0);
      await waitForSharedSpendReporterDrain();
      const spend = sharedSpendLedger().snapshot("pool", "anth");
      expect(spend?.reserved ?? 0).toBe(0);
      expect(spend?.unresolved ?? 0).toBe(0);
      expect(calls).toHaveLength(1);
    } finally { abort.abort(); await reader.cancel().catch(() => {}); }
  });

  for (const compressed of [false, true]) test(`strict opaque partial SSE has no repair or parsing (gzip=${compressed})`, async () => {
    const bytes = compressed ? Bun.gzipSync(opaqueSse) : opaqueSse;
    await launch(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // One-byte source chunks split UTF-8, CRLF and every SSE field; network coalescing is allowed.
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream", ...(compressed ? { "content-encoding": "gzip" } : {}) } }));
    const response = await post(encode(raw.replace('"stream":false', '"stream":true')));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(calls).toHaveLength(1);
  });

  test("strict SSE socket reset after output never replays or appends a replacement event", async () => {
    const prefix = ': reset after this opaque prefix\nevent: future\ndata: {"partial":';
    const reset = startTruncatedSseUpstream(prefix);
    allowed.add(`http://127.0.0.1:${reset.port}`);
    const abort = new AbortController();
    try {
      await launch(undefined, config => { config.providers.anth!.baseUrl = `http://127.0.0.1:${reset.port}`; });
      const response = await post(encode(raw.replace('"stream":false', '"stream":true')), "/v1/messages", {}, abort.signal);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const received: number[] = [];
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received.push(...chunk.value);
        }
      } catch { /* A transport reset may be exposed as a body error, never as invented SSE. */ }
      finally { await reader.cancel().catch(() => {}); }
      expect(Uint8Array.from(received)).toEqual(encode(prefix));
      expect(reset.requests()).toBe(1);
    } finally { abort.abort(); reset.stop(); }
  });

  test("strict SSE delivers a prefix before EOF and cancellation releases upstream", async () => {
    const cancelled = Promise.withResolvers<void>();
    const prefix = encode(": first bytes, not a recognized event\n\n");
    await launch(() => calls.length === 1 ? new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(prefix); },
      cancel() { cancelled.resolve(); },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }) : new Response(reply), config => {
      config.providers.anth!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
    });
    const abort = new AbortController();
    const response = await post(encode(raw.replace('"stream":false', '"stream":true')), "/v1/messages", {}, abort.signal);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      const received: number[] = [];
      while (received.length < prefix.length) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        received.push(...chunk.value!);
      }
      expect(Uint8Array.from(received)).toEqual(prefix);
      abort.abort();
      await cancelled.promise;
      const next = await post();
      expect(next.status).toBe(200);
      await next.arrayBuffer();
      expect(calls).toHaveLength(2);
    } finally {
      abort.abort();
      await reader.cancel().catch(() => {});
    }
  }, 10_000);
});
