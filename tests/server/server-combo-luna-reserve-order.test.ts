import { clearResponseStateForTests } from "../../src/responses/state";
import { clearReasoningReplayCacheForTests, rememberIssuedReasoning } from "../../src/responses/reasoning-replay-cache";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { listLiveComboTargetKeys } from "../../src/combos/types";
import { shouldRetryCodexPoolAccountQuota } from "../../src/server/responses/core-codex-account";
import { sendReserveSeat } from "../../src/server/responses/reserve-seat-dispatch";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { comboExecutionBudgetPolicy } from "../../src/server/responses/core-combo";
import { planLunaReserveLegs } from "../../src/server/responses/combo-luna-legs";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown } from "../../src/combos";
import { issueTurnStateHandle, TURN_STATE_HEADER, turnStateBinding } from "../../src/server/turn-state-handles";
import { clearComboRecallForTests, reconcileComboRecall } from "../../src/server/responses/combo-session-recall";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import { tryReserveCodexWebSocket } from "../../src/codex/websocket-registry";
import { buildResponsesWsData, type WsData } from "../../src/server/ws-bridge";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { RequestLogContext } from "../../src/server/request-log";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import { readUsageEntries } from "../../src/usage/log";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { createProtocolEnvelope } from "../../src/protocols/envelope";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { CODEX_TEXT_GUARDED_BUDGET_POLICY, createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY } from "../../src/lib/spend-reservation-ledger";
import { createInferenceSendBudget } from "../../src/server/inference/context";
import { attachRequestSpendTracker, createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { sharedPoolBackpressure, configureSharedPoolBackpressure, DEFAULT_POOL_BACKPRESSURE_POLICY, resetSharedPoolBackpressureForTests } from "../../src/routing/probe-lease";

import { RequestPacingQueueOverloadError, providerRequestPacingStatus, resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import { markCodexWsPreludeProjection, isCodexWsPreludeProjection } from "../../src/server/responses/codex-ws-wire";
import { decodeCompactionSummary } from "../../src/responses/compaction";

const A = "luna-order-a";
const B = "luna-order-b";
const clientFetch = globalThis.fetch;
const local: DataPlaneAdmission = { kind: "loopback", source: "loopback" };
let home = "";
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let release: (() => void) | undefined;
let now = 0;
type Call = string;
let calls: Call[] = [];
let nativeHints: (string | null)[] = [];
let nativeAccounts: (string | null)[] = [];
const standardRelayUrl = "https://relay.example.test/backend-api/codex/v1/responses";
let relayUrl: string;
let relay: (request: Request, body: { model: string }) => Response | Promise<Response>;
let native: (body: { model: string }) => Response | Promise<Response>;
let metered: () => Response;

function sse(model: string, frames: "ok" | "created-then-fail" | "created-then-quota" | "output-then-quota", quotaCode = "usage_limit_reached", rootCode?: string): Response {
  const created = { type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress", model, output: [] } };
  const delta = { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hi" };
  const body = frames === "ok" ? [created, delta,
    { type: "response.completed", response: { ...created.response, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] }] } }]
    : [created, ...(frames === "output-then-quota" ? [delta] : []), { type: "response.failed", code: rootCode, response: { ...created.response, status: "failed",
      error: frames === "created-then-fail" ? { code: "server_error", message: "boom" } : { code: quotaCode, message: "Limit reached" } } }];
  return new Response(body.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
const reserveRefused = () => Response.json({ error: { code: "usage_limit_reached", message: "Limit reached" } }, { status: 429, headers: { "retry-after": "3600" } });
const refusedConnect = () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); };

function issuedReasoning(model: string, item: Record<string, unknown>): Response {
  const response = { id: "resp_proof", object: "response", status: "completed", model, output: [item] };
  return new Response(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`
    + `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } });
}
function config(extraProviders: OcxConfig["providers"] = {}, targets?: NonNullable<OcxConfig["combos"]>[string]["targets"]): OcxConfig {
  return {
    port: 0, defaultProvider: "openai", codexMainAccountHardLock: false, accountPoolStrategy: "quota", autoSwitchThreshold: 0,
    activeCodexAccountId: A, creditCodexAccountIds: [],
    codexAccounts: [A, B].map(id => ({ id, email: `${id}@example.test`, isMain: false, plan: "pro" as const })),
    providers: {
      openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: "pool", upstreamWebsocket: false },
      relay: { adapter: "openai-responses", authMode: "key", apiKey: "relay-key", baseUrl: "https://relay.example.test/backend-api/codex" },
      metered: { adapter: "openai-responses", authMode: "key", apiKey: "metered-key", baseUrl: "https://metered.example.test/v1" },
      ...extraProviders,
    },
    combos: { luna: { strategy: "failover", allowMeteredTargets: true, targets: targets ?? [
      { provider: "openai", model: "gpt-6-luna" }, { provider: "relay", model: "gpt-6-luna" },
      { provider: "metered", model: "gpt-6-luna", metered: true },
    ] } },
  };
}
/** B is depleted but holds a fresh Reserve grant, A still has included Luna usage. */
function seats(reserveOnB = true) {
  updateAccountQuota(A, 40, now + 86_400_000); updateAccountQuota(B, 100, now + 86_400_000);
  setAccountQuotaFromParsed(B, { customWindows: [{ label: "Luna Reserve", percent: reserveOnB ? 25 : 100, resetAt: now + 604_800_000, observedAt: now }] });
}
async function post(cfg: OcxConfig, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, signal?: AbortSignal,
  { logCtx = { model: "", provider: "" }, sendBudget }: { logCtx?: RequestLogContext; sendBudget?: ReturnType<typeof createRequestExecutionBudget> } = {}) {
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", signal,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "combo/luna", input: "ping", stream: true, prompt_cache_key: "luna-order", ...extra }) }),
    cfg, logCtx, { admission: local, sendBudget, ...(signal ? { abortSignal: signal } : {}) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME; previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-luna-order-"));
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
  const acl = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => acl); setAsyncIcaclsRunnerForTests(async () => acl);
  release = acquireOwnedSpendHome();
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); resetQuotaQueryBackoffForTests();
  clearComboSelectionState(); clearComboRecallForTests(); clearComboTargetCooldowns();
  for (const id of [A, B]) {
    clearAccountNeedsReauth(id);
    saveCodexAccountCredential(id, { accessToken: `fixture-access-${id}`, refreshToken: `fixture-refresh-${id}`,
      chatgptAccountId: `fixture-workspace-${id}`, expiresAt: now + 86_400_000 });
  }
  clearAccountNeedsReauth("__main__");
  calls = []; nativeHints = []; nativeAccounts = [];
  native = body => sse(body.model, "ok");
  relayUrl = standardRelayUrl;
  relay = () => sse("gpt-6-luna", "ok");
  metered = () => sse("gpt-6-luna", "ok");
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.clone().json() as { model: string };
    if (request.url === CODEX_RESPONSES_HTTP_URL) { calls.push(`native:${body.model}`); nativeHints.push(request.headers.get("x-codex-routing-hint")); nativeAccounts.push(request.headers.get("chatgpt-account-id")); return native(body); }
    if (request.url === relayUrl) { calls.push(`relay:${body.model}`); return relay(request, body); }
    if (request.url === "https://metered.example.test/v1/responses") { calls.push(`metered:${body.model}`); return metered(); }
    throw new Error(`unexpected upstream ${request.url}`);
  }, { preconnect() {} }));
});
afterEach(async () => {
  mock.restore(); resetSharedPoolBackpressureForTests(); release?.(); release = undefined;
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); resetQuotaQueryBackoffForTests();
  clearComboSelectionState(); clearComboRecallForTests(); clearComboTargetCooldowns();
  await flushConfigDirHardeningForTests(); setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

describe("combo Luna leg order: native Reserve, relay, native ordinary, metered", () => {
  function threeSpentSeats(): OcxConfig {
    const cfg = config();
    const third = "luna-order-c";
    cfg.codexAccounts!.push({ id: third, email: `${third}@example.test`, isMain: false, plan: "pro" });
    clearAccountNeedsReauth(third);
    saveCodexAccountCredential(third, { accessToken: `fixture-access-${third}`, refreshToken: `fixture-refresh-${third}`,
      chatgptAccountId: `fixture-workspace-${third}`, expiresAt: now + 86_400_000 });
    for (const id of [A, B, third]) {
      updateAccountQuota(id, 100, now + 86_400_000);
      setAccountQuotaFromParsed(id, { customWindows: [{ label: "Luna Reserve", percent: 25, resetAt: now + 604_800_000, observedAt: now }] });
    }
    return cfg;
  }

  test.each([
    ["seat reset and body advice", undefined, 60_000],
    ["short Retry-After", "1", 1_000],
    ["weekly Retry-After", "604800", 300_000],
  ] as const)("relay quota: %s holds only Luna until its relay deadline", async (_, retryAfter, delay) => {
    const luna = { provider: "relay", model: "gpt-6-luna" };
    const sol = { provider: "relay", model: "gpt-6.2-sol" };
    const cfg = config({}, [luna, sol]);
    if (retryAfter === "1") {
      // This relay uses a different URL shape and pools only its Luna model.
      cfg.providers.relay!.baseUrl = "https://relay.example.test/v1";
      cfg.providers.relay!.modelCapabilities = { [luna.model]: { upstreamSeatPool: true } };
      relayUrl = "https://relay.example.test/v1/responses";
    }
    cfg.providers.relay!.upstreamWebsocket = false;
    cfg.combos!.luna!.waitForCooldownMs = 0;
    relay = (_, body) => body.model === sol.model ? sse(sol.model, "ok") : Response.json({ error: {
      code: retryAfter === undefined ? "usage_limit_reached" : "insufficient_quota", message: "Weekly quota exhausted. Try again in 144 hours.",
    } }, { status: 502, headers: { "x-should-retry": "false", "x-codex-secondary-reset-at": String((now + 604_800_000) / 1000),
      ...(retryAfter ? { "retry-after": retryAfter } : {}) } });
    await post(cfg);
    expect(isComboTargetInCooldown("luna", luna, now + delay - 1)).toBe(true);
    expect(isComboTargetInCooldown("luna", sol)).toBe(false);
    now += delay;
    calls.length = 0;
    relay = (_, body) => sse(body.model, "ok");
    expect((await post(cfg)).text).toContain("response.completed");
    expect(calls).toEqual(["relay:gpt-6-luna"]);
  });

  test.each([true, false])("a zero-output billing prelude does not turn seat reset prose into a relay header (stream: %s)", async stream => {
    const luna = { provider: "relay", model: "gpt-6-luna" };
    const cfg = config({}, [luna]);
    cfg.combos!.luna!.waitForCooldownMs = 0;
    cfg.providers.relay!.upstreamWebsocket = false;
    relay = () => new Response(`data: ${JSON.stringify({ type: "error", status: 502, error: {
      code: "usage_limit_exceeded", message: "The usage limit has been reached. Try again in 144 hours.",
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    await post(cfg, { stream });
    expect(isComboTargetInCooldown("luna", luna, now + 59_999)).toBe(true);
    now += 60_000;
    relay = () => sse(luna.model, "ok");
    expect((await post(cfg)).text).toContain("response.completed");
  });

  test("a non-relay Responses target keeps its full quota Retry-After for the same Luna model", async () => {
    const luna = { provider: "direct", model: "gpt-6-luna" };
    const cfg = config({ direct: { adapter: "openai-responses", baseUrl: "https://metered.example.test/v1", apiKey: "direct-key" } }, [luna]);
    cfg.combos!.luna!.waitForCooldownMs = 0;
    metered = () => Response.json({ error: { code: "insufficient_quota", message: "Weekly quota exhausted" } },
      { status: 502, headers: { "retry-after": "86400", "x-should-retry": "false" } });
    expect((await post(cfg)).status).toBe(502);
    expect(isComboTargetInCooldown("luna", luna, now + 86_399_999)).toBe(true);
    expect(isComboTargetInCooldown("luna", luna, now + 86_400_000)).toBe(false);
  });

  test.each([
    ["120", 120_000], ["86400", 300_000], ["invalid", 7_000], [undefined, 7_000],
  ] as const)("relay overload honors its wire Retry-After (%s), not a seat's reset prose", async (retryAfter, delay) => {
    const luna = { provider: "relay", model: "gpt-6-luna" };
    const cfg = config({}, [luna]);
    cfg.providers.relay!.upstreamWebsocket = false;
    Object.assign(cfg.combos!.luna!, { cooldownMs: 7_000, waitForCooldownMs: 0 });
    relay = () => Response.json({ error: { code: "server_is_overloaded", message: "Gateway busy. Try again in 144 hours." } },
      { status: 503, headers: { "x-should-retry": "false", ...(retryAfter && { "retry-after": retryAfter }) } });
    expect((await post(cfg)).status).toBe(503);
    expect(isComboTargetInCooldown("luna", luna, now + delay - 1)).toBe(true);
    expect(isComboTargetInCooldown("luna", luna, now + delay)).toBe(false);
  });

  test.each([503, 404])("a slow %i body cannot shorten a newer live relay hold", async status => {
    const luna = { provider: "relay", model: "gpt-6-luna" };
    const cfg = config({}, [luna]);
    cfg.providers.relay!.upstreamWebsocket = false;
    cfg.combos!.luna!.waitForCooldownMs = 0;
    const readStarted = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    relay = () => new Response(new ReadableStream({ async pull(controller) {
      readStarted.resolve(); await resume.promise;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { code: status === 503 ? "server_is_overloaded" : "model_not_found" } }))); controller.close();
    } }), { status, headers: status === 503 ? { "retry-after": "120", "x-should-retry": "false" } : undefined });
    const earlier = post(cfg);
    await readStarted.promise;
    coolComboTarget("luna", luna, { now, status: 503, retryAfter: "300" });
    resume.resolve();
    expect((await earlier).status).toBe(status);
    expect(isComboTargetInCooldown("luna", luna, now + 299_999)).toBe(true);
    expect(isComboTargetInCooldown("luna", luna, now + 300_000)).toBe(false);
  });

  test("a single relay waits for the preserved hold and retries only once", async () => {
    const luna = { provider: "relay", model: "gpt-6-luna" };
    const cfg = config({}, [luna]);
    cfg.providers.relay!.upstreamWebsocket = false;
    Object.assign(cfg.combos!.luna!, { cooldownMs: 10, waitForCooldownMs: 1_000 });
    const sends: number[] = [];
    relay = () => {
      sends.push(performance.now());
      if (sends.length === 1) coolComboTarget("luna", luna, { now, cooldownMs: 120, status: 503 });
      return Response.json({ error: { message: `relay attempt ${calls.length}` } }, { status: 503, headers: { "x-should-retry": "false" } });
    };
    const result = await post(cfg);
    expect(result.status).toBe(503);
    expect(result.text).toContain("relay attempt 2");
    expect(sends).toHaveLength(2);
    expect(sends[1]! - sends[0]!).toBeGreaterThanOrEqual(119);
  });

  test("a third Reserve seat serves after two seats refuse", async () => {
    const cfg = threeSpentSeats();
    native = body => nativeAccounts.length < 3 ? reserveRefused() : sse(body.model, "ok");
    const result = await post(cfg);
    expect(result.text).toContain("response.completed");
    expect(calls).toEqual(["native:gpt-reserve", "native:gpt-reserve", "native:gpt-reserve"]);
    expect(new Set(nativeAccounts).size).toBe(3);
  });

  test("an alternate's empty SSE quota refusal can move to the third seat", async () => {
    const cfg = threeSpentSeats();
    native = body => nativeAccounts.length === 1 ? reserveRefused() : nativeAccounts.length === 2
      ? sse(body.model, "created-then-quota") : sse(body.model, "ok");
    const result = await post(cfg);
    expect(result.text).toContain("response.completed");
    expect(result.text).not.toContain("usage_limit_reached");
    expect(calls).toEqual(["native:gpt-reserve", "native:gpt-reserve", "native:gpt-reserve"]);
  });

  test("a quota terminal after alternate-seat output stays on that seat", async () => {
    const cfg = threeSpentSeats();
    native = body => nativeAccounts.length === 1 ? reserveRefused() : sse(body.model, "output-then-quota");
    const result = await post(cfg);
    expect(result.text).toContain("response.output_text.delta");
    expect(result.text).toContain("response.failed");
    expect(calls).toEqual(["native:gpt-reserve", "native:gpt-reserve"]);
  });

  test("a Reserve refusal at the leg deadline goes to the relay", async () => {
    const cfg = threeSpentSeats();
    cfg.connectTimeoutMs = 2_000;
    native = () => { now += 2_000; return reserveRefused(); };
    expect((await post(cfg)).text).toContain("response.completed");
    expect(calls).toEqual(["native:gpt-reserve", "relay:gpt-6-luna"]);
  });

  test("all refused Reserve seats are tried before the relay", async () => {
    const cfg = threeSpentSeats();
    native = reserveRefused;
    const result = await post(cfg);
    expect(result.text).toContain("response.completed");
    expect(calls).toEqual(["native:gpt-reserve", "native:gpt-reserve", "native:gpt-reserve", "relay:gpt-6-luna"]);
    expect(new Set(nativeAccounts).size).toBe(3);
  });

  function addUnreportedSpentSeat(cfg: OcxConfig, id: string): void {
    cfg.codexAccounts!.push({ id, email: `${id}@example.test`, isMain: false, plan: "pro" });
    saveCodexAccountCredential(id, { accessToken: `fixture-${id}`, refreshToken: `fixture-refresh-${id}`,
      chatgptAccountId: `fixture-workspace-${id}`, expiresAt: now + 86_400_000 });
    updateAccountQuota(id, 100, now + 86_400_000);
  }

  function eightSpentSeats() {
    const cfg = threeSpentSeats();
    for (const id of ["walk-d", "walk-e", "walk-f", "walk-g", "walk-h"]) addUnreportedSpentSeat(cfg, id);
    return cfg;
  }

  test.each([false, true])("a Reserve rate_limit_exceeded never spends included Luna (all refuse: %s)", async allRefuse => {
    const cfg = config();
    updateAccountQuota(A, 100, now + 86_400_000);
    setAccountQuotaFromParsed(A, { customWindows: [{ label: "Luna Reserve", percent: 25, resetAt: now + 604_800_000, observedAt: now }] });
    updateAccountQuota(B, 20, now + 86_400_000);
    addUnreportedSpentSeat(cfg, "walk-c");
    // A live inherited booking limits headroom, not which eligible Reserve seats the selector may try.
    const sendBudget = createRequestExecutionBudget(comboExecutionBudgetPolicy(4));
    const prior = sendBudget.reserveDispatch({ sendClass: "initial", targetKey: "prior" });
    if (!prior.allowed) throw new Error("fixture booking refused");
    try {
      native = body => allRefuse || nativeAccounts.length === 1
        ? Response.json({ error: { code: "rate_limit_exceeded", type: "rate_limit_error" } }, { status: 429 }) : sse(body.model, "ok");
      const result = await post(cfg, {}, {}, undefined, { sendBudget });
      expect(result.text).toContain("response.completed");
      expect(nativeAccounts).toEqual([`fixture-workspace-${A}`, "fixture-workspace-walk-c"]);
      expect(calls).toEqual(["native:gpt-reserve", "native:gpt-reserve", ...(allRefuse ? ["relay:gpt-6-luna"] : [])]);
    } finally { prior.permit.release(); }
  });

  test("a strict child resolving to an ordinary Responses wire sends nothing", async () => {
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "relay/gpt-6-luna", input: "ping", stream: true }),
    }), config(), { model: "", provider: "" }, { admission: local, comboAttempt: true, poolCapacityIntent: "reserve-only" });
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("nothing was sent");
    expect(calls).toEqual([]);
  });

  test("a single Reserve seat retries its transient 502 on the same seat", async () => {
    seats();
    native = body => nativeAccounts.length === 1 ? new Response("bad gateway", { status: 502 }) : sse(body.model, "ok");
    expect((await post(config())).text).toContain("response.completed");
    expect(nativeAccounts).toEqual([`fixture-workspace-${B}`, `fixture-workspace-${B}`]);
    expect(calls).toEqual(["native:gpt-reserve", "native:gpt-reserve"]);
  });

  test("unused Reserve slots cannot fund the last relay model's third send", async () => {
    const cfg = eightSpentSeats();
    cfg.combos!.luna!.targets[2] = { provider: "relay", model: "gpt-6-sol" };
    // A provider-wide refusal ends a large walk after one send. Only the ordinary combo allowance survives.
    native = () => Response.json({ error: { message: "Monthly usage limit reached" } }, { status: 429 });
    relay = (_request, body) => body.model === "gpt-6-sol" && calls.filter(call => call === "relay:gpt-6-sol").length === 3
      ? sse(body.model, "ok") : new Response("bad gateway", { status: 502 });
    const result = await post(cfg);
    expect(result.text).not.toContain("response.completed");
    expect(calls).toEqual(["native:gpt-reserve", ...Array(3).fill("relay:gpt-6-luna"), ...Array(2).fill("relay:gpt-6-sol")]);
  });

  test("the default pool window refuses a fourth move and the relay serves without waiting", async () => {
    const cfg = eightSpentSeats();
    native = reserveRefused;
    const result = await post(cfg, {}, {}, AbortSignal.timeout(2_000));
    expect(result.text).toContain("response.completed");
    expect(calls).toEqual([...Array(4).fill("native:gpt-reserve"), "relay:gpt-6-luna"]);
    expect(new Set(nativeAccounts).size).toBe(4);
  });

  test.each([false, true])("a window admitting seven moves books each physical send once (enforced: %s)", async enforced => {
    const cfg = eightSpentSeats();
    configureSharedPoolBackpressure({ ...DEFAULT_POOL_BACKPRESSURE_POLICY, minRecoveryAllowance: 7 });
    native = reserveRefused;
    const lines: string[] = [];
    const ledger = createSpendReservationLedger({
      journal: { read: () => [...lines], append: line => { lines.push(line); }, rewrite: next => { lines.splice(0, lines.length, ...next); } },
      policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, root: enforced ? { maxTokens: 1_000_000 } : {} },
    });
    const logCtx: RequestLogContext = { model: "combo/luna", provider: "combo", spendInputEstimateTokens: 1 };
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", "x-codex-parent-thread-id": "reserve-walk" },
      body: JSON.stringify({ model: "combo/luna", input: "ping", stream: true }) });
    const tracker = attachRequestSpendTracker(req, logCtx, ledger);
    const budget = createInferenceSendBudget(req, logCtx);
    try {
      const response = await handleResponses(req, cfg, logCtx, { admission: local, sendBudget: budget });
      expect(await response.text()).toContain("response.completed");
      expect(calls).toEqual([...Array(8).fill("native:gpt-reserve"), "relay:gpt-6-luna"]);
      expect(new Set(nativeAccounts).size).toBe(8);
      expect(budget.used).toBe(9);
      if (enforced) expect(budget.physicalStarted).toBe(9);
    } finally { tracker.settle(logCtx.usage); }
    expect(lines.filter(line => JSON.parse(line).kind === "dispatch")).toHaveLength(9);
  });

  function twoSpentSeats() {
    const cfg = threeSpentSeats();
    cfg.codexAccounts = cfg.codexAccounts!.filter(account => account.id === A || account.id === B);
    return cfg;
  }

  test.each(["before the move", "after the move"])("a fast transient failure %s does not cancel Reserve placement", async timing => {
    const cfg = twoSpentSeats();
    native = body => {
      const firstSeat = nativeAccounts.at(-1) === nativeAccounts[0];
      if (timing === "before the move" && firstSeat && nativeAccounts.length <= 2
        || timing === "after the move" && !firstSeat && nativeAccounts.length === 2) return new Response("upstream busy", { status: 502 });
      return firstSeat ? reserveRefused() : sse(body.model, "ok");
    };
    expect((await post(cfg)).text).toContain("response.completed");
    expect(calls).toEqual(Array(timing === "before the move" ? 4 : 3).fill("native:gpt-reserve"));
    expect(new Set(nativeAccounts).size).toBe(2);
  });

  test("a third send on one seat does not buy a third send on the relay", async () => {
    const cfg = eightSpentSeats();
    cfg.combos!.luna!.targets[2] = { provider: "relay", model: "gpt-6-sol" };
    native = () => nativeAccounts.length < 3 ? new Response("bad gateway", { status: 502 })
      : Response.json({ error: { message: "Monthly usage limit reached" } }, { status: 429 });
    relay = (_req, body) => body.model === "gpt-6-sol" || calls.filter(call => call === "relay:gpt-6-luna").length === 3
      ? sse(body.model, "ok") : new Response("busy", { status: 502 });
    expect((await post(cfg)).text).toContain("response.completed");
    expect(calls).toEqual([...Array(3).fill("native:gpt-reserve"), "relay:gpt-6-luna", "relay:gpt-6-luna", "relay:gpt-6-sol"]);
  });

  async function waitForNativeQueue(cfg: OcxConfig) {
    for (let i = 0; i < 500 && !providerRequestPacingStatus("openai", cfg.providers.openai!).queued; i++) await Bun.sleep(1);
    expect(providerRequestPacingStatus("openai", cfg.providers.openai!).queued).toBe(1);
  }

  test("an enforced pre-wire refusal charges the relay but not the cooled Reserve seat", async () => {
    const cfg = config(); seats(); cfg.providers.openai!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
    const journal: string[] = [];
    const ledger = createSpendReservationLedger({ policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, root: { maxTokens: 1_000_000 } },
      journal: { read: () => [...journal], append: line => { journal.push(line); }, rewrite: next => { journal.splice(0, journal.length, ...next); } } });
    const logCtx: RequestLogContext = { model: "combo/luna", provider: "combo", spendInputEstimateTokens: 1 };
    const tracker = createRequestSpendTracker(logCtx, "reserve-before-pacing", ledger);
    const sendBudget = createRequestExecutionBudget(undefined, undefined, tracker);
    const blocker = await waitForProviderRequestSlot("openai", cfg.providers.openai!, "gpt-6-luna");
    const pending = post(cfg, {}, {}, undefined, { logCtx, sendBudget });
    try {
      await waitForNativeQueue(cfg);
      recordCodexUpstreamOutcome(cfg, B, 429, { now, modelId: "gpt-6-luna", poolReserve: true, retryAfter: "3600" });
      blocker.release();
      expect((await pending).text).toContain("response.completed");
      expect(calls).toEqual(["relay:gpt-6-luna"]);
      expect(sendBudget.physicalStarted).toBe(1); expect(sendBudget.used).toBe(1);
    } finally { blocker.release(); await pending; resetProviderRequestPacingForTest(); tracker.settle(logCtx.usage); }
    expect(journal.filter(line => JSON.parse(line).kind === "dispatch")).toHaveLength(1);
  });

  test("a queued alternate that regains included usage is skipped without losing the next seat", async () => {
    const cfg = twoSpentSeats(); addUnreportedSpentSeat(cfg, "still-spent");
    cfg.providers.openai!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
    const blockerReady = Promise.withResolvers<Awaited<ReturnType<typeof waitForProviderRequestSlot>>>();
    const controller = new AbortController();
    native = body => {
      if (nativeAccounts.length === 1) {
        blockerReady.resolve(waitForProviderRequestSlot("openai", cfg.providers.openai!, "gpt-6-luna", controller.signal));
        return reserveRefused();
      }
      return sse(body.model, "ok");
    };
    const pending = post(cfg, {}, {}, controller.signal);
    const blocker = await Promise.race([blockerReady.promise, pending.then(() => { throw new Error("first Reserve seat did not send"); })]);
    try {
      await waitForNativeQueue(cfg);
      const stale = nativeAccounts[0] === `fixture-workspace-${A}` ? B : A;
      updateAccountQuota(stale, 20, now + 86_400_000); blocker.release();
      expect((await pending).text).toContain("response.completed");
      expect(calls).toEqual(["native:gpt-reserve", "native:gpt-reserve"]);
      expect(nativeAccounts[1]).toBe("fixture-workspace-still-spent");
    } finally { blocker.release(); controller.abort(); await pending; resetProviderRequestPacingForTest(); }
  });

  test("a portable compaction override walks Reserve and returns a compaction item", async () => {
    const cfg = twoSpentSeats(); cfg.compactionRouting = { model: "combo/luna" };
    const sent: string[] = [];
    native = body => { sent.push(JSON.stringify(body)); return sent.length === 1 ? reserveRefused() : sse(body.model, "ok"); };
    const result = await post(cfg, { model: "metered/gpt-6-sol", stream: false, input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "retain this fixture history" }] }, { type: "compaction_trigger" },
    ] }, { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", compaction: { trigger: "manual" } }) });
    expect(result.status).toBe(200);
    expect(calls).toEqual(["native:gpt-reserve", "native:gpt-reserve"]);
    for (const body of sent) { expect(body).toContain("retain this fixture history"); expect(body).not.toContain("compaction_trigger"); }
    const output = JSON.parse(result.text).output;
    expect(output).toHaveLength(1); expect(output[0].type).toBe("compaction");
    expect(decodeCompactionSummary(output[0].encrypted_content)).toContain("hi");
  });

  test("a live Reserve cooldown skips that seat before the relay", async () => {
    const cfg = threeSpentSeats();
    recordCodexUpstreamOutcome(cfg, B, 429, { now, modelId: "gpt-6-luna", poolReserve: true, retryAfter: "3600" });
    native = reserveRefused;
    const result = await post(cfg);
    expect(result.text).toContain("response.completed");
    expect(calls).toEqual(["native:gpt-reserve", "native:gpt-reserve", "relay:gpt-6-luna"]);
    expect(new Set(nativeAccounts).size).toBe(2);
    expect(nativeAccounts).not.toContain(`fixture-workspace-${B}`);
  });
  test.each([false, true])("a cooled pool target reaches Reserve on the wire (redirected: %s)", async redirected => {
    const target = { provider: "openai", model: redirected ? "gpt-6.2-sol" : "gpt-6-luna" };
    const cfg: OcxConfig = {
      ...config({}, [target]), codexFailureWindow: false, upstreamFailoverThreshold: 1,
      ...(redirected ? { blockedModelRedirects: { [target.model]: "gpt-6-luna" } } : {}),
    };
    seats();
    updateAccountQuota(A, 100, now + 86_400_000);
    setAccountQuotaFromParsed(A, { customWindows: [{ label: "Luna Reserve", percent: 100, resetAt: now + 604_800_000, observedAt: now }] });
    recordCodexUpstreamOutcome(cfg, B, 503, { now, fixedAccount: true });
    now += 60_000; // The 30-second hold ended; the five-minute failure streak has not.
    coolComboTarget("luna", target, { status: 429, retryAfter: "86400" });
    const result = await post(cfg);
    expect(calls).toEqual(["native:gpt-reserve"]);
    expect(nativeHints).toEqual(["model=gpt-reserve"]);
    expect(result.text).toContain("response.completed");
    expect(isComboTargetInCooldown("luna", target)).toBe(false);
  });

  test("another seat's Reserve cannot clear the cooldown for a turn-state owner that cannot send", async () => {
    const target = { provider: "openai", model: "gpt-6-luna" };
    seats();
    updateAccountQuota(A, 100, now + 86_400_000);
    setAccountQuotaFromParsed(A, { customWindows: [{ label: "Luna Reserve", percent: 100, resetAt: now + 604_800_000, observedAt: now }] });
    const handle = issueTurnStateHandle("fixture-state", turnStateBinding("openai", new Headers({
      authorization: `Bearer fixture-access-${A}`, "chatgpt-account-id": `fixture-workspace-${A}`,
    })));
    coolComboTarget("luna", target, { status: 429, retryAfter: "86400" });
    const result = await post(config(), {}, { [TURN_STATE_HEADER]: handle });
    expect(result.status).toBe(409);
    expect(result.text).toContain("does not own a usable turn state");
    expect(calls).toEqual([]);
    expect(isComboTargetInCooldown("luna", target)).toBe(true);
  });

  test("a provider-wide 429 from native Reserve stays cooled even while ordinary Luna has a seat", async () => {
    const target = { provider: "openai", model: "gpt-6-luna" };
    seats();
    native = () => Response.json({ error: { message: "Monthly usage limit reached" } },
      { status: 429, headers: { "retry-after": "86400" } });
    expect((await post(config())).status).toBe(200);
    expect(isComboTargetInCooldown("luna", target)).toBe(true);
    expect((await post(config())).status).toBe(200);
    expect(calls).toEqual(["native:gpt-reserve", "relay:gpt-6-luna", "relay:gpt-6-luna"]);
  });

  test.each([429, 402])("a Reserve %i moves to the relay, and a relay pre-connect failure moves to native ordinary Luna", async status => {
    seats(); native = body => body.model === "gpt-reserve" ? Response.json({ error: { code: "usage_limit_reached" } }, { status }) : sse(body.model, "ok");
    relay = refusedConnect;
    const result = await post(config());
    expect(result.status).toBe(200);
    expect(calls).toEqual(["native:gpt-reserve", "relay:gpt-6-luna", "native:gpt-6-luna"]);
  });
  test("a quota-confirmed final Reserve 503 leaves ordinary Luna available after a relay connect failure", async () => {
    const cfg = config(); seats(); addUnreportedSpentSeat(cfg, "last-seat");
    native = body => body.model !== "gpt-reserve" ? sse(body.model, "ok") : nativeAccounts.length === 1 ? reserveRefused()
      : Response.json({ error: { code: "usage_limit_reached", message: "Monthly usage limit reached" } }, { status: 503 });
    relay = refusedConnect;
    const result = await post(cfg);
    expect(calls.slice(-2)).toEqual(["relay:gpt-6-luna", "native:gpt-6-luna"]);
    expect(nativeAccounts).toContain("fixture-workspace-last-seat"); expect(nativeAccounts.at(-1)).toBe(`fixture-workspace-${A}`);
    expect(result.text).toContain("response.completed");
  });
  test("a Reserve refusal does not cool the native target, so ordinary Luna on it stays available", async () => {
    seats(); native = body => body.model === "gpt-reserve" ? reserveRefused() : sse(body.model, "ok");
    relay = refusedConnect;
    await post(config());
    expect(isComboTargetInCooldown("luna", { provider: "openai", model: "gpt-6-luna" })).toBe(false);
  });
  test("provider fallback turned off plans no extra legs: native ordinary Luna serves and nothing is refused", async () => {
    seats(false);
    const cfg = { ...config(), fallback: { provider: false } };
    const result = await post(cfg);
    expect(result.status).toBe(200);
    expect(result.text).not.toContain("fallback_refused");
    expect(calls).toEqual(["native:gpt-6-luna"]);
  });
  test("a plain relay 429 with no stream proves the relay never started, so native ordinary Luna serves and metered is untouched", async () => {
    seats(); native = body => body.model === "gpt-reserve" ? reserveRefused() : sse(body.model, "ok");
    relay = reserveRefused;
    const result = await post(config());
    expect(result.status).toBe(200);
    expect(calls).toEqual(["native:gpt-reserve", "relay:gpt-6-luna", "native:gpt-6-luna"]);
  });
  test("a Reserve-leg 502 after a send cools the native target, while the zero-send refusal does not", async () => {
    seats(); native = body => body.model === "gpt-reserve" ? Response.json({ error: { message: "bad gateway" } }, { status: 502 }) : sse(body.model, "ok");
    relay = refusedConnect;
    await post(config());
    expect(isComboTargetInCooldown("luna", { provider: "openai", model: "gpt-6-luna" })).toBe(true);
  });
  test("a discovery Reserve HTTP 400 returns and logs its error envelope without throwing", async () => {
    updateAccountQuota(A, 40, now + 86_400_000);
    updateAccountQuota(B, 100, now + 86_400_000);
    native = () => Response.json({ error: { type: "invalid_request_error", message: "payload rejected" } }, { status: 400 });
    const targets = [{ provider: "openai", model: "gpt-6-luna" }];
    saveConfig(config({}, targets));
    clearRequestLogsForTests();
    release?.();
    release = undefined;
    const server = startServer(0);
    try {
      const response = await clientFetch(new URL("/v1/responses", server.url), { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/luna", input: "Reply with the single word: ok", stream: true,
          max_output_tokens: 64, reasoning: { effort: "low" } }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error", code: "invalid_request_error" } });
      const requestId = response.headers.get("x-opencodex-request-id");
      expect(requestId).toMatch(/^ocx-/);
      expect(getRequestLogEntries().filter(entry => entry.requestId === requestId)).toHaveLength(1);
      expect(readUsageEntries().filter(entry => entry.requestId === requestId)).toHaveLength(1);
      expect(calls).toEqual(["native:gpt-reserve"]);
    } finally { await server.stop(true); }
  });
  test("with no eligible Reserve seat the native leg sends nothing and the relay serves the turn", async () => {
    seats(false);
    const result = await post(config());
    expect(result.status).toBe(200);
    expect(calls).toEqual(["relay:gpt-6-luna"]);
  });
  test("a verified zero-output native Reserve refusal reaches the relay", async () => {
    seats(); native = body => sse(body.model, "created-then-quota");
    const result = await post(config());
    expect(calls).toEqual(["native:gpt-reserve", "relay:gpt-6-luna"]);
    expect(result.text).toContain("response.completed");
    expect(result.text).not.toContain("usage_limit_reached");
  });
  test("the client receives the native refusal stream if the relay hop is no longer authorized", async () => {
    seats(); const cfg = config();
    native = body => { cfg.fallback = { provider: false }; return sse(body.model, "created-then-quota"); };
    const result = await post(cfg);
    expect(calls).toEqual(["native:gpt-reserve"]);
    expect(result.status).toBe(200);
    expect(result.text).toContain("response.created");
    expect(result.text).toContain("usage_limit_reached");
  });
  test("a credential rejection on a native Reserve 402 still cools the native target", async () => {
    seats(); native = () => Response.json({ error: { code: "invalid_api_key", type: "authentication_error" } }, { status: 402 });
    relay = refusedConnect;
    await post(config());
    expect(calls).not.toContain("native:gpt-6-luna");
    expect(isComboTargetInCooldown("luna", { provider: "openai", model: "gpt-6-luna" })).toBe(true);
  });
  test("a relay success stops the ladder", async () => {
    seats(); native = body => body.model === "gpt-reserve" ? reserveRefused() : sse(body.model, "ok");
    expect((await post(config())).status).toBe(200);
    expect(calls).toEqual(["native:gpt-reserve", "relay:gpt-6-luna"]);
  });
  test("an ambiguous relay 503 skips native ordinary Luna and falls through to the metered target as before", async () => {
    seats(false); relay = () => Response.json({ error: { message: "bad gateway" } }, { status: 503 });
    await post(config());
    expect(calls).not.toContain("native:gpt-6-luna");
    expect(calls.at(-1)).toBe("metered:gpt-6-luna");
  });
  test("a relay turn that already started never replays on native ordinary Luna", async () => {
    seats(false); relay = () => sse("gpt-6-luna", "created-then-fail");
    await post(config());
    expect(calls).not.toContain("native:gpt-6-luna");
  });
  test("a relay 200 JSON failure is the client's answer, never silently replayed", async () => {
    seats(false);
    relay = () => Response.json({ id: "resp_1", object: "response", status: "failed", error: { code: "server_error", message: "boom" }, output: [] });
    await post(config());
    expect(calls).toEqual(["relay:gpt-6-luna"]);
  });
  test("a caller abort during the relay never dispatches native ordinary Luna", async () => {
    seats(false);
    const controller = new AbortController();
    relay = request => new Promise<Response>((_resolve, reject) => {
      controller.abort();
      request.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
    await post(config(), {}, {}, controller.signal).catch(() => undefined);
    expect(calls).toEqual(["relay:gpt-6-luna"]);
  });
  test("unknown turn state with no recorded owner does not guess a seat", async () => {
    seats(false);
    const result = await post(config(), {}, { "x-codex-turn-state": "opaque" });
    expect(result.status).toBe(409);
    expect(calls).toEqual([]);
  });
  test("a locally restored continuation sends the complete transcript to the relay, not the response id", async () => {
    seats(false);
    expect((await post(config(), { input: "remember this original question", store: true })).status).toBe(200);
    calls.length = 0;
    let wire = "";
    relay = (_request, body) => { wire = JSON.stringify(body); return sse(body.model, "ok"); };
    expect((await post(config(), { previous_response_id: "resp_1", input: "follow-up" })).status).toBe(200);
    expect(calls).toEqual(["relay:gpt-6-luna"]);
    expect(wire).toContain("remember this original question"); expect(wire).toContain("follow-up");
    expect(wire).not.toContain("previous_response_id");
  });
  test.each([
    ["an opaque compaction checkpoint", { input: [{ type: "compaction", encrypted_content: "opaque-cipher" }, { role: "user", content: "ping" }] }],
    ["a turn-state handle in client_metadata", { client_metadata: { "x-codex-turn-state": "opaque" } }],
    ["an uploaded file reference", { input: [{ role: "user", content: [{ type: "input_file", file_id: "file_1" }] }] }],
  ])("%s stays on its recorded native issuer while another seat has Reserve", async (_name, extra) => {
    const cfg = config(), lane = { "thread-id": "bound-native" };
    seats(false); relay = refusedConnect;
    expect((await post(cfg, {}, lane)).status).toBe(200);
    clearComboTargetCooldowns("luna", ["relay/gpt-6-luna"]);
    calls.length = 0; nativeAccounts.length = 0; seats();
    expect((await post(cfg, extra, lane)).status).toBe(200);
    expect(calls).toEqual(["native:gpt-6-luna"]); expect(nativeAccounts).toEqual([`fixture-workspace-${A}`]);
  });
  test("a relay owner keeps its opaque checkpoint, but its next portable turn replans Reserve", async () => {
    seats(false);
    const lane = { "thread-id": "luna-conversation" };
    expect((await post(config(), {}, lane)).status).toBe(200);
    expect(calls).toEqual(["relay:gpt-6-luna"]);
    calls.length = 0;
    seats();
    const laterTurn = { input: [
      { role: "user", content: "ping" },
      { type: "compaction", encrypted_content: "relay-cipher" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "pong" }] },
      { role: "user", content: "again" },
    ] };
    expect((await post(config(), laterTurn, lane)).status).toBe(200);
    expect((await post(config(), { input: "portable follow-up" }, lane)).status).toBe(200);
    expect(calls).toEqual(["relay:gpt-6-luna", "native:gpt-reserve"]);
  });
  test.each([
    { name: "a portable turn asks the eligible relay before spending native included usage", input: "again", nativeReserve: false, expected: "relay:gpt-6-luna" },
    { name: "a portable turn uses newly available native Reserve before the relay", input: "again", nativeReserve: true, expected: "native:gpt-reserve" },
    { name: "a turn carrying scrub-safe native reasoning tries the relay", nativeReserve: false, input: [
      { type: "reasoning", id: "rs_native", summary: [{ type: "summary_text", text: "completed reasoning" }], encrypted_content: "native-cipher" }, { role: "user", content: "again" },
    ], expected: "relay:gpt-6-luna" },
  ])("after native ordinary Luna served, $name", async ({ input, nativeReserve, expected }) => {
    seats(false);
    const lane = { "thread-id": "native-conversation" };
    relay = refusedConnect;
    expect((await post(config(), {}, lane)).status).toBe(200);
    expect(calls).toEqual(["relay:gpt-6-luna", "native:gpt-6-luna"]);
    calls.length = 0;
    relay = () => sse("gpt-6-luna", "ok");
    clearComboTargetCooldowns("luna", ["relay/gpt-6-luna"]);
    seats(nativeReserve);
    expect((await post(config(), { input }, lane)).status).toBe(200);
    expect(calls).toEqual([expected]);
  });
  test("a recalled included seat cannot consume a continuation after the spent seats refuse", async () => {
    const cfg = config(), lane = { "thread-id": "long-native-history" };
    seats(false); relay = refusedConnect;
    expect((await post(cfg, {}, lane)).text).toContain("response.completed");
    expect(calls).toEqual(["relay:gpt-6-luna", "native:gpt-6-luna"]);
    clearComboTargetCooldowns("luna", ["relay/gpt-6-luna"]);
    calls.length = 0; nativeAccounts.length = 0;
    seats(); addUnreportedSpentSeat(cfg, "walk-c");
    const wires: string[] = [];
    native = body => { wires.push(JSON.stringify(body)); return body.model === "gpt-reserve"
      ? Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 }) : sse(body.model, "ok"); };
    relay = (_req, body) => { wires.push(JSON.stringify(body)); return sse(body.model, "ok"); };
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const input = [{ type: "reasoning", id: "rs_foreign", encrypted_content: "private-fixture-blob", summary: [{ type: "summary_text", text: "readable summary" }] },
      { role: "user", content: "continue the original question" }];
    expect((await post(cfg, { input }, lane, undefined, { logCtx })).text).toContain("response.completed");
    expect(calls).toEqual(["native:gpt-reserve", "native:gpt-reserve", "relay:gpt-6-luna"]);
    expect(nativeAccounts).not.toContain(`fixture-workspace-${A}`);
    for (const wire of wires) {
      expect(wire).toContain("continue the original question"); expect(wire).toContain("readable summary");
      expect(wire).not.toContain("private-fixture-blob"); expect(wire).not.toContain("rs_foreign");
    }
    expect(logCtx.routeDecision?.selected.reason).toBe("luna-reserve-first");
  });

  test("a verified handle uses only its unspent owner and does not hop on refusal", async () => {
    seats(); const cfg = config();
    const handle = issueTurnStateHandle("fixture-owner-state", turnStateBinding("openai", new Headers({
      authorization: `Bearer fixture-access-${A}`, "chatgpt-account-id": `fixture-workspace-${A}`,
    })));
    native = reserveRefused;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const result = await post(cfg, {}, { [TURN_STATE_HEADER]: handle }, undefined, { logCtx });
    expect(result.status).toBe(429); expect(calls).toEqual(["native:gpt-6-luna"]);
    expect(nativeAccounts).toEqual([`fixture-workspace-${A}`]);
    expect(logCtx.routeDecision?.selected.reason).toBe("luna-owner-turn-state");
  });

  test("a store-less pin without an issuer refuses an ID-only continuation without sending", async () => {
    const cfg = config(), lane = { "thread-id": "legacy-relay-continuation" };
    const id = "resp_legacy_pin";
    seats(false);
    expect((await post(cfg, {}, lane)).text).toContain("response.completed");
    relay = (_request, body) => Response.json({ id, object: "response", status: "completed", model: body.model, output: [] });
    expect((await post(cfg, { stream: false, conversation: "conv_at_relay", input: "first delta" }, lane)).text).toContain(id);
    expect(calls).toEqual(["relay:gpt-6-luna", "relay:gpt-6-luna"]);
    release?.();
    const db = new Database(join(home, "codex-combo-affinity.sqlite"));
    try {
      db.exec("DROP TABLE combo_evidence"); // The pre-upgrade writer had no issuer index.
      // The old writer had neither column. These are the values SQLite gives its row after migration.
      expect(db.run("UPDATE combo_pins SET store = NULL, proofs = NULL WHERE provider = 'relay'").changes).toBe(1);
    } finally { db.close(); }
    clearComboRecallForTests(); release = acquireOwnedSpendHome();
    calls.length = 0;
    const result = await post(cfg, { previous_response_id: id, input: "just the delta" }, lane);
    expect(result.status).toBe(400);
    expect(result.text).toContain("previous_response_not_found");
    expect(result.text).toContain("Resend the full conversation without previous_response_id.");
    expect(calls).toEqual([]);
  });

  test("an append to a server conversation is not a complete locally replayable transcript", async () => {
    seats(false); const cfg = config();
    expect((await post(cfg, { model: "relay/gpt-6-luna", conversation: "fixture-upstream-conversation", input: "only the append", store: true })).status).toBe(200);
    calls.length = 0;
    const result = await post(cfg, { previous_response_id: "resp_1", input: "where did we begin?" });
    expect(result.status).toBe(400); expect(result.text).toContain("previous_response_not_found"); expect(calls).toEqual([]);
  });

  test("a native handle outranks a later relay completion on the same lane", async () => {
    const cfg = config(), lane = { "thread-id": "handle-before-relay" }; seats(false);
    const handle = issueTurnStateHandle("fixture-native-state", turnStateBinding("openai", new Headers({
      authorization: `Bearer fixture-access-${A}`, "chatgpt-account-id": `fixture-workspace-${A}`,
    })));
    expect((await post(cfg, {}, lane)).status).toBe(200); expect(calls).toEqual(["relay:gpt-6-luna"]);
    calls.length = 0; seats();
    expect((await post(cfg, {}, { ...lane, [TURN_STATE_HEADER]: handle })).status).toBe(200);
    expect(calls).toEqual(["native:gpt-6-luna"]); expect(nativeAccounts).toEqual([`fixture-workspace-${A}`]);
  });

  test("a disabled relay cannot release a bound turn to a third provider", async () => {
    const cfg = config(); cfg.providers.relay!.disabled = true; seats(); native = reserveRefused;
    const handle = issueTurnStateHandle("fixture-disabled-relay", turnStateBinding("openai", new Headers({
      authorization: `Bearer fixture-access-${A}`, "chatgpt-account-id": `fixture-workspace-${A}`,
    })));
    expect((await post(cfg, {}, { [TURN_STATE_HEADER]: handle })).status).toBe(429);
    expect(calls).toEqual(["native:gpt-6-luna"]);
  });

  test("disabled relay retains ownership of opaque history after native served earlier", async () => {
    const cfg = config(), lane = { "thread-id": "disabled-relay-owner" }; seats(false);
    relay = refusedConnect;
    expect((await post(cfg, {}, lane)).text).toContain("response.completed");
    expect(nativeAccounts).toEqual([`fixture-workspace-${A}`]);
    clearComboTargetCooldowns("luna", ["relay/gpt-6-luna"]);
    const item = { type: "reasoning", id: "rs_relay123", encrypted_content: "relay-issued", summary: [] };
    relay = (_req, body) => issuedReasoning(body.model, item);
    expect((await post(cfg, {}, lane)).text).toContain(item.encrypted_content);
    expect(calls.at(-1)).toBe("relay:gpt-6-luna");
    calls.length = 0; cfg.providers.relay!.disabled = true;
    const result = await post(cfg, { input: [item, { role: "user", content: "continue" }] }, lane);
    expect(result.status).toBe(409); expect(calls).toEqual([]);
    seats();
    expect((await post(cfg, { input: "new plain question" }, lane)).status).toBe(200);
    expect(calls).toEqual(["native:gpt-reserve"]);
  });

  test.each([false, true])("relay serving readable history cannot claim native reasoning (missing readable replacement: %s)", async opaque => {
    const cfg = config(), lane = { "thread-id": "per-item-issuer" }; seats();
    const first = { type: "reasoning", id: "rs_a123", encrypted_content: "native-issued", summary: [{ type: "summary_text", text: "first plan" }] };
    const second = { type: "reasoning", id: "rs_b123", encrypted_content: "relay-issued", summary: [{ type: "summary_text", text: "second plan" }] };
    native = body => issuedReasoning(body.model, first);
    expect((await post(cfg, {}, lane)).text).toContain(first.encrypted_content);
    seats(false);
    const wires: string[] = [];
    relay = (_req, body) => { wires.push(JSON.stringify(body)); return issuedReasoning(body.model, second); };
    const user = { role: "user", content: "continue" };
    expect((await post(cfg, { input: [first, user], store: true }, lane)).text).toContain(second.encrypted_content);
    if (opaque) {
      calls.length = 0;
      expect((await post(cfg, { input: [{ ...first, summary: [] }, user], store: true }, lane)).status).toBe(409);
      expect(calls).toEqual([]); return;
    }
    expect((await post(cfg, { input: [first, user, second, user], store: true }, lane)).status).toBe(200);
    expect(wires).toHaveLength(2);
    for (const wire of wires) {
      expect(wire).toContain("first plan"); expect(wire).not.toContain(first.id); expect(wire).not.toContain(first.encrypted_content);
    }
    expect(wires[1]).toContain(second.encrypted_content); expect(wires[1]).toContain(second.id);
    calls.length = 0; seats(); let nativeReplay = "";
    native = body => { nativeReplay = JSON.stringify(body); return sse(body.model, "ok"); };
    if (opaque) {
      calls.length = 0;
      expect((await post(cfg, { input: [{ ...first, summary: [] }, user], store: true }, lane)).status).toBe(409);
      expect(calls).toEqual([]); return;
    }
    expect((await post(cfg, { input: [first, user, second, user], store: true }, lane)).status).toBe(200);
    expect(calls).toEqual(["native:gpt-reserve"]); expect(nativeReplay).toContain(first.encrypted_content);
    expect(nativeReplay).not.toContain(second.encrypted_content); expect(nativeReplay).toContain("second plan");
  });

  test.each([false, true])("a spent reasoning issuer ports after its capacity refusal (local: %s)", async localRefusal => {
    const cfg = config(), lane = { "thread-id": "spent-reasoning-owner" }; seats(false);
    relay = refusedConnect;
    const item = { type: "reasoning", id: "rs_spent_private", encrypted_content: "spent-private-cipher", summary: [] };
    native = body => issuedReasoning(body.model, item);
    expect((await post(cfg, {}, lane)).text).toContain(item.encrypted_content);
    clearComboTargetCooldowns("luna", ["relay/gpt-6-luna"]);
    calls.length = 0; nativeAccounts.length = 0;
    updateAccountQuota(A, 100, now + 86_400_000);
    if (localRefusal) setAccountQuotaFromParsed(A, { customWindows: [{ label: "Luna Reserve", percent: 100, resetAt: now + 604_800_000, observedAt: now }] });
    native = reserveRefused;
    let wire = "";
    relay = (_request, body) => { wire = JSON.stringify(body); return sse(body.model, "ok"); };
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const input = [{ type: "reasoning", id: "rs_readable", encrypted_content: "readable-cipher", summary: [{ type: "summary_text", text: "retained summary" }] },
      { type: "message", id: "msg_earlier", role: "user", content: "earlier" }, item, { type: "function_call", id: "fc_one", call_id: "call_one", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_one", output: "result" }, { role: "user", content: "continue" }];
    const result = await post(cfg, { input }, lane, undefined, { logCtx });
    expect(result.status).toBe(200);
    expect(result.text).toContain("response.completed");
    expect(wire).not.toContain(item.id); expect(wire).not.toContain(item.encrypted_content);
    expect(wire).not.toContain("rs_readable"); expect(wire).not.toContain("readable-cipher");
    expect(wire).toContain("retained summary");
    expect(wire).not.toContain("fc_one"); expect(wire).not.toContain("msg_earlier");
    expect(JSON.parse(wire).input.filter((entry: { call_id?: string }) => entry.call_id === "call_one")).toHaveLength(2);
    expect(logCtx.routeDecision?.selected.reason).toBe("luna-owner-spent-ported");
    expect(logCtx.attempts?.[0]).toMatchObject({ status: 429, sendCount: localRefusal ? 0 : 1 });
    if (!localRefusal) {
      expect(logCtx.attempts?.[0]?.wireModel).toBe("gpt-reserve");
      expect(nativeAccounts[0]).toBe(`fixture-workspace-${A}`);
    }
    expect(logCtx.attempts?.at(-1)?.provider).toBe("relay");
  });

  const ownerItem = { type: "reasoning", id: "rs_fixture", encrypted_content: "opaque-fixture", summary: [] };
  const ownerLane = { "thread-id": "owner-refusal-fixture" };
  async function issueOwner(cfg: OcxConfig, owner: "native" | "relay" = "native") {
    seats(false);
    relay = owner === "relay" ? (_request, body) => issuedReasoning(body.model, ownerItem) : refusedConnect;
    native = body => issuedReasoning(body.model, ownerItem);
    expect((await post(cfg, {}, ownerLane)).text).toContain(ownerItem.encrypted_content);
    clearComboTargetCooldowns("luna", ["relay/gpt-6-luna"]); calls.length = 0; nativeAccounts.length = 0;
    relay = (_request, body) => sse(body.model, "ok");
  }
  const ownerDelta = { input: [ownerItem, { role: "user", content: "continue" }] };

  test("cancelling a waiting portable pick returns cancellation rather than the issuer refusal", async () => {
    const cfg = config(); await issueOwner(cfg); cfg.combos!.luna!.waitForCooldownMs = 2_000;
    const controller = new AbortController();
    native = () => {
      coolComboTarget("luna", { provider: "openai", model: "gpt-6-luna" }, { status: 503, retryAfter: "1" });
      setTimeout(() => controller.abort(), 25);
      return reserveRefused();
    };
    const result = await post(cfg, ownerDelta, ownerLane, controller.signal);
    expect(result.status).toBe(499); expect(calls).toEqual(["native:gpt-6-luna"]);
  });

  test("a paused issuer cannot release its bound turn", async () => {
    const cfg = config(); await issueOwner(cfg);
    cfg.pausedCodexAccountIds = [A];
    const result = await post(cfg, ownerDelta, ownerLane);
    expect(result.status).toBe(429); expect(calls).toEqual([]);
  });

  test.each([false, true])("only a confirmed 429 cooldown can release the issuer on the next request (conflict: %s)", async conflict => {
    const cfg = config(); await issueOwner(cfg);
    native = () => Response.json({ ...(conflict && { code: "origin_rejected" }), error: { code: "usage_limit_reached" } }, { status: 429 });
    // Keep this first turn on its issuer even if capacity is confirmed.
    expect((await post(cfg, { ...ownerDelta, prompt: { id: "pmpt_fixture" } }, ownerLane)).status).toBe(429);
    expect(calls).toEqual(["native:gpt-6-luna"]); calls.length = 0;
    expect((await post(cfg, ownerDelta, ownerLane)).status).toBe(conflict ? 429 : 200);
    expect(calls).toEqual(conflict ? [] : ["relay:gpt-6-luna"]);
  });

  test.each([["insufficient_quota", false], ["usage_limit_reached", false], ["insufficient_quota", true]] as const)(
    "a native stream releases its issuer only on a confirmed terminal refusal (%s, conflict: %s)", async (code, conflict) => {
    const cfg = config(); await issueOwner(cfg);
    native = body => sse(body.model, "output-then-quota", code, conflict ? "origin_rejected" : undefined);
    const first = await post(cfg, { ...ownerDelta, prompt: { id: "pmpt_fixture" } }, ownerLane);
    expect(first.status).toBe(200); expect(first.text).toContain("response.failed");
    expect(calls).toEqual(["native:gpt-6-luna"]); calls.length = 0;
    expect((await post(cfg, ownerDelta, ownerLane)).status).toBe(conflict ? 429 : 200);
    expect(calls).toEqual(conflict ? [] : ["relay:gpt-6-luna"]);
  });

  test.each([false, true])("a late success keeps confirmation on the active cooldown (scoped: %s)", async scoped => {
    const cfg = config(); await issueOwner(cfg);
    const seat = { modelId: "gpt-6-luna", now, ...(scoped ? { resetAt: now + 180_000 } : { retryAfter: "180" }) };
    recordCodexUpstreamOutcome(cfg, A, 429, seat)?.();
    recordCodexUpstreamOutcome(cfg, A, 200, { modelId: seat.modelId, now: now + 1 });
    expect((await post(cfg, ownerDelta, ownerLane)).status).toBe(200);
    expect(calls).toEqual(["relay:gpt-6-luna"]);
  });

  test("a late quota body cannot confirm the next cooldown on the same seat", async () => {
    const cfg = config(); await issueOwner(cfg);
    const earlier = recordCodexUpstreamOutcome(cfg, A, 429, { modelId: "gpt-6-luna" });
    recordCodexUpstreamOutcome(cfg, A, 429, { modelId: "gpt-6-luna" });
    if (!earlier) throw new Error("missing original cooldown");
    earlier();
    expect((await post(cfg, ownerDelta, ownerLane)).status).toBe(429);
    expect(calls).toEqual([]);
  });

  test("the owner's quota headers can admit its seat to Reserve before the relay", async () => {
    const cfg = config(); await issueOwner(cfg);
    native = body => body.model === "gpt-reserve" ? sse(body.model, "ok") : Response.json({ error: { code: "usage_limit_reached" } }, {
      status: 429, headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "10080",
        "x-codex-primary-reset-at": String(Math.floor(now / 1000) + 3600) },
    });
    expect((await post(cfg, ownerDelta, ownerLane)).text).toContain("response.completed");
    expect(calls).toEqual(["native:gpt-6-luna", "native:gpt-reserve"]);
    expect(nativeAccounts).toEqual([`fixture-workspace-${A}`, `fixture-workspace-${A}`]);
  });

  test.each([["native", 402, "usage_not_included"], ["native", 429, "insufficient_quota"], ["relay", 429, "usage_limit_reached"]] as const)(
    "%s issuer capacity %i %s starts the portable ladder at native Reserve", async (owner, status, code) => {
      const cfg = config(); await issueOwner(cfg, owner); seats();
      const refusal = () => Response.json({ error: { code } }, { status });
      if (owner === "relay") relay = refusal;
      native = body => owner === "native" && calls.length === 1 ? refusal() : sse(body.model, "ok");
      expect((await post(cfg, ownerDelta, ownerLane)).text).toContain("response.completed");
      expect(calls).toEqual([`${owner}:gpt-6-luna`, "native:gpt-reserve"]);
    });

  test.each(["prompt", "signature"])("an issuer refusal cannot port a delta containing a %s", async carrier => {
    const cfg = config(); await issueOwner(cfg); native = reserveRefused;
    const request = carrier === "prompt" ? { ...ownerDelta, prompt: { id: "pmpt_fixture" } } : { input: [ownerItem,
      { type: "function_call", call_id: "call_fixture", name: "lookup", arguments: "{}", extra_content: { google: { thought_signature: "fixture-signature" } } },
      { type: "function_call_output", call_id: "call_fixture", output: "ok" }] };
    const result = await post(cfg, request, ownerLane);
    expect(result.status).toBe(429); expect(calls).toEqual(["native:gpt-6-luna"]);
  });

  test("a spent stored-credential retry cannot start a portable ladder", async () => {
    const cfg = config(); await issueOwner(cfg);
    native = () => {
      if (calls.length !== 1) return reserveRefused();
      saveCodexAccountCredential(A, { accessToken: "fixture-renewed", refreshToken: "fixture-renewed-grant",
        chatgptAccountId: `fixture-workspace-${A}`, expiresAt: now + 86_400_000 });
      return Response.json({ error: { message: "rejected bearer" } }, { status: 401 });
    };
    const result = await post(cfg, ownerDelta, ownerLane);
    expect(result.status).toBe(429); expect(calls).toEqual(["native:gpt-6-luna", "native:gpt-6-luna"]);
  });

  test.each([undefined, 6])("the enforced portable ladder respects the caller send ceiling: %s", async cap => {
    const cfg = config(); await issueOwner(cfg);
    for (let i = 0; i < 8; i++) addUnreportedSpentSeat(cfg, `port-walk-${i}`);
    configureSharedPoolBackpressure({ ...DEFAULT_POOL_BACKPRESSURE_POLICY, minRecoveryAllowance: 8 });
    native = reserveRefused;
    const lines: string[] = [];
    const ledger = createSpendReservationLedger({ policy: { ...DEFAULT_SPEND_RESERVATION_POLICY, root: { maxTokens: 1_000_000 } },
      journal: { read: () => [...lines], append: line => { lines.push(line); }, rewrite: next => { lines.splice(0, lines.length, ...next); } } });
    const logCtx: RequestLogContext = { model: "combo/luna", provider: "combo", spendInputEstimateTokens: 1 };
    const req = new Request("http://localhost/v1/responses", { headers: { "x-codex-parent-thread-id": "ported-owner" } });
    const tracker = attachRequestSpendTracker(req, logCtx, ledger);
    const sendBudget = cap === undefined ? createInferenceSendBudget(req, logCtx) : createRequestExecutionBudget({
      ...CODEX_TEXT_GUARDED_BUDGET_POLICY, maxTotalModelSends: cap, baseSendAllowance: cap - 1,
    }, undefined, tracker);
    try {
      const result = await post(cfg, ownerDelta, ownerLane, undefined, { logCtx, sendBudget });
      if (cap) expect(calls.length).toBeLessThanOrEqual(cap);
      else expect(calls).toEqual(["native:gpt-6-luna", ...Array(8).fill("native:gpt-reserve"), "relay:gpt-6-luna"]);
      expect(result.text).toContain("response.completed"); expect(sendBudget.physicalStarted).toBe(calls.length);
      expect(sendBudget.used).toBe(calls.length);
    } finally { tracker.settle(logCtx.usage); }
    expect(lines.filter(line => JSON.parse(line).kind === "dispatch")).toHaveLength(calls.length);
  });

  test("a healthy reasoning issuer receives the original opaque item", async () => {
    const cfg = config(), lane = { "thread-id": "healthy-reasoning-owner" }; seats(false);
    relay = refusedConnect;
    const item = { type: "reasoning", id: "rs_healthy_private", encrypted_content: "healthy-private-cipher", summary: [] };
    native = body => issuedReasoning(body.model, item);
    expect((await post(cfg, {}, lane)).text).toContain(item.encrypted_content);
    calls.length = 0;
    let wire = "";
    native = body => { wire = JSON.stringify(body); return sse(body.model, "ok"); };
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const result = await post(cfg, { input: [item, { role: "user", content: "continue" }] }, lane, undefined, { logCtx });
    expect(result.status).toBe(200);
    expect(calls).toEqual(["native:gpt-6-luna"]);
    expect(JSON.parse(wire).input[0]).toEqual(item);
    expect(logCtx.routeDecision?.selected.reason).toBe("luna-owner-encrypted-reasoning");
  });

  test.each([true, false])("an evicted response id follows its issuing key, not the latest completion (available: %s)", async available => {
    const cfg = config(), lane = { "thread-id": "id-issuer" }; seats(false);
    const provider = cfg.providers.relay!;
    provider.apiKeyPool = [{ id: "a", key: "fixture-a" }, { id: "b", key: "fixture-b" }];
    provider.apiKey = "fixture-a";
    provider.requestPacing = { enabled: true, keySelection: "round-robin" };
    const keys: (string | null)[] = [];
    relay = (request, body) => {
      keys.push(request.headers.get("authorization"));
      return Response.json({ id: `resp_issuer_${keys.length}`, object: "response", status: "completed", model: body.model, output: [] });
    };
    for (const turn of [1, 2]) expect((await post(cfg, { stream: false, store: true }, lane)).text).toContain(`resp_issuer_${turn}`);
    expect(keys[0]).not.toBe(keys[1]);
    clearResponseStateForTests();
    release?.(); clearComboRecallForTests(); release = acquireOwnedSpendHome();
    if (!available) {
      const retained = provider.apiKeyPool!.find(entry => `Bearer ${entry.key}` === keys[1])!;
      provider.apiKey = retained.key;
      provider.apiKeyPool = [retained, { id: "c", key: "fixture-c" }];
    }
    let resumedOnFirst = false, receivedId: unknown;
    relay = async (req, body) => { resumedOnFirst = req.headers.get("authorization") === keys[0]; receivedId = (await req.json()).previous_response_id; return sse(body.model, "ok"); };
    calls.length = 0;
    const unknown = await post(cfg, { previous_response_id: "resp_never_issued", input: "next" }, lane);
    expect(unknown.status).toBe(400); expect(calls).toEqual([]);
    const result = await post(cfg, { previous_response_id: "resp_issuer_1", input: "next" }, lane);
    if (!available) { expect(result.status).toBe(400); expect(result.text).toContain("previous_response_not_found"); expect(calls).toEqual([]); }
    else { expect(result.status).toBe(200); expect(resumedOnFirst).toBe(true); expect(receivedId).toBe("resp_issuer_1"); }
  });

  test("reasoning older than the lane proof cap survives restart without admitting unknown ciphertext", async () => {
    const cfg = config(), lane = { "thread-id": "long-relay-history" }; seats(false);
    const item = (n: number) => ({ type: "reasoning", id: `rs_old_${n}`, encrypted_content: `fixture-cipher-${n}`, summary: [] });
    for (const turn of [1, 2]) {
      const output = Array.from({ length: 6 }, (_, i) => item(turn * 10 + i));
      relay = (_req, body) => Response.json({ id: `resp_long_${turn}`, object: "response", status: "completed", model: body.model, output });
      expect((await post(cfg, { stream: false, store: true }, lane)).text).toContain(output[0]!.id);
    }
    release?.(); clearComboRecallForTests(); clearReasoningReplayCacheForTests(); release = acquireOwnedSpendHome();
    calls.length = 0; seats(); let sent: unknown[] = [];
    relay = async (req, body) => { sent = (await req.json()).input; return sse(body.model, "ok"); };
    const result = await post(cfg, { store: true, input: [item(10), item(99), { role: "user", content: "continue" }] }, lane);
    expect(result.status).toBe(200); expect(calls).toEqual(["relay:gpt-6-luna"]);
    expect(sent).toContainEqual(item(10)); expect(sent).not.toContainEqual(item(99));
    expect(sent.filter(entry => (entry as { type: string }).type === "reasoning")).toHaveLength(1);
  });

  test("readable Terra compaction recalls the combo after the gateway key changes", async () => {
    const cfg = config({}, [{ provider: "relay", model: "gpt-6-terra" }]);
    cfg.combos = { terra: cfg.combos!.luna! }; cfg.defaultProvider = "metered";
    const lane = { "thread-id": "terra-compaction" };
    relay = (_req, body) => sse(body.model, "ok");
    expect((await post(cfg, { model: "combo/terra" }, lane)).text).toContain("gpt-6-terra");
    cfg.providers.relay!.apiKey = "fixture-new-key"; calls.length = 0;
    const log: RequestLogContext = { model: "", provider: "" };
    const compact = (input: unknown[]) => handleResponsesCompact(new Request("http://localhost/v1/responses/compact", { method: "POST",
      headers: { ...lane, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-6-terra", input }) }), cfg, log, undefined, local);
    const result = await compact([{ type: "message", role: "user", content: [{ type: "input_text", text: "retain history" }] }]);
    const compacted = await result.json();
    expect(calls).toEqual(["relay:gpt-6-terra"]); expect(log.comboId).toBe("terra");
    expect(result.status).toBe(200); expect(compacted.output.at(-1).content[0].text).toEndWith("\nhi");
    cfg.providers.relay!.apiKey = "fixture-another-key"; calls.length = 0;
    const bound = await compact([{ type: "item_reference", id: "msg_1" }]);
    expect(bound.ok).toBe(false); expect(calls).toEqual([]);
  });

  test("mixed history after restart restores only the items issued by the serving store", async () => {
    const cfg = config(), lane = { "thread-id": "mixed-after-restart" }; seats();
    const foreign = { type: "reasoning", id: "rs_native", encrypted_content: "native-cipher", summary: [{ type: "summary_text", text: "earlier plan" }] };
    const own = { type: "reasoning", id: "rs_relay", encrypted_content: "relay-cipher", summary: [] };
    native = body => issuedReasoning(body.model, foreign);
    expect((await post(cfg, {}, lane)).text).toContain(foreign.id);
    seats(false); relay = (_req, body) => issuedReasoning(body.model, own);
    expect((await post(cfg, {}, lane)).text).toContain(own.id);
    release?.(); clearComboRecallForTests(); clearReasoningReplayCacheForTests(); release = acquireOwnedSpendHome();
    const wires: string[] = [];
    relay = (_req, body) => { wires.push(JSON.stringify(body)); return sse(body.model, "ok"); };
    const user = { role: "user", content: "continue" };
    const unknown = { ...foreign, id: "rs_unknown", encrypted_content: "unissued" };
    expect((await post(cfg, { store: true, input: [foreign, unknown, user, own] }, lane)).status).toBe(200);
    expect(wires).toHaveLength(1); expect(wires[0]).toContain("earlier plan"); expect(wires[0]).toContain(own.encrypted_content);
    for (const item of [foreign, unknown]) { expect(wires[0]).not.toContain(item.id); expect(wires[0]).not.toContain(item.encrypted_content); }
  });

  test("native cooldown expiring during a relay connect failure still offers strict Reserve first", async () => {
    const cfg = config(); seats(); coolComboTarget("luna", { provider: "openai", model: "gpt-6-luna" }, { status: 503, retryAfter: "1" });
    relay = () => { now += 1100; return refusedConnect(); };
    expect((await post(cfg)).text).toContain("response.completed");
    expect(calls).toEqual(["relay:gpt-6-luna", "native:gpt-reserve"]);
  });

  test("a bound relay turn selects its issuing key before round-robin allocation", async () => {
    const cfg = config(), lane = { "thread-id": "relay-key-owner" }; seats(false);
    cfg.providers.relay!.apiKeyPool = [{ id: "a", key: "fixture-a" }, { id: "b", key: "fixture-b" }];
    cfg.providers.relay!.apiKey = "fixture-a";
    cfg.providers.relay!.requestPacing = { enabled: true, keySelection: "round-robin" };
    let issuer: string | null = null;
    relay = (request, body) => { issuer = request.headers.get("authorization"); return sse(body.model, "ok"); };
    expect((await post(cfg, { store: true }, lane)).text).toContain("response.completed"); expect(issuer).not.toBeNull();
    const matches: boolean[] = [];
    relay = (request, body) => { matches.push(request.headers.get("authorization") === issuer); return sse(body.model, "ok"); };
    expect((await post(cfg, { store: true, input: [{ type: "item_reference", id: "msg_1" }] }, lane)).text).toContain("response.completed");
    expect(matches).toEqual([true]);
  });

  test("a bound continuation does not spend a cooldown reprobe", async () => {
    const cfg = config(), lane = { "thread-id": "cooled-bound-reprobe" }; seats(false);
    expect((await post(cfg, {}, lane)).text).toContain("response.completed"); calls.length = 0;
    cfg.combos!.luna!.cooldownReprobe = { enabled: true, intervalMs: 60_000 };
    coolComboTarget("luna", { provider: "relay", model: "gpt-6-luna" }, { status: 503, retryAfter: "23" });
    const refusal = await post(cfg, { store: true, input: [{ type: "item_reference", id: "msg_1" }] }, lane);
    expect(refusal.status).toBe(503); expect(refusal.headers.get("retry-after")).toBe("23"); expect(calls).toEqual([]);
  });

  test.each(["restart", "expiry", "eviction"])("the recorded relay receives its unchanged tool reasoning after proof %s", async loss => {
    seats(false);
    const cfg = config(), lane = { "thread-id": "tool-continuation" };
    const item = { type: "reasoning", id: "rs_relay123", encrypted_content: "fixture-relay-reasoning", summary: [] };
    const call = { type: "function_call", id: "fc_lookup", call_id: "call_lookup", name: "lookup", arguments: "{}" };
    relay = (_request, body) => Response.json({ id: "resp_tool", object: "response", model: body.model, status: "completed", output: [item, call] });
    const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
    expect((await post(cfg, { stream: false, store: true, tools }, lane)).text).toContain(item.encrypted_content);
    if (loss === "restart") {
      release?.(); clearComboRecallForTests(); clearReasoningReplayCacheForTests(); release = acquireOwnedSpendHome();
    } else if (loss === "expiry") now += 3_600_001;
    else {
      // Unrelated completions fill the bounded proof cache, without more sends on the tested lane.
      rememberIssuedReasoning({ clientThreadId: "other-thread", current: { providerName: "other", adapterName: "openai-responses",
        modelId: "fixture", providerDestinationIdentity: "fixture", providerDestinationDurableIdentity: "fixture-destination",
        credentialIdentity: "fixture", credentialDurableIdentity: "fixture-credential" } },
      Array.from({ length: 4097 }, (_, i) => ({ type: "reasoning", id: `rs_other${i}` })));
    }
    calls.length = 0; seats();
    let sent: unknown;
    relay = async (request, body) => { sent = (await request.json() as { input: unknown }).input; return sse(body.model, "ok"); };
    const result = await post(cfg, { store: true, tools, input: [item, call, { type: "function_call_output", call_id: call.call_id, output: "found" }] }, lane);
    expect(result.text).toContain("response.completed"); expect(calls).toEqual(["relay:gpt-6-luna"]);
    expect(sent).toContainEqual(item);
  });

  test.each(["renamed", "new path", "removed"])("a bound reference follows its store, not its provider label: %s", async change => {
    seats(false);
    const cfg = config(), lane = { "thread-id": "reference-owner" };
    // Native has an older valid seat binding: falling back to it really can send this reference.
    relay = refusedConnect;
    expect((await post(cfg, {}, lane)).text).toContain("response.completed");
    expect(calls.at(-1)).toBe("native:gpt-6-luna");
    clearComboTargetCooldowns("luna", ["relay/gpt-6-luna"]);
    const relayId = "msg_relay_reference";
    relay = (_request, body) => Response.json({ id: "resp_relay_reference", object: "response", status: "completed", model: body.model,
      output: [{ id: relayId, type: "message", role: "assistant", content: [{ type: "output_text", text: "relay" }] }] });
    expect((await post(cfg, { stream: false, store: true }, lane)).text).toContain(relayId);
    expect(calls.at(-1)).toBe("relay:gpt-6-luna");
    const relayTarget = { provider: "renamed", model: "gpt-6-luna" };
    cfg.providers.renamed = { ...cfg.providers.relay!, ...(change === "new path" ? { responsesPath: "/new-store/responses" } : {}) };
    delete cfg.providers.relay;
    cfg.combos!.luna!.targets.splice(1, 1, ...(change === "removed" ? [] : [relayTarget]));
    reconcileComboRecall({ generation: captureConfigGeneration() + 1, comboIds: new Set(["luna"]), comboTargets: listLiveComboTargetKeys(cfg),
      providerNames: new Set(Object.keys(cfg.providers)), codexAccountIds: new Set(), oauthAccountKeys: new Set(), configRoots: new Set() });
    seats(); calls.length = 0;
    let sent: unknown;
    relay = async (request, body) => { expect(request.url).toBe("https://relay.example.test/backend-api/codex/v1/responses");
      sent = (await request.json() as { input: unknown }).input; return sse(body.model, "ok"); };
    const ref = { type: "item_reference", id: relayId };
    const result = await post(cfg, { input: [ref], store: true }, lane);
    if (change === "renamed") {
      expect(result.text).toContain("response.completed"); expect(calls).toEqual(["relay:gpt-6-luna"]); expect(sent).toContainEqual(ref);
    } else { expect(result.status).toBe(503); expect(calls).toEqual([]); }
  });

  test("changing only responsesPath does not carry item proof into the new store", async () => {
    const cfg = config(), lane = { "thread-id": "endpoint-proof" }; seats(false);
    const item = { type: "reasoning", id: "rs_old123", encrypted_content: "old-endpoint-cipher", summary: [{ type: "summary_text", text: "use this plan" }] };
    relay = (_request, body) => issuedReasoning(body.model, item);
    expect((await post(cfg, {}, lane)).text).toContain(item.encrypted_content);
    cfg.providers.relay!.responsesPath = "/new-store/responses";
    relayUrl = "https://relay.example.test/backend-api/codex/new-store/responses";
    let wire = "";
    relay = (request, body) => { expect(request.url).toBe("https://relay.example.test/backend-api/codex/new-store/responses"); wire = JSON.stringify(body); return sse(body.model, "ok"); };
    const result = await post(cfg, { input: [item, { role: "user", content: "continue" }], store: true }, lane);
    expect(result.text).toContain("response.completed"); expect(wire).toContain("use this plan");
    expect(wire).not.toContain(item.id); expect(wire).not.toContain(item.encrypted_content);
  });

  test.each([false, true])("bound relay cooldown preserves retry advice or caller cancellation (abort: %s)", async abort => {
    seats(false); const cfg = config(), lane = { "thread-id": "cooled-owner" };
    expect((await post(cfg, {}, lane)).text).toContain("response.completed"); calls.length = 0;
    coolComboTarget("luna", { provider: "relay", model: "gpt-6-luna" }, { status: 503, retryAfter: abort ? "1" : "73" });
    coolComboTarget("luna", { provider: "metered", model: "gpt-6-luna" }, { status: 503, retryAfter: "2" });
    if (abort) cfg.combos!.luna!.waitForCooldownMs = 2_000;
    const controller = new AbortController();
    const timer = abort ? setTimeout(() => controller.abort(), 50) : undefined;
    try {
      const result = await post(cfg, { input: [{ type: "item_reference", id: "msg_1" }], store: true }, lane, controller.signal);
      expect(result.status).toBe(abort ? 499 : 503); expect(calls).toEqual([]);
      if (!abort) { expect(result.headers.get("retry-after")).toBe("73"); expect(result.text).toContain("combo_unavailable"); }
    } finally { clearTimeout(timer); }
  });

  test.each(["quota", "origin refusal"])("the Reserve walker classifies a slow alternate %s before selecting a seat", async kind => {
    const cfg = threeSpentSeats();
    native = body => nativeAccounts.length === 1 ? reserveRefused() : nativeAccounts.length > 2 ? sse(body.model, "ok") : new Response(new ReadableStream({
      async start(controller) {
        await Bun.sleep(350);
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { code: kind === "quota" ? "usage_limit_reached" : "origin_rejected", message: "Monthly usage limit reached" } })));
        controller.close();
      },
    }), { status: 503, headers: { "content-type": "application/json" } });
    const result = await post(cfg);
    expect(result.status).toBe(kind === "quota" ? 200 : 503);
    expect(calls).toEqual(Array(kind === "quota" ? 3 : 2).fill("native:gpt-reserve"));
  });

  test("an alternate Reserve refusal completed after the retry probe remains terminal", async () => {
    const cfg = threeSpentSeats();
    native = () => nativeAccounts.length === 1 ? reserveRefused() : new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder(); controller.enqueue(encoder.encode('{"error":{"code":"'));
        await Bun.sleep(350); controller.enqueue(encoder.encode('origin_rejected","message":"refused"}}')); controller.close();
      },
    }), { status: 503, headers: { "content-type": "application/json" } });
    const result = await post(cfg);
    expect(result.status).toBe(503);
    expect(calls).toEqual(["native:gpt-reserve", "native:gpt-reserve"]);
  });

  test("a pending tool turn retains its only reasoning ciphertext on the issuing seat", async () => {
    const cfg = config(), lane = { "thread-id": "pending-native-reasoning" }; seats();
    const item = { type: "reasoning", id: "rs_private", encrypted_content: "owner-only-fixture", summary: [] };
    native = body => issuedReasoning(body.model, item);
    expect((await post(cfg, {}, lane)).text).toContain(item.encrypted_content); calls.length = 0;
    let wire = "";
    native = body => { wire = JSON.stringify(body); return sse(body.model, "ok"); };
    const input = [item, { type: "function_call", name: "lookup", arguments: "{}", call_id: "call_fixture" }];
    expect((await post(cfg, { input }, lane)).status).toBe(200);
    expect(calls).toEqual(["native:gpt-reserve"]); expect(wire).toContain(item.encrypted_content);
  });

  test("a summarized blob stays intact on the same Reserve seat", async () => {
    const cfg = config(), lane = { "thread-id": "same-reserve-history" }; seats();
    const item = { type: "reasoning", id: "rs_same123", summary: [{ type: "summary_text", text: "readable" }], encrypted_content: "same-owner-cipher" };
    native = body => issuedReasoning(body.model, item);
    expect((await post(cfg, {}, lane)).text).toContain(item.encrypted_content);
    let wire = ""; native = body => { wire = JSON.stringify(body); return sse(body.model, "ok"); };
    const input = [item, { role: "user", content: "continue" }];
    expect((await post(cfg, { input }, lane)).status).toBe(200);
    expect(new Set(nativeAccounts).size).toBe(1); expect(wire).toContain(item.encrypted_content);
  });

  test("a closed reasoning id is not forwarded to an unknown item store", async () => {
    const cfg = config(); seats(false); let wire = "";
    relay = (_req, body) => { wire = JSON.stringify(body); return sse(body.model, "ok"); };
    const input = [{ type: "reasoning", id: "rs_foreign123", summary: [{ type: "summary_text", text: "readable history" }] },
      { role: "user", content: "continue" }];
    expect((await post(cfg, { input, store: true })).status).toBe(200);
    expect(calls).toEqual(["relay:gpt-6-luna"]); expect(wire).toContain("readable history"); expect(wire).not.toContain("rs_foreign123");
  });

  test("a pre-wire retry veto returns the alternate's exact last response", async () => {
    const budget = createRequestExecutionBudget();
    const booking = budget.reserveDispatch({ sendClass: "account-failover", targetKey: "alternate" });
    if (!booking.allowed) throw new Error("first move not admitted");
    const last = new Response("readable alternate refusal", { status: 503, headers: { "retry-after": "0", "x-fixture": "from B" } });
    let vetoed = false;
    try {
      const result = await sendReserveSeat({ remaining: new Set([B]), movesSent: 0, transientRetries: 0 }, budget, booking.permit,
        new AbortController().signal, async (permit, transient) => {
          if (transient) { vetoed = true; return undefined; }
          expect(permit.use()).toBe(true); return last;
        });
      expect(vetoed).toBe(true); expect(result?.status).toBe(last.status); expect(result?.headers.get("x-fixture")).toBe("from B");
      expect(await result?.text()).toBe("readable alternate refusal"); expect(budget.used).toBe(1);
    } finally { booking.permit.release(); }
  });

  function alternateRetry(first: Response, retry: (admit: () => void) => Promise<Response>,
    signal = new AbortController().signal, caller = signal) {
    const budget = createRequestExecutionBudget();
    const booking = budget.reserveDispatch({ sendClass: "account-failover", targetKey: "alternate" });
    if (!booking.allowed) throw new Error("first move not admitted");
    return sendReserveSeat({ remaining: new Set([B]), movesSent: 0, transientRetries: 0 }, budget, booking.permit, signal,
      async (permit, transient, onAdmitted) => {
        const admit = () => { expect(permit.use()).toBe(true); onAdmitted?.(); };
        if (transient) return retry(admit);
        admit(); return first;
      }, caller).finally(() => booking.permit.release());
  }

  test("Reserve retry returns the alternate refusal when pacing denies a replacement", async () => {
    const original = new Response(new Uint8Array([0, 255, 7]), { status: 503, statusText: "busy", headers: { "x-seat": "B" } });
    markCodexWsPreludeProjection(original);
    const result = await alternateRetry(original, async () => { throw new RequestPacingQueueOverloadError("native", "queue_full", 5); });
    expect(result?.status).toBe(503); expect(result?.statusText).toBe("busy"); expect(result?.headers.get("x-seat")).toBe("B");
    expect(isCodexWsPreludeProjection(result!)).toBe(true); expect(await result!.bytes()).toEqual(new Uint8Array([0, 255, 7]));
  });

  test.each(["placement", "caller"])("Reserve retry distinguishes %s cancellation during backoff", async source => {
    const placement = new AbortController(), caller = new AbortController();
    const reason = new DOMException(source, source === "caller" ? "AbortError" : "TimeoutError");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const upstream = new Response(new ReadableStream<Uint8Array>({ pull(c) {
      c.enqueue(new TextEncoder().encode("B refused")); c.close();
      timer = setTimeout(() => (source === "caller" ? caller : placement).abort(reason), 25);
    } }, { highWaterMark: 0 }), { status: 503, headers: { "retry-after": "30" } });
    try {
      const result = alternateRetry(upstream, async () => { throw new Error("unexpected replacement"); },
        AbortSignal.any([caller.signal, placement.signal]), caller.signal);
      if (source === "caller") expect(await result.catch(error => error)).toBe(reason);
      else { const refusal = await result; expect(refusal?.status).toBe(503); expect(await refusal?.text()).toBe("B refused"); }
    } finally { clearTimeout(timer); }
  });

  test.each([false, true])("Reserve retry settles on the physical replacement (throws: %s)", async fails => {
    const problem = new RequestPacingQueueOverloadError("native", "queue_expired", 1);
    const result = alternateRetry(new Response("obsolete", { status: 503 }), async admit => {
      admit(); if (fails) throw problem;
      return new Response("replacement answered", { status: 400 });
    });
    if (fails) expect(await result.catch(error => error.cause)).toBe(problem);
    else { const answer = await result; expect(answer?.status).toBe(400); expect(await answer?.text()).toBe("replacement answered"); }
  });

  test("Reserve retry hands back an oversized chunk without a tee or missing bytes", async () => {
    const large = new Uint8Array(65537).fill(231);
    const first = new Response(new ReadableStream({ start(c) {
      c.enqueue(Uint8Array.of(8)); c.enqueue(large); c.enqueue(Uint8Array.of(9)); c.close();
    } }), { status: 503 });
    const clone = spyOn(first, "clone");
    const result = await alternateRetry(first, async () => { throw new Error("oversized refusal was retried"); });
    expect(result?.status).toBe(503); expect(await result!.bytes()).toEqual(new Uint8Array([8, ...large, 9]));
    expect(clone).not.toHaveBeenCalled();
  });

  test("Reserve retry publishes slow refusal before EOF and preserves its pending read", async () => {
    let finish!: () => void;
    const first = new Response(new ReadableStream({ start(c) {
      c.enqueue(Uint8Array.of(0xff)); finish = () => { c.enqueue(Uint8Array.of(0x80)); c.close(); };
    } }), { status: 503 });
    const result = alternateRetry(first, async () => new Response("unexpected replacement")).then(async refusal => {
      expect(refusal).toBeDefined();
      expect(await shouldRetryCodexPoolAccountQuota(refusal!)).toBe(false);
      return refusal;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let published: boolean;
    try { published = await Promise.race([result.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 1000); })]); }
    finally { clearTimeout(timer); finish(); }
    const response = await result;
    expect(published).toBe(true); expect(response?.status).toBe(503); expect(await response!.bytes()).toEqual(Uint8Array.of(0xff, 0x80));
  });

  test("a denied physical claim refunds the pool window for another turn", async () => {
    const cfg = twoSpentSeats(); native = reserveRefused; let admission = 0;
    const sendBudget = createRequestExecutionBudget(comboExecutionBudgetPolicy(4), undefined, { charge: () => true, refund() {}, beforePhysicalSend: () => ++admission !== 2 });
    const before = sharedPoolBackpressure().state(now).recoveryDispatches;
    expect((await post(cfg, {}, {}, undefined, { sendBudget })).text).toContain("response.completed");
    expect(calls).toEqual(["native:gpt-reserve", "relay:gpt-6-luna"]); expect(sendBudget.used).toBe(2);
    expect(sharedPoolBackpressure().state(now).recoveryDispatches).toBe(before);
  });

  test("a portable follow-up holds a remembered Reserve seat's empty quota prelude", async () => {
    const cfg = threeSpentSeats(), lane = { "thread-id": "previous-reserve-owner" };
    expect((await post(cfg, {}, lane)).text).toContain("response.completed");
    const owner = nativeAccounts[0]; calls.length = 0; nativeAccounts.length = 0;
    native = body => sse(body.model, nativeAccounts.at(-1) === owner ? "created-then-quota" : "ok");
    const result = await post(cfg, { input: "another portable question" }, lane);
    expect(result.text).toContain("response.completed"); expect(result.text).not.toContain("usage_limit_reached");
    expect(calls).toEqual(["native:gpt-reserve", "native:gpt-reserve"]);
    expect(nativeAccounts[0]).toBe(owner); expect(nativeAccounts[1]).not.toBe(owner);
  });

  test("a native pin later in the combo still asks the relay when an earlier target becomes eligible", async () => {
    seats(false);
    const cfg = config();
    cfg.combos!.luna!.targets.unshift({ provider: "metered", model: "gpt-6-sol" });
    cfg.providers.metered!.disabled = true;
    const lane = { "thread-id": "native-after-primary" };
    relay = refusedConnect;
    expect((await post(cfg, {}, lane)).status).toBe(200);
    expect(calls).toEqual(["relay:gpt-6-luna", "native:gpt-6-luna"]);
    calls.length = 0;
    cfg.providers.metered!.disabled = false;
    relay = () => sse("gpt-6-luna", "ok");
    clearComboTargetCooldowns("luna", ["relay/gpt-6-luna"]);
    expect((await post(cfg, { input: "again" }, lane)).status).toBe(200);
    expect(calls).toEqual(["relay:gpt-6-luna"]);
  });
  test("a session-only caller naming bare gpt-6-luna binds its seat and reuses it on the next turn", async () => {
    seats(false);
    const session = { session_id: "opencode-session-1" };
    const first: RequestLogContext = { model: "", provider: "" };
    expect((await post(config(), { model: "gpt-6-luna" }, session, undefined, { logCtx: first })).status).toBe(200);
    expect(first.affinity).toBe("new_bind");
    const second: RequestLogContext = { model: "", provider: "" };
    expect((await post(config(), { model: "gpt-6-luna" }, session, undefined, { logCtx: second })).status).toBe(200);
    expect(second.affinity).toBe("reused");
    expect(calls).toEqual(["native:gpt-6-luna", "native:gpt-6-luna"]);
  });
  test("a non-codex-lb Luna endpoint is not treated as the relay", async () => {
    seats(false);
    const cfg = config({ relay: { adapter: "openai-responses", authMode: "key", apiKey: "k", baseUrl: "https://relay.example.test/v1" } });
    expect((await post(cfg)).status).toBe(200);
    expect(calls).toEqual(["native:gpt-6-luna"]);
  });
  test("a key that may not reach the relay keeps today's order instead of ending in the relay's 403", async () => {
    seats(); native = body => body.model === "gpt-reserve" ? reserveRefused() : sse(body.model, "ok");
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/luna", input: "ping", stream: true, prompt_cache_key: "luna-order" }) }),
    config(), { model: "", provider: "" }, { admission: local, admissionScope: { providers: ["openai"], models: [] } });
    expect(response.status).toBe(200);
    await response.text();
    expect(calls).toEqual(["native:gpt-reserve", "native:gpt-6-luna"]);
    expect(nativeHints).toEqual(["model=gpt-reserve", "model=gpt-6-luna"]);
  });
  test("a non-Luna failover combo costs no extra route resolution", () => {
    const targets = Array.from({ length: 30 }, (_, index) => ({ provider: "openai", model: `gpt-6-sol-${index}` }));
    const cfg = config({}, targets);
    const resolve = mock(() => undefined);
    const plan = planLunaReserveLegs({ ...cfg.combos!.luna!, targets } as never, resolve, () => true, () => true);
    expect(plan).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
  test("a combo whose native target is not Luna keeps its configured order", async () => {
    seats(); native = () => reserveRefused();
    const cfg = config({}, [{ provider: "openai", model: "gpt-6-sol" }, { provider: "relay", model: "gpt-6-sol" }]);
    await post(cfg);
    expect(calls.map(call => call.split(":")[0])).toEqual(["native", "relay"]);
  });
  test("a bridged Messages turn plans the same legs: native Reserve, relay, native ordinary", async () => {
    seats(); native = body => body.model === "gpt-reserve" ? reserveRefused() : sse(body.model, "ok");
    relay = refusedConnect;
    const translatorBudget = createTranslatorBudget();
    const envelope = createProtocolEnvelope({ inbound: "messages", translatorBudget,
      body: { model: "combo/luna", max_tokens: 16, stream: true, messages: [{ role: "user", content: "ping" }] } });
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/luna", input: "ping", stream: true, prompt_cache_key: "luna-order" }) }),
    config(), { model: "", provider: "" }, { admission: local, translatorBudget,
      protocolSource: { inbound: "messages", envelope, dispatchNativeChild: () => { throw new Error("no Luna leg is a native child"); } } });
    expect(response.status).toBe(200);
    await response.text();
    expect(calls).toEqual(["native:gpt-reserve", "relay:gpt-6-luna", "native:gpt-6-luna"]);
  });
  test("WebSocket frames follow the same order", async () => {
    seats(); native = body => body.model === "gpt-reserve" ? reserveRefused() : sse(body.model, "ok");
    relay = refusedConnect;
    const handler = createWebsocketHandler({ config: config(), deps: {} } as Parameters<typeof createWebsocketHandler>[0]);
    const server = Bun.serve<WsData>({ hostname: "127.0.0.1", port: 0, websocket: handler,
      fetch(req, srv) { return srv.upgrade(req, { data: buildResponsesWsData(new Headers(), local, tryReserveCodexWebSocket() ?? undefined) }) ? undefined : new Response("upgrade failed", { status: 400 }); } });
    const ws = new WebSocket(String(server.url).replace("http:", "ws:"));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("websocket deadline")), 8000);
        ws.onopen = () => ws.send(JSON.stringify({ type: "response.create", model: "combo/luna", input: "ping" }));
        ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket failed")); };
        ws.onmessage = event => { if (String(event.data).includes("response.completed")) { clearTimeout(timer); resolve(); } };
      });
    } finally { ws.close(); await server.stop(true); }
    expect(calls).toEqual(["native:gpt-reserve", "relay:gpt-6-luna", "native:gpt-6-luna"]);
  });
});
