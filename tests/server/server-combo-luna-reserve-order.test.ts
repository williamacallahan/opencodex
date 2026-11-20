import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { handleResponses } from "../../src/server/responses";
import { CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { planLunaReserveLegs } from "../../src/server/responses/combo-luna-legs";
import { clearComboSelectionState, clearComboTargetCooldowns, isComboTargetInCooldown } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
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
let relay: (request: Request, body: { model: string }) => Response | Promise<Response>;
let native: (body: { model: string }) => Response | Promise<Response>;
let metered: () => Response;

function sse(model: string, frames: "ok" | "created-then-fail" | "created-then-quota" | "delta-then-bare-quota"): Response {
  const created = { type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress", model, output: [] } };
  const body = frames === "ok" ? [created,
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hi" },
    { type: "response.completed", response: { ...created.response, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] }] } }]
    : frames === "delta-then-bare-quota" ? [created,
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "partial" },
      { type: "error", code: "usage_limit_reached", message: "Limit reached" }]
    : [created, { type: "response.failed", response: { ...created.response, status: "failed", error: frames === "created-then-quota" ? { code: "usage_limit_reached", message: "Limit reached" } : { code: "server_error", message: "boom" } } }];
  return new Response(body.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
const streamOnlyRelay = (): OcxConfig => config({ relay: { adapter: "openai-responses", authMode: "key", apiKey: "relay-key",
  baseUrl: "https://relay.example.test/backend-api/codex", responsesStreamOnly: true } });
const meteredJson = () => Response.json({ id: "resp_metered", object: "response", status: "completed", model: "gpt-6-luna",
  output: [{ id: "msg_m", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "metered answer", annotations: [] }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
const reserveRefused = () => Response.json({ error: { code: "usage_limit_reached", message: "Limit reached" } }, { status: 429, headers: { "retry-after": "3600" } });
const refusedConnect = () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); };

function config(extraProviders: OcxConfig["providers"] = {}, targets?: NonNullable<OcxConfig["combos"]>[string]["targets"]): OcxConfig {
  return {
    port: 0, defaultProvider: "openai", codexMainAccountHardLock: false, accountPoolStrategy: "quota", autoSwitchThreshold: 0,
    activeCodexAccountId: A, creditCodexAccountIds: [],
    codexAccounts: [A, B].map(id => ({ id, email: `${id}@example.test`, isMain: false, plan: "pro" as const })),
    providers: {
      openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: "pool" },
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
async function post(cfg: OcxConfig, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, signal?: AbortSignal, logCtx: RequestLogContext = { model: "", provider: "" }) {
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", signal,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "combo/luna", input: "ping", stream: true, prompt_cache_key: "luna-order", ...extra }) }),
    cfg, logCtx, { admission: local, ...(signal ? { abortSignal: signal } : {}) });
  return { status: response.status, text: await response.text() };
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
  calls = [];
  native = body => sse(body.model, "ok");
  relay = () => sse("gpt-6-luna", "ok");
  metered = () => sse("gpt-6-luna", "ok");
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.clone().json() as { model: string };
    if (request.url === CODEX_RESPONSES_HTTP_URL) { calls.push(`native:${body.model}`); return native(body); }
    if (request.url.startsWith("https://relay.example.test")) { calls.push(`relay:${body.model}`); return relay(request, body); }
    if (request.url.startsWith("https://metered.example.test")) { calls.push(`metered:${body.model}`); return metered(); }
    throw new Error(`unexpected upstream ${request.url}`);
  }, { preconnect() {} }));
});
afterEach(async () => {
  mock.restore(); release?.(); release = undefined;
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); resetQuotaQueryBackoffForTests();
  clearComboSelectionState(); clearComboRecallForTests(); clearComboTargetCooldowns();
  await flushConfigDirHardeningForTests(); setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

describe("combo Luna leg order: native Reserve, relay, native ordinary, metered", () => {
  test.each([429, 402])("a Reserve %i moves to the relay, and a relay pre-connect failure moves to native ordinary Luna", async status => {
    seats(); native = body => body.model === "gpt-reserve" ? Response.json({ error: { code: "usage_limit_reached" } }, { status }) : sse(body.model, "ok");
    relay = refusedConnect;
    const result = await post(config());
    expect(result.status).toBe(200);
    expect(calls).toEqual(["native:gpt-reserve", "relay:gpt-6-luna", "native:gpt-6-luna"]);
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
  describe("a non-streaming client on a stream-only relay (SSE folded into JSON)", () => {
    test("a zero-output relay failure is not a win: the next policy-eligible leg answers", async () => {
      seats(false); relay = () => sse("gpt-6-luna", "created-then-fail"); metered = meteredJson;
      const result = await post(streamOnlyRelay(), { stream: false });
      expect(calls).toEqual(["relay:gpt-6-luna", "metered:gpt-6-luna"]);
      expect(result.status).toBe(200);
      expect(result.text).toContain("metered answer");
    });
    test("a quota refusal after relay output returns the error and sends nothing else", async () => {
      seats(false); relay = () => sse("gpt-6-luna", "delta-then-bare-quota"); metered = meteredJson;
      const result = await post(streamOnlyRelay(), { stream: false });
      expect(calls).toEqual(["relay:gpt-6-luna"]);
      expect(result.status).toBe(429);
      expect(result.text).toContain("usage_limit_reached");
    });
    test("a genuine relay HTTP 429 still reaches native ordinary Luna", async () => {
      seats(); native = body => body.model === "gpt-reserve" ? reserveRefused() : sse(body.model, "ok");
      relay = reserveRefused;
      const result = await post(streamOnlyRelay(), { stream: false });
      expect(result.status).toBe(200);
      expect(calls).toEqual(["native:gpt-reserve", "relay:gpt-6-luna", "native:gpt-6-luna"]);
    });
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
  test("a turn-state handle keeps today's routing: native serves ordinary Luna and the relay is untouched", async () => {
    seats(false);
    const result = await post(config(), {}, { "x-codex-turn-state": "opaque" });
    expect(result.status).toBe(200);
    expect(calls).toEqual(["native:gpt-6-luna"]);
  });
  test("a continuation of a stored response keeps today's routing and stays with native", async () => {
    seats(false);
    expect((await post(config())).status).toBe(200);
    expect(calls).toEqual(["relay:gpt-6-luna"]);
    calls.length = 0;
    expect((await post(config(), { previous_response_id: "resp_1" })).status).toBe(200);
    expect(calls).toEqual(["native:gpt-6-luna"]);
  });
  test.each([
    ["encrypted reasoning in the input", { input: [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque-cipher" }, { role: "user", content: "ping" }] }],
    ["a turn-state handle in client_metadata", { client_metadata: { "x-codex-turn-state": "opaque" } }],
    ["an uploaded file reference", { input: [{ role: "user", content: [{ type: "input_file", file_id: "file_1" }] }] }],
  ])("%s keeps today's order: native serves ordinary Luna and the relay is untouched", async (_name, extra) => {
    seats(false);
    expect((await post(config(), extra)).status).toBe(200);
    expect(calls).toEqual(["native:gpt-6-luna"]);
  });
  test("a later turn of a conversation the relay served stays on the relay: no Reserve re-plan, no move to native", async () => {
    seats(false);
    const lane = { "thread-id": "luna-conversation" };
    expect((await post(config(), {}, lane)).status).toBe(200);
    expect(calls).toEqual(["relay:gpt-6-luna"]);
    calls.length = 0;
    seats();
    const laterTurn = { input: [
      { role: "user", content: "ping" },
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "relay-cipher" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "pong" }] },
      { role: "user", content: "again" },
    ] };
    expect((await post(config(), laterTurn, lane)).status).toBe(200);
    expect((await post(config(), { input: "portable follow-up" }, lane)).status).toBe(200);
    expect(calls).toEqual(["relay:gpt-6-luna", "relay:gpt-6-luna"]);
  });
  test.each([
    { name: "a portable turn asks the eligible relay before spending native included usage", input: "again", nativeReserve: false, expected: "relay:gpt-6-luna" },
    { name: "a portable turn uses newly available native Reserve before the relay", input: "again", nativeReserve: true, expected: "native:gpt-reserve" },
    { name: "a turn carrying native encrypted reasoning stays on native", nativeReserve: false, input: [
      { type: "reasoning", id: "rs_native", summary: [], encrypted_content: "native-cipher" }, { role: "user", content: "again" },
    ], expected: "native:gpt-6-luna" },
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
    expect((await post(config(), { model: "gpt-6-luna" }, session, undefined, first)).status).toBe(200);
    expect(first.affinity).toBe("new_bind");
    const second: RequestLogContext = { model: "", provider: "" };
    expect((await post(config(), { model: "gpt-6-luna" }, session, undefined, second)).status).toBe(200);
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
  });
  test("a non-Luna failover combo costs no extra route resolution", () => {
    const targets = Array.from({ length: 30 }, (_, index) => ({ provider: "openai", model: `gpt-6-sol-${index}` }));
    const cfg = config({}, targets);
    const resolve = mock(() => undefined);
    const plan = planLunaReserveLegs({ ...cfg.combos!.luna!, targets } as never, () => true, resolve, () => true, () => true);
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
