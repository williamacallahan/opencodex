import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget } from "../../src/combos";
import { clearAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { resetSharedPoolBackpressureForTests } from "../../src/routing/probe-lease";
import { clearThreadAccountMap } from "../../src/codex/routing/thread-affinity";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { setKeyCooldown } from "../../src/providers/api-key-cooldowns";
import { isLunaStoreMismatchResponse } from "../../src/codex/account-cooldown-response";
import { LunaReasoningOwnerError } from "../../src/adapters/openai-responses/luna-reasoning";
import { passthroughBuildErrorResponse } from "../../src/server/responses/passthrough-build-error";
import { isNonReplayableResponse } from "../../src/lib/upstream-retry";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { clearResponseStateForTests, flushResponseState, responseStatePersistPendingForTests } from "../../src/responses/state";
import { handleResponses } from "../../src/server/responses";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Handler = (url: string, body: Record<string, unknown>, headers: Headers) => Response;

const A = "luna-port-a";
const B = "luna-port-b";
let now = 1_770_000_000_000;
let home = "";
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let release: (() => void) | undefined;
let native: Handler = (_url, body) => sse(String(body.model), "native ok");
let relay: Handler = (_url, body) => sse(String(body.model), "relay ok");
let backup: Handler = (_url, body) => Response.json(responsesJson(String(body.model), "backup ok"));
let calls: Array<{ target: string; body: Record<string, unknown>; auth?: string | null }> = [];

function sse(model: string, text: string, options?: { reasoningId?: string; encrypted?: string; callId?: string }): Response {
  const output: Record<string, unknown>[] = [];
  if (options?.reasoningId) {
    output.push({
      type: "reasoning",
      id: options.reasoningId,
      summary: [{ type: "summary_text", text: "checked owner" }],
      encrypted_content: options.encrypted ?? "native-secret-blob",
    });
  }
  if (options?.callId) {
    output.push({
      type: "function_call",
      id: "fc_1",
      call_id: options.callId,
      name: "get_weather",
      arguments: "{}",
    });
  }
  output.push({
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });
  const payload = { id: `resp_${model}_${calls.length}`, object: "response", status: "completed", model, output };
  const events = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: payload.id, object: "response", status: "in_progress", model } })}\n\n`,
    ...output.map((item, output_index) =>
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`),
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`,
  ].join("");
  return new Response(events, { headers: { "content-type": "text/event-stream" } });
}

function responsesJson(model: string, text: string): Record<string, unknown> {
  return {
    id: `resp_${model}_${calls.length}`,
    object: "response",
    status: "completed",
    model,
    output: [{
      id: "msg_backup",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
  };
}

function config(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    codexAccounts: [
      { id: A, email: `${A}@example.test`, isMain: false, plan: "pro" },
      { id: B, email: `${B}@example.test`, isMain: false, plan: "pro" },
    ],
    providers: {
      openai: {
        adapter: "openai-responses",
        authMode: "forward",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        upstreamWebsocket: false,
        models: ["gpt-6-luna"],
      },
      relay: {
        adapter: "openai-responses",
        authMode: "key",
        apiKey: "relay-key",
        baseUrl: "https://relay.example.test/backend-api/codex",
        upstreamWebsocket: false,
        models: ["gpt-6-luna"],
      },
      backup: {
        adapter: "openai-responses",
        authMode: "key",
        apiKey: "backup-key",
        baseUrl: "https://backup.example.test/v1",
        models: ["gpt-6-luna"],
      },
    },
    combos: {
      luna: {
        strategy: "failover",
        waitForCooldownMs: 0,
        targets: [
          { provider: "openai", model: "gpt-6-luna" },
          { provider: "relay", model: "gpt-6-luna" },
          { provider: "backup", model: "gpt-6-luna" },
        ],
      },
    },
  };
}

function seedSpentReserveSeats(ids: string[] = [A, B]): void {
  for (const id of ids) {
    clearAccountNeedsReauth(id);
    saveCodexAccountCredential(id, {
      accessToken: `fixture-access-${id}`,
      refreshToken: `fixture-refresh-${id}`,
      chatgptAccountId: `fixture-workspace-${id}`,
      expiresAt: now + 86_400_000,
    });
    updateAccountQuota(id, 100, now + 86_400_000);
    setAccountQuotaFromParsed(id, {
      customWindows: [{ label: "Luna Reserve", percent: 25, resetAt: now + 604_800_000, observedAt: now }],
    });
  }
}

async function post(cfg: OcxConfig, raw: Record<string, unknown>, sessionId: string) {
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "thread-id": sessionId },
    body: JSON.stringify({ model: "combo/luna", input: "hello", stream: false, ...raw }),
  }), cfg, { model: "", provider: "" }, { admission: { kind: "loopback" } });
  return { status: response.status, text: await response.text() };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-luna-porting-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = join(home, "codex");
  release = acquireOwnedSpendHome();
  now = 1_770_000_000_000;
  calls = [];
  native = (_url, body) => sse(String(body.model), "native ok");
  relay = (_url, body) => sse(String(body.model), "relay ok");
  backup = (_url, body) => Response.json(responsesJson(String(body.model), "backup ok"));
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearAccountQuota();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  resetQuotaQueryBackoffForTests();
  resetSharedPoolBackpressureForTests();
  clearResponseStateForTests();
  clearReasoningReplayCacheForTests();
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const headers = new Headers(init?.headers);
    if (url.startsWith("https://chatgpt.com/backend-api/codex/responses")) {
      calls.push({ target: "native", body, auth: headers.get("authorization") });
      return native(url, body, headers);
    }
    if (url.startsWith("https://relay.example.test/backend-api/codex/")) {
      calls.push({ target: "relay", body, auth: headers.get("authorization") });
      return relay(url, body, headers);
    }
    if (url.startsWith("https://backup.example.test/v1/responses")) {
      calls.push({ target: "backup", body, auth: headers.get("authorization") });
      return backup(url, body, headers);
    }
    throw new Error(`unexpected upstream ${url}`);
  }) as typeof fetch);
});

afterEach(async () => {
  mock.restore();
  resetSharedPoolBackpressureForTests();
  release?.();
  release = undefined;
  let responseStatePending = true;
  try {
    await flushResponseState();
    responseStatePending = responseStatePersistPendingForTests();
  } finally {
    clearResponseStateForTests();
    clearReasoningReplayCacheForTests();
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearPoolRotationState();
    resetQuotaQueryBackoffForTests();
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    await flushConfigDirHardeningForTests();
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(home);
  }
  expect(responseStatePending).toBe(false);
});

const tools = [{ type: "function", name: "get_weather", description: "Weather", parameters: { type: "object", properties: {} } }];

describe("combo Luna Reserve owner cooling and store-mismatch porting (#1299)", () => {
  test("stored encrypted tool turn never moves to another store when owner and relay cool", async () => {
    const cfg = config();
    seedSpentReserveSeats();
    native = () => sse("gpt-reserve", "turn1", { reasoningId: "rs_stored", callId: "call_stored" });
    expect((await post(cfg, { tools, input: "step 1" }, "stored-owner")).status).toBe(200);
    coolComboTarget("luna", { provider: "openai", model: "gpt-6-luna" }, { now, status: 503, retryAfter: "300" });
    coolComboTarget("luna", { provider: "relay", model: "gpt-6-luna" }, { now, status: 503, retryAfter: "300" });
    calls = [];
    await post(cfg, { store: true, tools, input: [
      { type: "reasoning", id: "rs_stored", encrypted_content: "native-secret-blob", summary: [] },
      { type: "function_call", id: "fc_1", call_id: "call_stored", name: "get_weather", arguments: "{}" },
      { type: "function_call_output", call_id: "call_stored", output: "sunny" },
    ] }, "stored-owner");
    expect(calls).toEqual([]);
  });
  test("later owned reasoning cannot erase foreign reasoning across an outstanding tool call", async () => {
    const cfg = config();
    seedSpentReserveSeats();
    native = () => sse("gpt-reserve", "first", { reasoningId: "rs_native", encrypted: "native-cipher", callId: "first" });
    relay = () => sse("gpt-6-luna", "second", { reasoningId: "rs_relay", encrypted: "relay-cipher", callId: "second" });
    expect((await post(cfg, { tools, input: "start" }, "mixed-owner")).status).toBe(200);
    coolComboTarget("luna", { provider: "openai", model: "gpt-6-luna" }, { now, status: 503, retryAfter: "300" });
    const foreign = { type: "reasoning", id: "rs_native", encrypted_content: "native-cipher", summary: [] };
    const pending = { type: "function_call", call_id: "first", name: "get_weather", arguments: "{}" };
    expect((await post(cfg, { tools, input: [foreign, pending, { type: "function_call_output", call_id: "first", output: "sunny" }] }, "mixed-owner")).status).toBe(200);
    calls = [];
    const result = await post(cfg, { tools, input: [foreign, pending,
      { type: "reasoning", id: "rs_relay", encrypted_content: "relay-cipher", summary: [] },
    ] }, "mixed-owner");
    expect(result.status).toBe(409);
    expect(calls).toEqual([]);
  });

  test("cooling owner and cooling relay port cleanly to 3rd backup without 503 or foreign reasoning leak", async () => {
    const cfg = config();
    seedSpentReserveSeats();
    native = () => sse("gpt-reserve", "turn1", { reasoningId: "rs_native_1", encrypted: "native-secret-blob", callId: "call_1" });
    expect((await post(cfg, { tools, input: "step 1" }, "luna-hop-3")).status).toBe(200);

    coolComboTarget("luna", { provider: "openai", model: "gpt-6-luna" }, { now, status: 503, retryAfter: "300" });
    coolComboTarget("luna", { provider: "relay", model: "gpt-6-luna" }, { now, status: 503, retryAfter: "300" });
    calls = [];

    const turn2 = await post(cfg, {
      tools,
      input: [
        {
          type: "reasoning",
          id: "rs_native_1",
          summary: [{ type: "summary_text", text: "checked owner" }],
          encrypted_content: "native-secret-blob",
        },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "sunny" },
      ],
    }, "luna-hop-3");

    expect({ status: turn2.status, text: turn2.text, calls }).toMatchObject({ status: 200 });
    expect(turn2.text).toContain("backup ok");
    expect(calls.map(c => c.target)).toEqual(["backup"]);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("native-secret-blob");
  });

  test("in-loop native Reserve exhaustion followed by relay 503 hops cleanly to backup without Reserve lock", async () => {
    const cfg = config();
    seedSpentReserveSeats();
    native = () => sse("gpt-reserve", "turn1", { reasoningId: "rs_native_2", encrypted: "native-secret-2", callId: "call_2" });
    expect((await post(cfg, { tools, input: "step 1" }, "luna-inloop-3")).status).toBe(200);

    calls = [];
    native = () => Response.json({ error: { code: "usage_limit_reached", message: "Reserve quota spent" } },
      { status: 429, headers: { "x-should-retry": "false" } });
    relay = () => Response.json({ error: { code: "server_is_overloaded", message: "relay busy" } },
      { status: 503, headers: { "retry-after": "60", "x-should-retry": "false" } });

    const turn2 = await post(cfg, {
      tools,
      input: [
        {
          type: "reasoning",
          id: "rs_native_2",
          summary: [{ type: "summary_text", text: "checked owner" }],
          encrypted_content: "native-secret-2",
        },
        { type: "function_call", id: "fc_1", call_id: "call_2", name: "get_weather", arguments: "{}" },
        { type: "function_call_output", call_id: "call_2", output: "cloudy" },
      ],
    }, "luna-inloop-3");

    expect({ status: turn2.status, text: turn2.text, calls }).toMatchObject({ status: 200 });
    expect(turn2.text).toContain("backup ok");
    expect(calls.filter(c => c.target === "backup")).toHaveLength(1);
    expect(calls.some(c => c.target === "relay")).toBe(true);
    expect(JSON.stringify(calls.at(-1)!.body)).not.toContain("native-secret-2");
  });

  test("pre-send store-mismatch 409 and cooling distributed owner key (sendCount === 0) port off to healthy target", async () => {
    const storeMismatchRes = passthroughBuildErrorResponse(new LunaReasoningOwnerError("store-mismatch"))!;
    expect(storeMismatchRes.status).toBe(409);
    expect(isLunaStoreMismatchResponse(storeMismatchRes)).toBe(true);
    expect(isNonReplayableResponse(storeMismatchRes)).toBe(true);
    const foreignItemRes = passthroughBuildErrorResponse(new LunaReasoningOwnerError("foreign-item"))!;
    expect(foreignItemRes.status).toBe(409);
    expect(isLunaStoreMismatchResponse(foreignItemRes)).toBe(false);

    const makeRelayCfg = () => {
      const cfg = config();
      cfg.providers.relay!.requestPacing = { enabled: true, keySelection: "round-robin" };
      cfg.providers.relay!.apiKeyPool = [
        { id: "key-1", key: "relay-key" },
        { id: "key-2", key: "relay-key-2" },
      ];
      return cfg;
    };
    coolComboTarget("luna", { provider: "openai", model: "gpt-6-luna" }, { now, status: 503, retryAfter: "60" });
    relay = () => sse("gpt-6-luna", "relay-turn1", { reasoningId: "rs_relay_1", encrypted: "relay-secret-1", callId: "call_3" });

    // Case 1: owner key removed/disabled -> BoundApiKeyUnavailableError (409 marked store-mismatch, sendCount === 0)
    const cfgUnavailable = makeRelayCfg();
    expect((await post(cfgUnavailable, { tools, input: "step 1" }, "luna-store-mismatch")).status).toBe(200);
    cfgUnavailable.providers.relay!.apiKeyPool![0]!.disabled = true;
    calls = [];
    const turn2Unavailable = await post(cfgUnavailable, {
      tools,
      input: [
        {
          type: "reasoning",
          id: "rs_relay_1",
          summary: [{ type: "summary_text", text: "relay reasoning" }],
          encrypted_content: "relay-secret-1",
        },
        { type: "function_call", id: "fc_1", call_id: "call_3", name: "get_weather", arguments: "{}" },
        { type: "function_call_output", call_id: "call_3", output: "windy" },
      ],
    }, "luna-store-mismatch");
    expect({ status: turn2Unavailable.status, text: turn2Unavailable.text, calls }).toMatchObject({ status: 200 });
    expect(turn2Unavailable.text).toContain("backup ok");
    expect(calls.map(c => c.target)).toEqual(["backup"]);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("relay-secret-1");

    // Case 2: owner key still present but cooling -> keys_exhausted overload marked store-mismatch
    const cfgCooling = makeRelayCfg();
    calls = [];
    expect((await post(cfgCooling, { tools, input: "step 1" }, "luna-keys-exhausted")).status).toBe(200);
    const ownerKeyId = calls[0]?.auth === "Bearer relay-key-2" ? "key-2" : "key-1";
    setKeyCooldown("relay", ownerKeyId, now + 60_000);
    calls = [];
    const turn2Cooling = await post(cfgCooling, {
      tools,
      input: [
        {
          type: "reasoning",
          id: "rs_relay_1",
          summary: [{ type: "summary_text", text: "relay reasoning" }],
          encrypted_content: "relay-secret-1",
        },
        { type: "function_call", id: "fc_1", call_id: "call_3", name: "get_weather", arguments: "{}" },
        { type: "function_call_output", call_id: "call_3", output: "windy" },
      ],
    }, "luna-keys-exhausted");
    expect({ status: turn2Cooling.status, text: turn2Cooling.text, calls }).toMatchObject({ status: 200 });
    expect(turn2Cooling.text).toContain("backup ok");
    expect(calls.map(c => c.target)).toEqual(["backup"]);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("relay-secret-1");

    // Case 3: non-native relay owner hits store-mismatch 409 while native Reserve is healthy -> ports to native Reserve.
    clearComboTargetCooldowns("luna");
    clearKeyCooldowns();
    const cfgHealthyNative = makeRelayCfg();
    const cfgRelayFirst: OcxConfig = {
      ...cfgHealthyNative,
      combos: {
        luna: {
          strategy: "failover",
          waitForCooldownMs: 0,
          targets: [
            { provider: "relay", model: "gpt-6-luna" },
            { provider: "openai", model: "gpt-6-luna" },
            { provider: "backup", model: "gpt-6-luna" },
          ],
        },
      },
    };
    calls = [];
    seedSpentReserveSeats();
    expect((await post(cfgRelayFirst, { tools, input: "step 1" }, "luna-relay-store-mismatch")).status).toBe(200);
    cfgRelayFirst.providers.relay!.apiKeyPool![0]!.disabled = true;
    calls = [];
    const turn2Native = await post(cfgRelayFirst, {
      tools,
      input: [
        {
          type: "reasoning",
          id: "rs_relay_1",
          summary: [{ type: "summary_text", text: "relay reasoning" }],
          encrypted_content: "relay-secret-1",
        },
        { type: "function_call", id: "fc_1", call_id: "call_3", name: "get_weather", arguments: "{}" },
        { type: "function_call_output", call_id: "call_3", output: "rainy" },
      ],
    }, "luna-relay-store-mismatch");
    expect({ status: turn2Native.status, text: turn2Native.text, calls }).toMatchObject({ status: 200 });
    expect(turn2Native.text).toContain("native ok");
    expect(calls.map(c => c.target)).toEqual(["native"]);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("relay-secret-1");
  });

  test("post-dispatch porting to relay sets lunaStage so a relay 429 advances to native ordinary Luna", async () => {
    const cfg = config();
    cfg.codexMainAccountHardLock = false;
    cfg.accountPoolStrategy = "quota";
    cfg.autoSwitchThreshold = 0;
    seedSpentReserveSeats([A, B]);
    native = () => sse("gpt-reserve", "turn1", { reasoningId: "rs_native_3", encrypted: "native-secret-3", callId: "call_4" });
    expect((await post(cfg, { tools, input: "step 1" }, "luna-post-dispatch-relay")).status).toBe(200);

    for (const id of [A, B]) {
      updateAccountQuota(id, 40, now + 86_400_000);
      setAccountQuotaFromParsed(id, {
        customWindows: [{ label: "Luna Reserve", percent: 100, resetAt: now + 604_800_000, observedAt: now }],
      });
    }
    calls = [];
    let nativeCalls = 0;
    native = (_url, body) => {
      nativeCalls += 1;
      if (nativeCalls === 1) {
        return Response.json({ error: { code: "usage_limit_reached", message: "Reserve spent" } },
          { status: 429, headers: { "x-should-retry": "false" } });
      }
      return sse(String(body.model), "ordinary native ok");
    };
    relay = () => Response.json({ error: { code: "usage_limit_reached", message: "relay spent" } },
      { status: 429, headers: { "x-should-retry": "false" } });

    const turn2 = await post(cfg, {
      tools,
      input: [
        {
          type: "reasoning",
          id: "rs_native_3",
          summary: [{ type: "summary_text", text: "checked owner" }],
          encrypted_content: "native-secret-3",
        },
        { type: "function_call", id: "fc_1", call_id: "call_4", name: "get_weather", arguments: "{}" },
        { type: "function_call_output", call_id: "call_4", output: "sunny" },
      ],
    }, "luna-post-dispatch-relay");

    expect({ status: turn2.status, text: turn2.text, calls }).toMatchObject({ status: 200 });
    expect(turn2.text).toContain("ordinary native ok");
    expect(calls.map(c => c.target)).toEqual(["native", "relay", "native"]);
    expect(calls.at(-1)!.body.model).toBe("gpt-6-luna");
  });
});
