import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import * as accountStore from "../../src/codex/account-store";
import { capturePoolQuotaWriter, saveCodexAccountCredential } from "../../src/codex/account-store";
import { fetchPoolAccountQuota } from "../../src/codex/auth-api/pool-quota-probe";
import { poolAccountDto } from "../../src/codex/auth-api/account-list";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { applyAccountQuotaFromUpstreamHeaders, clearAccountQuota, getAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { POOL_RESERVE_FRESHNESS_MS, poolLunaReserveSelection } from "../../src/codex/pool-reserve";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearCodexAccountCooldown, clearCodexUpstreamHealth, clearThreadAccountMap, getCodexQuotaHealthSnapshot, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { bindThreadAffinity, deleteThreadAffinity, getThreadAffinity } from "../../src/codex/routing/thread-affinity";
import { forgetCodexFailureWindows, isCodexFailureWindowDegraded, noteCodexFailureWindowSample } from "../../src/codex/routing/failure-window";
import { codexFailureWindowOutcomeMeta } from "../../src/codex/routing/failure-window";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import {
  codexPoolAffinityKey, resolveCodexAuthContext, applyCodexAuthContextToProvider, materializeCodexUpstreamAuth,
  createCodexAuthDispatchGuard, releaseCodexAuthContextProbeLease, CodexAccountCooldownError, CodexReserveUnavailableError, CodexPoolExhaustedError, CodexPoolAccountCreditsOffError, cooldownErrorResponse,
} from "../../src/codex/auth-context";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { prepareCodexWsRequest, CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { rebindPoolCreditPolicy } from "../../src/codex/pool-credit-policy";
import { addFinalRequestLog, type RequestLogContext } from "../../src/server/request-log";
import { readUsageEntries } from "../../src/usage/log";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { codexAccountUnusableReason } from "../../src/codex/account-usability";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { resolveDataPlaneAdmissionSecret } from "../../src/server/auth-cors";
import { issueTurnStateHandle, noteTurnStateCaller, runTurnStateCallerScope, turnStateBinding, TURN_STATE_HEADER } from "../../src/server/turn-state-handles";
import { handleResponses } from "../../src/server/responses/core";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { canTryUnknownCodexReserve, markCodexQuotaProbeLeaseDispatched, releaseCodexQuotaScopeProbeLease, tryAcquireCodexQuotaScopeProbeLease } from "../../src/codex/routing/probe-lease";
import { flushCodexHealthCooldowns, reloadCodexHealthCooldownsForTests, scopedHealthFor, setScopedHealth } from "../../src/codex/routing/health-store";
import { CODEX_QUOTA_PROBE_INTERVAL_MS } from "../../src/codex/routing/cooldown-math";

const A = "pool-reserve-a";
const B = "pool-reserve-b";
const base: OcxProviderConfig = { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" };
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let now: number;
function config(): OcxConfig {
  return {
    port: 0, providers: { openai: base }, codexMainAccountHardLock: false, accountPoolStrategy: "quota",
    autoSwitchThreshold: 0, activeCodexAccountId: A, creditCodexAccountIds: [],
    codexAccounts: [A, B].map(id => ({ id, email: `${id}@example.test`, isMain: false, plan: "pro" })),
  };
}
function ordinary(id: string, percent = 100) { updateAccountQuota(id, percent, now + 86_400_000); }
function reserve(id = B, percent = 25, observedAt = now, resetAt = now + 604_800_000) {
  setAccountQuotaFromParsed(id, { customWindows: [{ label: "Luna Reserve", percent, resetAt, observedAt }] });
}
/** A stored Reserve window that is full: the seat is depleted and ChatGPT has told us Reserve is spent too. */
function noReserve(id: string) { reserve(id, 100); }
function usage(grant = true) {
  return { plan_type: "pro", rate_limit: { allowed: false, primary_window: {
    used_percent: 100, reset_at: Math.floor(now / 1000) + 86_400, limit_window_seconds: 604_800,
  } }, rate_limit_upsell: { banner_type: grant ? "luna_reserve" : "other" },
  additional_rate_limits: [{ limit_name: "gpt-reserve", rate_limit: { allowed: true, primary_window: {
    used_percent: 25, reset_at: Math.floor(now / 1000) + 604_800, limit_window_seconds: 604_800,
  } } }] };
}
async function build(cfg = config(), modelId = "gpt-6-luna", requestHeaders = new Headers()) {
  const ctx = await resolveCodexAuthContext(requestHeaders, cfg, "pool", { modelId });
  const headers = materializeCodexUpstreamAuth(new Headers(), ctx, { config: cfg, modelId });
  const provider = applyCodexAuthContextToProvider(base, ctx, "pool");
  const raw = { model: modelId, input: [] };
  const parsed: OcxParsedRequest = { modelId, stream: true, context: { messages: [] }, options: {}, _rawBody: raw };
  const request = await withTestTranslatorBudget(createResponsesPassthroughAdapter(provider)).buildRequest(parsed, { headers });
  return { ctx, headers, request, raw };
}
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME; previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-pool-reserve-"));
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
  const acl = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => acl); setAsyncIcaclsRunnerForTests(async () => acl);
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); resetQuotaQueryBackoffForTests();
  for (const id of [A, B]) {
    clearAccountNeedsReauth(id);
    saveCodexAccountCredential(id, { accessToken: `fixture-access-${id}`, refreshToken: `fixture-refresh-${id}`,
      chatgptAccountId: `fixture-workspace-${id}`, expiresAt: now + 86_400_000 });
    ordinary(id);
  }
  clearAccountNeedsReauth("__main__");
});
afterEach(async () => {
  mock.restore(); clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); resetQuotaQueryBackoffForTests();
  await flushConfigDirHardeningForTests(); setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

test("pool WHAM probes opt in and publish a separate Reserve window, then retract a missing grant", async () => {
  let granted = true;
  const headers: Headers[] = [];
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: unknown, init?: RequestInit) => {
    headers.push(new Headers(init?.headers)); return Response.json(usage(granted));
  }, { preconnect() {} }));
  const result = await fetchPoolAccountQuota(B, true, "pro");
  expect(headers[0]?.get("x-openai-codex-luna-reserve")).toBe("1");
  expect(result.quota?.weeklyPercent).toBe(100);
  expect(result.quota?.customWindows).toEqual([{ label: "Luna Reserve", percent: 25,
    resetAt: Math.floor(now / 1000) + 604_800, observedAt: now }]);
  const cfg = config();
  const dto = poolAccountDto(cfg, cfg.codexAccounts![1]!, result, true, false, 0, false);
  expect(dto.quota?.customWindows?.[0]?.label).toBe("Luna Reserve");
  expect(dto.quota?.weeklyPercent).toBe(100);
  const url = new URL("http://localhost/api/codex-auth/accounts");
  const response = await handleCodexAuthAPI(new Request(url), url, cfg);
  const accounts = (await response!.json()).accounts;
  expect(accounts.find((account: { id: string }) => account.id === B).quota.customWindows[0].label).toBe("Luna Reserve");
  granted = false;
  const removed = await fetchPoolAccountQuota(B, true, "pro");
  expect(removed.quota?.customWindows).toEqual([]);
  expect(removed.quota?.weeklyPercent).toBe(100);
});

test("a window-less successful WHAM response retracts an old Reserve grant", async () => {
  reserve();
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ rate_limit: { allowed: true } }),
    { preconnect() {} }));
  const result = await fetchPoolAccountQuota(B, true, "pro");
  expect(result.quota?.customWindows).toEqual([]);
  expect(result.quota?.weeklyPercent).toBe(100);
});

describe("Luna Reserve where selection used to skip it", () => {
  async function buildPinned(accountId: string, cfg = config()) {
    const ctx = await resolveCodexAuthContext(new Headers(), cfg, "pool", { modelId: "gpt-6-luna", accountId });
    const provider = applyCodexAuthContextToProvider(base, ctx, "pool");
    const parsed: OcxParsedRequest = { modelId: "gpt-6-luna", stream: true, context: { messages: [] }, options: {}, _rawBody: { model: "gpt-6-luna", input: [] } };
    const request = await withTestTranslatorBudget(createResponsesPassthroughAdapter(provider))
      .buildRequest(parsed, { headers: materializeCodexUpstreamAuth(new Headers(), ctx, { config: cfg, modelId: "gpt-6-luna" }) });
    return { ctx, request };
  }
  test("a pinned seat that holds Reserve serves Luna from that Reserve", async () => {
    reserve();
    const { ctx, request } = await buildPinned(B);
    expect(ctx.kind).toBe("pool"); expect(ctx.accountId).toBe(B);
    expect(JSON.parse(request.body).model).toBe("gpt-reserve");
  });
  test("a pin never borrows another seat's Reserve", async () => {
    reserve(B); noReserve(A);
    await expect(buildPinned(A)).rejects.toBeInstanceOf(CodexPoolAccountCreditsOffError);
  });
  test("a pinned depleted seat with no reported grant is not offered Reserve, since a pin cannot move after a refusal (case e)", async () => {
    await expect(buildPinned(A)).rejects.toBeInstanceOf(CodexPoolAccountCreditsOffError);
  });
  test("a pin to a seat with included quota keeps ordinary Luna and never borrows a depleted seat's Reserve (case e)", async () => {
    ordinary(A, 40);
    const { ctx, request } = await buildPinned(A);
    expect(ctx.accountId).toBe(A);
    expect(JSON.parse(request.body).model).toBe("gpt-6-luna");
  });
});

describe("automatic Luna Reserve selection and shared HTTP/WebSocket wire model", () => {
  // ChatGPT never reports Reserve availability, so a served `gpt-reserve` request proves Reserve
  // works only when the seat could not have served it from included usage. Every pairing of seat
  // states is therefore pinned: Reserve goes to a depleted seat or is not requested at all.
  const seatStates = [
    { name: "included usage, no Reserve window", ordinaryPercent: 40, reservePercent: undefined },
    { name: "included usage, usable Reserve window", ordinaryPercent: 40, reservePercent: 25 },
    { name: "included usage, spent Reserve window", ordinaryPercent: 40, reservePercent: 100 },
    { name: "depleted, no Reserve window", ordinaryPercent: 100, reservePercent: undefined },
    { name: "depleted, usable Reserve window", ordinaryPercent: 100, reservePercent: 25 },
    { name: "depleted, spent Reserve window", ordinaryPercent: 100, reservePercent: 100 },
  ] as const;
  test.each(seatStates.flatMap(a => seatStates.map(b => [a.name, b.name, a, b] as const)))(
    "Reserve is requested only on a depleted seat: A %s, B %s", async (_aName, _bName, a, b) => {
      const seats = [[A, a], [B, b]] as const;
      for (const [id, state] of seats) {
        ordinary(id, state.ordinaryPercent);
        if (state.reservePercent !== undefined) reserve(id, state.reservePercent);
      }
      const reserveSeats = seats.filter(([, state]) => state.ordinaryPercent === 100 && state.reservePercent !== 100).map(([id]): string => id);
      const includedSeats = seats.filter(([, state]) => state.ordinaryPercent < 100).map(([id]): string => id);
      const outcome = await build().then(
        built => ({ accountId: built.ctx.accountId, model: JSON.parse(built.request.body).model as string }),
        (error: unknown) => error,
      );
      if (reserveSeats.length > 0) {
        expect(outcome).toMatchObject({ model: "gpt-reserve" });
        expect(reserveSeats).toContain((outcome as { accountId: string }).accountId);
      } else if (includedSeats.length > 0) {
        expect(outcome).toMatchObject({ model: "gpt-6-luna" });
        expect(includedSeats).toContain((outcome as { accountId: string }).accountId);
      } else {
        expect(outcome).toBeInstanceOf(Error);
      }
    });
  test("all ordinary-held seats use the fresh Reserve seat on HTTP and WebSocket", async () => {
    reserve(); noReserve(A);
    const { ctx, request, raw } = await build();
    expect(ctx.kind).toBe("pool"); expect(ctx.accountId).toBe(B);
    expect(new Headers(request.headers).get("chatgpt-account-id")).toBe(`fixture-workspace-${B}`);
    expect(JSON.parse(request.body).model).toBe("gpt-reserve");
    expect(request.outboundModelId).toBe("gpt-reserve");
    const ws = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, { headers: request.headers, body: request.body })!;
    expect(JSON.parse(ws.frameText).model).toBe("gpt-reserve");
    expect(ws.headers["chatgpt-account-id"]).toBe(`fixture-workspace-${B}`);
    expect(raw.model).toBe("gpt-6-luna");
  });
  test("Sol still returns the existing quota-exhausted 429 even with a Reserve grant", async () => {
    reserve();
    const error = await build(config(), "gpt-6.1-sol").catch(cause => cause);
    expect(error).toBeInstanceOf(CodexPoolExhaustedError);
    const response = cooldownErrorResponse(error);
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("usage_limit_reached");
  });
  test.each(["quota", "round-robin", "fill-first", "reset-first"] as const)("%s spends Reserve before another seat's included quota", async strategy => {
    reserve(); ordinary(A, 40);
    const cfg = config(); cfg.accountPoolStrategy = strategy; cfg.creditCodexAccountIds = [B];
    setAccountQuotaFromParsed(B, { credits: { hasCredits: true, balance: 20, observedAt: now } });
    const { ctx, request } = await build(cfg);
    expect(ctx.accountId).toBe(B); expect(JSON.parse(request.body).model).toBe("gpt-reserve");
  });
  test("a thread bound to a seat with included quota still goes to Reserve on a depleted seat (case d)", async () => {
    reserve(); ordinary(A, 40);
    bindThreadAffinity("luna-on-included", A, now, "shared");
    bindThreadAffinity("luna-on-held", B, now, "shared");
    const moved0 = poolLunaReserveSelection(config(), "gpt-6-luna", "shared", {}, undefined, "luna-on-included", now);
    expect(moved0.reserve).toBe(true); expect(moved0.quotaScope).toBe("reserve");
    const headers = new Headers({ "session-id": "included-bound", "thread-id": "included-bound-thread" });
    const first = await build(config(), "gpt-6-luna", headers);
    expect(first.ctx.accountId).toBe(B);
    expect(JSON.parse(first.request.body).model).toBe("gpt-reserve");
    const moved = poolLunaReserveSelection(config(), "gpt-6-luna", "shared", {}, undefined, "luna-on-held", now);
    expect(moved.reserve).toBe(true); expect(moved.quotaScope).toBe("reserve");
  });
  test("a depleted seat with no Reserve window is chosen for Reserve before a seat with included quota (case a)", async () => {
    ordinary(A, 40);
    const selected = poolLunaReserveSelection(config(), "gpt-6-luna", "shared", {}, undefined, undefined, now);
    expect(selected.reserve).toBe(true); expect(selected.quotaScope).toBe("reserve");
    const { ctx, request } = await build();
    expect(ctx.accountId).toBe(B);
    expect(JSON.parse(request.body).model).toBe("gpt-reserve");
  });
  test("a depleted seat whose Reserve window is exhausted is not chosen (case b)", async () => {
    ordinary(A, 40); noReserve(B);
    expect(poolLunaReserveSelection(config(), "gpt-6-luna", "shared", {}, undefined, undefined, now).reserve).toBe(false);
    const { ctx, request } = await build();
    expect(ctx.accountId).toBe(A);
    expect(JSON.parse(request.body).model).toBe("gpt-6-luna");
  });
  test.each([
    ["an explicit Retry-After", { retryAfter: "3600" }],
    ["a reset timestamp", { resetAt: 1 }],
    ["no timing evidence", {}],
  ] as const)("a Reserve refusal with %s cools only that seat's Reserve scope; Luna stays on the included seat (case c)", async (_name, timing) => {
    ordinary(A, 40);
    const cfg = config();
    const first = await build(cfg);
    expect(first.ctx.accountId).toBe(B);
    recordCodexUpstreamOutcome(cfg, B, 429, { ...codexFailureWindowOutcomeMeta(first.ctx), modelId: "gpt-6-luna", now,
      ...("resetAt" in timing ? { resetAt: Math.floor(now / 1000) + 604_800 } : timing) });
    expect(getCodexQuotaHealthSnapshot(B, "reserve", now)?.quotaScope).toBe("reserve");
    expect(getCodexQuotaHealthSnapshot(B, "shared", now)).toBeNull();
    const retry = await build(cfg);
    expect(retry.ctx.accountId).toBe(A);
    expect(JSON.parse(retry.request.body).model).toBe("gpt-6-luna");
  });
  // ChatGPT never discloses Reserve and its refusals come and go per seat; a refusal's reset names the
  // seat's spent plan window. Honoring it kept all ten pool seats off Reserve for hours (2026-11-20).
  test("a Reserve refusal that announces a far plan reset asks that seat for Reserve again after the probe interval", async () => {
    ordinary(A, 40);
    const cfg = config();
    const first = await build(cfg);
    if (first.ctx.kind !== "pool" || !first.ctx.probeLeaseId) throw new Error("expected a discovery lease");
    expect(first.ctx.accountId).toBe(B);
    recordCodexUpstreamOutcome(cfg, B, 429, { ...codexFailureWindowOutcomeMeta(first.ctx), modelId: "gpt-6-luna", now,
      probeQuotaScope: "reserve", probeLeaseId: first.ctx.probeLeaseId, resetAt: Math.floor(now / 1000) + 604_800 });
    expect((await build(cfg)).ctx.accountId).toBe(A);
    now += 5 * 60_000 + 1;
    const again = await build(cfg);
    expect(again.ctx.accountId).toBe(B);
    expect(JSON.parse(again.request.body).model).toBe("gpt-reserve");
  });
  test("an aged unreported Reserve serve retains its seat ahead of a fresh grant", async () => {
    noReserve(B);
    const headers = new Headers({ "session-id": "aged", "thread-id": "aged" });
    const first = await build(config(), "gpt-6-luna", headers);
    if (first.ctx.kind !== "pool" || !first.ctx.probeLeaseId) throw new Error("expected a discovery lease");
    expect(first.ctx.accountId).toBe(A);
    recordCodexUpstreamOutcome(config(), A, 200, { ...codexFailureWindowOutcomeMeta(first.ctx), reserveServed: true,
      threadId: first.ctx.affinityKey, probeQuotaScope: "reserve", probeLeaseId: first.ctx.probeLeaseId });
    now += POOL_RESERVE_FRESHNESS_MS + 1;
    reserve(B);
    const continuation = await build(config(), "gpt-6-luna", headers);
    expect(continuation.ctx.accountId).toBe(A);
    expect(continuation.request.outboundModelId).toBe("gpt-reserve");
    expect(() => createCodexAuthDispatchGuard(continuation.ctx, config(), "gpt-6-luna")?.(continuation.headers)).not.toThrow();
    expect((await build()).ctx.accountId).toBe(B);
  });
  test("a Reserve retry uses included Luna instead of exploring an unverified seat", async () => {
    const cfg = config();
    const third = "pool-reserve-c";
    cfg.codexAccounts!.push({ id: third, email: "c@example.test", isMain: false, plan: "pro" });
    saveCodexAccountCredential(third, { accessToken: "access-c", refreshToken: "refresh-c",
      chatgptAccountId: `fixture-workspace-${third}`, expiresAt: now + 86_400_000 });
    ordinary(third, 40);
    // B is depleted but has neither a fresh reported grant nor a completed Reserve turn.
    const retry = await resolveCodexAuthContext(new Headers(), cfg, "pool", {
      modelId: "gpt-6-luna", excludeAccountId: A, verifiedPoolReserveOnly: true,
    });
    expect(retry.accountId).toBe(third);
    expect(retry.kind === "pool" && retry.poolReserve === true).toBe(false);
  });
  test("a pre-stream refusal uses one recently successful Reserve alternate and preserves the prompt key", async () => {
    const cfg = config();
    cfg.providers.openai = { ...base, codexAccountMode: "pool" };
    const ordinarySeat = "pool-reserve-c";
    cfg.codexAccounts!.push({ id: ordinarySeat, email: "c@example.test", isMain: false, plan: "pro" });
    saveCodexAccountCredential(ordinarySeat, { accessToken: "fixture-access-c", refreshToken: "fixture-refresh-c",
      chatgptAccountId: "fixture-workspace-c", expiresAt: now + 86_400_000 });
    ordinary(ordinarySeat, 40);
    noReserve(A);
    const sends: { account: string | null; model: string; key?: string }[] = [];
    let refuseA = false;
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe(CODEX_RESPONSES_HTTP_URL);
      const body = await request.json();
      const account = request.headers.get("chatgpt-account-id");
      sends.push({ account, model: body.model, key: body.prompt_cache_key });
      if (refuseA && account === `fixture-workspace-${A}`) {
        return Response.json({ error: { code: "usage_limit_reached", message: "Limit reached" } }, {
          status: 429, headers: { "retry-after": "90" },
        });
      }
      return Response.json({ id: `resp_pool_reserve_${sends.length}`, object: "response", status: "completed", created_at: 1,
        model: body.model, output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
    }, { preconnect() {} }));
    const send = (key: string) => handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json", "session-id": key, "thread-id": key }, body: JSON.stringify({
        model: "openai/gpt-6-luna", input: "ping", stream: false, prompt_cache_key: key,
      }) }), cfg, { model: "", provider: "" });
    const release = acquireOwnedSpendHome();
    try {
      expect((await send("other-thread")).status).toBe(200);
      expect(sends.at(-1)).toEqual({ account: `fixture-workspace-${B}`, model: "gpt-reserve", key: "other-thread" });
      const currentQuota = getAccountQuota(B)!;
      noReserve(B); reserve(A);
      expect((await send("warm-thread")).status).toBe(200);
      expect(sends.at(-1)).toEqual({ account: `fixture-workspace-${A}`, model: "gpt-reserve", key: "warm-thread" });
      setAccountQuotaFromParsed(B, { ...currentQuota, customWindows: [] });
      expect((await send("warm-thread")).status).toBe(200);
      refuseA = true;
      expect((await send("warm-thread")).status).toBe(200);
      now += 90_001;
      expect((await send("warm-thread")).status).toBe(200);
      expect(sends.slice(2).map(({ account }) => account)).toEqual([
        `fixture-workspace-${A}`, `fixture-workspace-${A}`, `fixture-workspace-${B}`, `fixture-workspace-${B}`,
      ]);
      expect(sends.slice(2).map(({ model, key }) => [model, key])).toEqual(
        Array.from({ length: 4 }, () => ["gpt-reserve", "warm-thread"]),
      );
    } finally { release(); }
  });
  test.each(["quota", "round-robin"] as const)("%s records only the accounts that sent a correlated Reserve refusal and its ordinary retry", async strategy => {
    const cfg = config(); cfg.accountPoolStrategy = strategy; cfg.providers.openai = { ...base, codexAccountMode: "pool" };
    ordinary(A, 40);
    const headers = new Headers({ "thread-id": "stream-trial", "session-id": "stream-trial", "content-type": "application/json" });
    const key = codexPoolAffinityKey(headers)!;
    const log: RequestLogContext = { model: "", provider: "" };
    const sends: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { model } = await request.json(); sends.push(model);
      if (model === "gpt-reserve") {
        expect(getThreadAffinity(key, "reserve")).toBeUndefined();
        const frames = [{ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 25, window_minutes: 10080 } } },
          { type: "response.created", response: { id: "resp_try", status: "in_progress", output: [] } },
          { type: "response.failed", response: { id: "resp_try", status: "failed", output: [], error: { code: "usage_limit_reached", message: "Limit reached" } } } ];
        return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "resp_included", object: "response", status: "completed", model, output: [], created_at: 1 });
    }, { preconnect() {} }));
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers,
        body: JSON.stringify({ model: "openai/gpt-6-luna", input: "ping", stream: false }) }), cfg, log);
      expect(response.status).toBe(200);
      expect(sends).toEqual(["gpt-reserve", "gpt-6-luna"]);
      expect(getThreadAffinity(key, "shared")?.accountId).toBe(A);
      expect(getThreadAffinity(key, "reserve")).toBeUndefined();
      addFinalRequestLog("reserve-refusal", now, log, response.status);
      const row = readUsageEntries().find(entry => entry.requestId === "reserve-refusal");
      expect(row?.attempts?.map(({ wireModel, status, sendCount }) => [wireModel, status, sendCount])).toEqual([
        ["gpt-reserve", 429, 1], ["gpt-6-luna", 200, 1],
      ]);
    } finally { release(); }
  });
  test.each(["bound", "output", "foreign", "foreign-control", "ambiguous", "effect", "body-state", "body-state-http"])("an HTTP SSE %s turn is not sent to an alternate", async reason => {
    const cfg = config(); cfg.providers.openai = { ...base, codexAccountMode: "pool", upstreamWebsocket: false };
    ordinary(A, 40); reserve(B);
    const headers = new Headers({ "content-type": "application/json" });
    const withState = reason.startsWith("body-state");
    if (!withState) { headers.set("thread-id", "sse-boundary"); headers.set("session-id", "sse-boundary"); }
    const client_metadata = withState ? { [TURN_STATE_HEADER]: issueTurnStateHandle("fixture-state",
      turnStateBinding("openai", new Headers({ "chatgpt-account-id": `fixture-workspace-${B}`, authorization: `Bearer fixture-access-${B}` }))) } : undefined;
    if (reason === "bound") bindThreadAffinity(codexPoolAffinityKey(headers)!, B, now, "reserve");
    const sends: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      sends.push((await request.json()).model);
      if (reason === "body-state-http") return Response.json({ error: { code: "usage_limit_reached" } }, { status: 429 });
      const frames = [ ...(reason === "foreign-control" ? [{ type: "codex.rate_limits", stream_id: "foreign", rate_limits: {} }] : []),
        { type: "response.created", response: { id: "resp_this", status: "in_progress", output: [] } },
        ...(reason === "output" ? [{ type: "response.output_text.delta", delta: "already visible" }] : []),
        { type: "response.failed", response: { id: reason === "foreign" ? "resp_other" : "resp_this", status: "failed",
          output: reason === "effect" ? [{ type: "function_call", name: "write" }] : [],
          error: { code: reason === "ambiguous" ? "unknown_error" : "usage_limit_reached", message: "quota" } } } ];
      return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }, { preconnect() {} }));
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers,
        body: JSON.stringify({ model: "openai/gpt-6-luna", input: "ping", stream: true, client_metadata }) }), cfg, { model: "", provider: "" });
      if (reason === "body-state-http") expect(response.status).toBe(429);
      else expect(await response.text()).toContain("response.failed");
      expect(sends).toEqual(["gpt-reserve"]);
    } finally { release(); }
  });
  test("concurrent real turns do not repeat an unknown Reserve trial or retry before its hold", async () => {
    const cfg = config();
    cfg.providers.openai = { ...base, codexAccountMode: "pool" };
    ordinary(A, 40);
    const attempts: string[] = [];
    const entered = Promise.withResolvers<void>();
    const releaseRefusal = Promise.withResolvers<void>();
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe(CODEX_RESPONSES_HTTP_URL);
      const body = await request.json();
      attempts.push(body.model);
      if (body.model === "gpt-reserve") {
        entered.resolve();
        await releaseRefusal.promise;
        return Response.json({ error: { code: "usage_limit_reached", message: "Limit reached" } }, {
          status: 429, headers: { "retry-after": "900" },
        });
      }
      return Response.json({ id: `resp_luna_${attempts.length}`, object: "response", status: "completed", created_at: 1,
        model: body.model, output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
    }, { preconnect() {} }));
    const send = () => handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({
        model: "openai/gpt-6-luna", input: "ping", stream: false,
      }) }), cfg, { model: "", provider: "" });
    const release = acquireOwnedSpendHome();
    const first = send();
    try {
      await Promise.race([entered.promise, first.then(() => { throw new Error("first turn did not try Reserve"); })]);
      expect((await send()).status).toBe(200);
      expect(attempts).toEqual(["gpt-reserve", "gpt-6-luna"]);
      releaseRefusal.resolve();
      expect((await first).status).toBe(200);
      now += 899_000;
      expect((await send()).status).toBe(200);
      expect(attempts).toEqual(["gpt-reserve", "gpt-6-luna", "gpt-6-luna", "gpt-6-luna"]);
      now += 1_000;
      expect((await send()).status).toBe(200);
      expect(attempts.slice(4)).toEqual(["gpt-reserve", "gpt-6-luna"]);
    } finally {
      releaseRefusal.resolve();
      await first;
      release();
    }
  });
  test.each(["cancel", "abort", "quota", "incomplete JSON"])("a Reserve trial settles on %s without proving success", async ending => {
    const cfg = config(); cfg.providers.openai = { ...base, codexAccountMode: "pool", upstreamWebsocket: false };
    ordinary(A, 40);
    const models: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe(CODEX_RESPONSES_HTTP_URL);
      const { model } = await request.json();
      models.push(model);
      if (models.length === 1) {
        if (ending === "incomplete JSON") return Response.json({ object: "response", status: "incomplete", model, output: [] });
        const terminal = { type: "response.failed", response: { id: "resp_trial", object: "response", model,
          status: "failed", error: { code: "usage_limit_reached", message: "Limit reached" } } };
        return new Response(ending === "quota" ? `event: response.failed\ndata: ${JSON.stringify(terminal)}\n\n`
          : new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_trial"}}\n\n'));
          } }), { headers: { "content-type": "text/event-stream", "retry-after": "900" } });
      }
      return Response.json({ id: "resp_next", object: "response", status: "completed", created_at: 1,
        model, output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
    }, { preconnect() {} }));
    cfg.connectTimeoutMs = 500;
    const trialHeaders = new Headers({ "session-id": "trial", "thread-id": "trial", "content-type": "application/json" });
    const abort = new AbortController();
    const send = (stream = false, signal?: AbortSignal) => handleResponses(new Request("http://localhost/v1/responses", { method: "POST", signal,
      headers: trialHeaders, body: JSON.stringify({ model: "openai/gpt-6-luna", input: "ping", stream }),
    }), cfg, { model: "", provider: "" });
    const release = acquireOwnedSpendHome();
    try {
      const response = await send(ending !== "incomplete JSON", abort.signal);
      if (ending === "abort") abort.abort();
      else if (ending === "cancel") await response.body?.cancel();
      else await response.text();
      expect(models).toEqual(["gpt-reserve"]);
      expect(getThreadAffinity(codexPoolAffinityKey(trialHeaders)!, "reserve")).toBeUndefined();
      const interval = ending === "quota" ? 900_000 : 300_000;
      now += interval - 1;
      expect((await send()).status).toBe(200);
      now += 1;
      expect((await send()).status).toBe(200);
      expect(models).toEqual(["gpt-reserve", "gpt-6-luna", "gpt-reserve"]);
    } finally { release(); }
  });
  test.each(["header", "body", "compact body", "native main with a stored duplicate", "same key id"])("a turn-state owner still serves the %s follow-up when B gains Reserve", async carrier => {
    const cfg = config(); cfg.providers.openai = { ...base, codexAccountMode: "pool", upstreamWebsocket: false };
    ordinary(A, 40); noReserve(B);
    const main = carrier === "native main with a stored duplicate";
    const rotating = carrier === "same key id";
    if (rotating) cfg.apiKeys = [{ id: "client", name: "client", key: "fixture-current", createdAt: new Date(now).toISOString(),
      pendingRotation: { id: "rotation", key: "fixture-pending", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() } }];
    if (main) {
      const token = fakeChatGptJwt({ chatgpt_account_id: `fixture-workspace-${A}`, exp: Math.floor(now / 1000) + 3600 });
      writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: token, account_id: `fixture-workspace-${A}`, refresh_token: "fixture-refresh-main" } }));
      cfg.activeCodexAccountId = "__main__"; ordinary("__main__", 40);
      reconcileMainCodexAccountRuntimeState();
      expect(codexAccountUnusableReason(cfg, A)).toBe("duplicate_main");
    }
    const sends: { account: string | null; state: string | null; model: string }[] = [];
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.json();
      sends.push({ account: request.headers.get("chatgpt-account-id"), state: request.headers.get(TURN_STATE_HEADER) ?? body.client_metadata?.[TURN_STATE_HEADER] ?? null, model: body.model });
      if (main) expect(request.headers.get("authorization")).not.toBe(`Bearer fixture-access-${A}`);
      return Response.json({ id: "resp_handle", object: "response", model: body.model, status: "completed", output: [], created_at: 1 },
        { headers: { [TURN_STATE_HEADER]: issueTurnStateHandle("fixture-turn", turnStateBinding("openai", request.headers)) } });
    }, { preconnect() {} }));
    const send = (handle?: string, key = "fixture-current") => runTurnStateCallerScope(() => {
      const admission = rotating ? resolveDataPlaneAdmissionSecret(key, cfg)! : undefined;
      if (admission) noteTurnStateCaller(admission);
      const compact = handle && carrier === "compact body";
      const req = new Request(compact ? "http://localhost/v1/responses/compact" : "http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json", ...(handle && !carrier.endsWith("body") ? { [TURN_STATE_HEADER]: handle } : {}) },
      body: JSON.stringify({ model: "openai/gpt-6-luna", input: "ping", stream: false,
        ...(handle && carrier.endsWith("body") ? { client_metadata: { [TURN_STATE_HEADER]: handle } } : {}) }),
      });
      const log = { model: "", provider: "" };
      return compact ? handleResponsesCompact(req, cfg, log) : handleResponses(req, cfg, log, { admission });
    });
    const release = acquireOwnedSpendHome();
    try {
      const first = await send(); await first.text();
      const handle = first.headers.get(TURN_STATE_HEADER);
      expect(handle).toMatch(/^ocx-ts-/);
      if (main) cfg.activeCodexAccountId = A;
      reserve(B);
      if (rotating) {
        const foreign = await send(handle!, "fixture-pending"); await foreign.text();
        expect(foreign.status).toBe(409);
        expect(sends).toHaveLength(1);
      }
      const second = await send(handle!); await second.text();
      expect(second.status).toBe(200);
      const account = `fixture-workspace-${A}`;
      expect(sends).toEqual([{ account, state: null, model: "gpt-6-luna" }, { account, state: "fixture-turn", model: "gpt-6-luna" }]);
      cfg.pausedCodexAccountIds = [main ? "__main__" : A];
      const refused = await send(handle!); await refused.text();
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(sends).toHaveLength(2);
    } finally { release(); if (main) resetMainCodexAccountIdentityTrackingForTests(); }
  });
  test("a shared workspace cannot move a turn-state handle to the other member's Reserve", async () => {
    const cfg = config(); cfg.providers.openai = { ...base, codexAccountMode: "pool", upstreamWebsocket: false };
    const workspace = "team-workspace";
    const token = (member: string, revision: number) => fakeChatGptJwt({ "https://api.openai.com/auth": {
      chatgpt_account_id: workspace, chatgpt_user_id: member }, jti: revision });
    const save = (id: string, revision: number) => saveCodexAccountCredential(id, {
      accessToken: token(id, revision), chatgptAccountId: workspace, refreshToken: `fixture-${id}`, expiresAt: now + 3_600_000,
    });
    save(A, 1); save(B, 1); ordinary(A, 40); noReserve(B);
    const sends: { member: string; model: string; state: string | null }[] = [];
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const member = req.headers.get("authorization") === `Bearer ${token(B, 1)}` ? B : A;
      sends.push({ member, model: (await req.json()).model, state: req.headers.get(TURN_STATE_HEADER) });
      return Response.json({ id: "resp_member", object: "response", status: "completed", output: [] },
        { headers: { [TURN_STATE_HEADER]: issueTurnStateHandle("fixture-team-turn", turnStateBinding("openai", req.headers)) } });
    }, { preconnect() {} }));
    const send = (handle?: string) => handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json", ...(handle ? { [TURN_STATE_HEADER]: handle } : {}) },
      body: JSON.stringify({ model: "openai/gpt-6-luna", input: "ping", stream: false }),
    }), cfg, { model: "", provider: "" });
    const release = acquireOwnedSpendHome();
    try {
      const first = await send(); await first.text();
      const handle = first.headers.get(TURN_STATE_HEADER)!; expect(handle).toMatch(/^ocx-ts-/);
      save(A, 2); ordinary(A, 40); reserve(B);
      const next = await send(handle); await next.text(); expect(next.status).toBe(200);
      expect(sends).toEqual([{ member: A, model: "gpt-6-luna", state: null }, { member: A, model: "gpt-6-luna", state: "fixture-team-turn" }]);
      cfg.pausedCodexAccountIds = [A];
      const refused = await send(handle); await refused.text(); expect(refused.status).toBe(409);
      expect(sends).toHaveLength(2);
    } finally { release(); }
  });
  test("a file turn uses the recorded issuer without affinity and refuses when the issuer is unavailable", async () => {
    const cfg = config(); cfg.providers.openai = { ...base, codexAccountMode: "pool" };
    ordinary(A, 40); noReserve(B);
    const models: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { model } = await request.json();
      models.push(model);
      return Response.json({ id: "resp_file_issuer", object: "response", status: "completed", created_at: 1,
        model, output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
    }, { preconnect() {} }));
    const send = (input: unknown = "ping") => handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json", "session-id": "files", "thread-id": "files" },
      body: JSON.stringify({ model: "openai/gpt-6-luna", input, stream: false }),
    }), cfg, { model: "", provider: "" });
    const release = acquireOwnedSpendHome();
    try {
      expect((await send()).status).toBe(200);
      setAccountQuotaFromParsed(B, { customWindows: [] });
      const file = [{ role: "user", content: [{ type: "input_file", file_id: "file_a" }] }];
      const key = codexPoolAffinityKey(new Headers({ "session-id": "files", "thread-id": "files" }))!;
      deleteThreadAffinity(key, "shared");
      expect((await send(file)).status).toBe(200);
      cfg.pausedCodexAccountIds = [A];
      expect((await send(file)).status).toBeGreaterThanOrEqual(400);
      expect(models).toEqual(["gpt-6-luna", "gpt-6-luna"]);
    } finally { release(); }
  });
  test("a stale included-owner binding does not suppress Reserve", () => {
    reserve(); ordinary(A, 40);
    bindThreadAffinity("stale-included-owner", A, now, "shared");
    // Replacing A's credential advances its generation, so the resolver will release this
    // binding. The planner must not treat it as a live included owner and spend included
    // quota while B's Reserve is available.
    saveCodexAccountCredential(A, { accessToken: "replacement-access-a", refreshToken: "replacement-refresh-a",
      chatgptAccountId: `fixture-workspace-${A}`, expiresAt: now + 86_400_000 });
    const selected = poolLunaReserveSelection(config(), "gpt-6-luna", "shared", {}, undefined, "stale-included-owner", now);
    expect(selected.reserve).toBe(true);
    expect(selected.quotaScope).toBe("reserve");
  });
  test("an excluded included owner does not steer a retry onto another shared seat", () => {
    reserve(); ordinary(A, 40);
    bindThreadAffinity("excluded-luna-owner", A, now, "shared");
    const selected = poolLunaReserveSelection(config(), "gpt-6-luna", "shared", {}, A, "excluded-luna-owner", now);
    expect(selected.reserve).toBe(true);
    expect(selected.quotaScope).toBe("reserve");
  });
  test("auth context adopts a legacy parent binding before choosing Reserve scope", async () => {
    // No seat is offerable for Reserve, so the adopted ordinary binding is what serves the thread.
    noReserve(B); ordinary(A, 40);
    const legacyParent = "legacy-parent-thread";
    bindThreadAffinity(legacyParent, A, now, "shared");
    const headers = new Headers({
      "session-id": "child-session",
      "thread-id": "child-thread",
      "x-codex-parent-thread-id": legacyParent,
    });

    const { ctx } = await build(config(), "gpt-6-luna", headers);

    expect(ctx.kind).toBe("pool");
    expect(ctx.accountId).toBe(A);
    expect(ctx.quotaScope).toBe("shared");
    expect(ctx.affinityKey).toBeDefined();
    expect(getThreadAffinity(ctx.affinityKey!, "shared")?.accountId).toBe(A);
    expect(getThreadAffinity(legacyParent, "shared")).toBeUndefined();
  });
  test.each(["quota", "reset-first"] as const)("%s moves a bound included owner to Reserve on a depleted seat", async strategy => {
    ordinary(A, 90); noReserve(B);
    const cfg = config(); cfg.accountPoolStrategy = strategy; cfg.autoSwitchThreshold = 80;
    cfg.pool = { cacheAffinity: false };
    const headers = new Headers({ "session-id": "kept-session", "thread-id": "kept-thread" });
    const first = await build(cfg, "gpt-6-luna", headers);
    expect(first.ctx.accountId).toBe(A);
    const alternate = "pool-reserve-c";
    saveCodexAccountCredential(alternate, { accessToken: "fixture-access-c", refreshToken: "fixture-refresh-c",
      chatgptAccountId: "fixture-workspace-c", expiresAt: now + 86_400_000 });
    cfg.codexAccounts!.push({ id: alternate, email: "c@example.test", isMain: false, plan: "pro" });
    updateAccountQuota(alternate, 10, now + 3_600_000);
    reserve();
    const second = await build(cfg, "gpt-6-luna", headers);
    expect(second.ctx.accountId).toBe(B);
    expect(second.ctx.quotaScope).toBe("reserve");
    expect(JSON.parse(second.request.body).model).toBe("gpt-reserve");
  });
  test("a Reserve binding keeps its seat after the older shared owner's quota resets", async () => {
    ordinary(A, 40); noReserve(B);
    const headers = new Headers({ "session-id": "serving-session", "thread-id": "serving-thread" });
    const first = await build(config(), "gpt-6-luna", headers);
    expect(first.ctx.accountId).toBe(A);
    now += 1000; ordinary(A); noReserve(A); reserve();
    const moved = await build(config(), "gpt-6-luna", headers);
    expect(moved.ctx.accountId).toBe(B);
    expect(moved.ctx.quotaScope).toBe("reserve");
    now += 1000; ordinary(A, 0);
    const kept = await build(config(), "gpt-6-luna", headers);
    expect(kept.ctx.accountId).toBe(B);
    expect(kept.ctx.quotaScope).toBe("reserve");
    // A newer soft binding to an included seat no longer outranks Reserve.
    now += 1000; bindThreadAffinity(kept.ctx.affinityKey!, A, now, "shared");
    expect((await build(config(), "gpt-6-luna", headers)).ctx.accountId).toBe(B);
  });
  test.each([false, true])("legacy migration preserves serving order when Reserve is legacy: %s", async reserveLegacy => {
    ordinary(A, 40); noReserve(B);
    const originalUse = now;
    const parent = "legacy-serving-parent";
    const headers = new Headers({ "session-id": "legacy-serving-session", "thread-id": "legacy-serving-thread",
      "x-codex-parent-thread-id": parent });
    const first = await build(config(), "gpt-6-luna", headers);
    expect(first.ctx.accountId).toBe(A);
    now += 1000; ordinary(A); noReserve(A); reserve();
    const moved = await build(config(), "gpt-6-luna", headers);
    expect(moved.ctx.accountId).toBe(B);
    const key = moved.ctx.affinityKey!;
    deleteThreadAffinity(key, "shared");
    bindThreadAffinity(parent, A, originalUse, "shared");
    if (reserveLegacy) {
      deleteThreadAffinity(key, "reserve");
      bindThreadAffinity(parent, B, now, "reserve");
    }
    now += 1000; ordinary(A, 0);
    const kept = await build(config(), "gpt-6-luna", headers);
    expect(kept.ctx.accountId).toBe(B);
    expect(kept.ctx.quotaScope).toBe("reserve");
    expect(getThreadAffinity(key, "shared")?.lastUsedAt).toBe(originalUse);
  });
  test("Reserve comes before a seat that already permits spending fresh credits", async () => {
    reserve(); noReserve(A); const cfg = config(); cfg.creditCodexAccountIds = [A];
    setAccountQuotaFromParsed(A, { credits: { hasCredits: true, balance: 20, observedAt: now } });
    const { ctx, request } = await build(cfg);
    expect(ctx.accountId).toBe(B); expect(JSON.parse(request.body).model).toBe("gpt-reserve");
  });
  test("a bound included seat that new-thread steering avoids still yields to Reserve", () => {
    reserve(); ordinary(A, 40);
    bindThreadAffinity("luna-on-degraded", A, now, "shared");
    try {
      for (let sample = 0; sample < 20; sample++) noteCodexFailureWindowSample(config(), A, true, now);
      expect(isCodexFailureWindowDegraded(A, now)).toBe(true);
      const moved = poolLunaReserveSelection(config(), "gpt-6-luna", "shared", {}, undefined, "luna-on-degraded", now);
      expect(moved.reserve).toBe(true); expect(moved.quotaScope).toBe("reserve");
    } finally { forgetCodexFailureWindows(); }
  });
  test("with no seat offerable for Reserve, Luna selection options and scope are returned untouched", () => {
    noReserve(A); ordinary(B, 40);
    const options = { modelEligibleAccountIds: new Set([A, B]) };
    const result = poolLunaReserveSelection(config(), "gpt-6-luna", "shared", options, undefined, undefined, now);
    expect(result.reserve).toBe(false); expect(result.options).toBe(options); expect(result.quotaScope).toBe("shared");
  });
  test("with Reserve spent on every depleted seat the consented-credit path still serves ordinary Luna", async () => {
    noReserve(A); noReserve(B);
    const cfg = config(); cfg.creditCodexAccountIds = [A];
    setAccountQuotaFromParsed(A, { credits: { hasCredits: true, balance: 20, observedAt: now } });
    const { ctx, request } = await build(cfg);
    expect(ctx.accountId).toBe(A); expect(JSON.parse(request.body).model).toBe("gpt-6-luna");
  });
  test.each(["stale", "full", "elapsed", "paused", "excluded"])("%s Reserve does not admit a held pool", async state => {
    noReserve(A);
    reserve(B, state === "full" ? 100 : 25, state === "stale" ? now - POOL_RESERVE_FRESHNESS_MS - 1 : now,
      state === "elapsed" ? now - 1 : now + 604_800_000);
    const cfg = config();
    if (state === "paused") cfg.pausedCodexAccountIds = [B];
    if (state === "excluded") cfg.codexPool = { excludedPlans: ["pro"] };
    await expect(build(cfg)).rejects.toBeInstanceOf(CodexPoolExhaustedError);
  });
  test("a shared-scope quota hold does not block the independent Reserve window", async () => {
    reserve(); const cfg = config();
    recordCodexUpstreamOutcome(cfg, B, 429, { modelId: "gpt-6-luna", resetAt: Math.floor(now / 1000) + 86_400, now });
    expect(JSON.parse((await build(cfg)).request.body).model).toBe("gpt-reserve");
  });
  test("revocation during pacing refuses Reserve instead of quietly spending consented credits", async () => {
    reserve(); noReserve(A); const cfg = config(); cfg.creditCodexAccountIds = [B];
    setAccountQuotaFromParsed(B, { credits: { hasCredits: true, balance: 20, observedAt: now } });
    const { ctx, headers } = await build(cfg);
    const guard = createCodexAuthDispatchGuard(ctx, cfg, "gpt-6-luna")!;
    noReserve(B);
    expect(() => guard(headers)).toThrow(CodexPoolAccountCreditsOffError);
  });
  test.each(["retracted", "expired"])("a %s Reserve grant cannot become an unleased trial during pacing", async state => {
    reserve(); noReserve(A);
    const { ctx, headers } = await build();
    const guard = createCodexAuthDispatchGuard(ctx, config(), "gpt-6-luna")!;
    if (state === "retracted") setAccountQuotaFromParsed(B, { customWindows: [] });
    else now += POOL_RESERVE_FRESHNESS_MS + 1;
    expect(() => guard(headers)).toThrow(CodexAccountCooldownError);
  });
  test("ordinary header updates cannot refresh an old Reserve grant", async () => {
    reserve(); noReserve(A); now += POOL_RESERVE_FRESHNESS_MS + 1; ordinary(B);
    await expect(build()).rejects.toBeInstanceOf(CodexPoolExhaustedError);
  });
  test("Reserve response quota and exhaustion do not replace or clear ordinary quota", async () => {
    reserve(); noReserve(A); const cfg = config();
    const { ctx } = await build(cfg);
    if (ctx.kind !== "pool") throw new Error("expected stored pool credential");
    const copy = rebindPoolCreditPolicy(ctx, { ...ctx, poolQuotaWriter: capturePoolQuotaWriter(B, ctx) });
    applyAccountQuotaFromUpstreamHeaders(B, new Headers({ "x-codex-primary-used-percent": "30",
      "x-codex-primary-reset-at": String(Math.floor(now / 1000) + 604_800) }), ctx.writerGeneration, undefined,
    { modelId: "gpt-6-luna", poolWriter: copy.poolQuotaWriter, poolResponse: true });
    expect(getAccountQuota(B)?.weeklyPercent).toBe(100);
    expect(getAccountQuota(B)?.customWindows?.[0]?.percent).toBe(25);
    recordCodexUpstreamOutcome(cfg, B, 429, { ...codexFailureWindowOutcomeMeta(ctx), modelId: "gpt-6-luna",
      resetAt: Math.floor(now / 1000) + 604_800, now });
    expect(getCodexQuotaHealthSnapshot(B, "reserve", now)?.quotaScope).toBe("reserve");
    expect(getCodexQuotaHealthSnapshot(B, "shared", now)).toBeNull();
    await expect(build(cfg)).rejects.toBeInstanceOf(CodexPoolExhaustedError);
  });
  test("Reserve headers without a captured writer preserve ordinary display quota while ordinary writer-free headers still update it", () => {
    ordinary(B, 71);
    const reserveHeaders = new Headers({ "x-codex-primary-used-percent": "30",
      "x-codex-primary-reset-at": String(Math.floor(now / 1000) + 604_800),
      "x-codex-secondary-used-percent": "20",
      "x-codex-secondary-reset-at": String(Math.floor(now / 1000) + 604_800) });
    applyAccountQuotaFromUpstreamHeaders(B, reserveHeaders, undefined, undefined, { modelId: " GPT-RESERVE ", poolResponse: true });
    expect(getAccountQuota(B)?.weeklyPercent).toBe(71);
    applyAccountQuotaFromUpstreamHeaders(B, reserveHeaders, undefined, undefined, { modelId: "gpt-6-luna", poolResponse: true });
    expect(getAccountQuota(B)?.weeklyPercent).toBe(30);
  });
  test("automatic Reserve response publication keeps quota mode when writer capture is unavailable", async () => {
    reserve(B); noReserve(A);
    const capture = spyOn(accountStore, "capturePoolQuotaWriter").mockReturnValue(undefined);
    const cfg = config(); cfg.providers.openai = { ...base, codexAccountMode: "pool" };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "resp_pool_reserve_header_guard", object: "response", status: "completed", created_at: 1,
        model: "gpt-reserve", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }), { headers: {
        "content-type": "application/json", "x-codex-primary-used-percent": "30",
        "x-codex-primary-reset-at": String(Math.floor(now / 1000) + 604_800),
        "x-codex-secondary-used-percent": "20", "x-codex-secondary-reset-at": String(Math.floor(now / 1000) + 604_800),
      } }), { preconnect() {} }));
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-6-luna", input: "ping", stream: false }) }), cfg, { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect(capture).toHaveBeenCalled();
      expect(getAccountQuota(B)?.weeklyPercent).toBe(100);
    } finally { release(); }
  });
  test("Compact records the first Reserve refusal before the alternate can time out", async () => {
    const cfg = config(); cfg.providers.openai = { ...base, codexAccountMode: "pool" };
    reserve(A); reserve(B); cfg.accountPoolStrategy = "fill-first";
    const retryAt = now + 900_000;
    const sends: Array<string | null> = [];
    const observedHolds: Array<number | undefined> = [];
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe(`${CODEX_RESPONSES_HTTP_URL}/compact`);
      expect((await request.json()).model).toBe("gpt-reserve");
      sends.push(request.headers.get("chatgpt-account-id"));
      if (sends.length === 1) return Response.json({ error: { code: "usage_limit_reached", message: "Limit reached" } }, {
        status: 429, headers: { "retry-after": "900" },
      });
      observedHolds.push(getCodexQuotaHealthSnapshot(A, "reserve", now)?.cooldownUntil);
      now += 30_000;
      throw new DOMException("Upstream timed out", "TimeoutError");
    }, { preconnect() {} }));
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-6-luna", input: "ping" }),
      }), cfg, { model: "", provider: "" });
      expect(response.status).toBe(502);
      expect(sends).toEqual([`fixture-workspace-${A}`, `fixture-workspace-${B}`]);
      expect(observedHolds).toEqual([retryAt]);
      expect(getCodexQuotaHealthSnapshot(A, "reserve", now)?.cooldownUntil).toBe(retryAt);
      expect(getCodexQuotaHealthSnapshot(B, "reserve", now)).toBeNull();
    } finally { release(); }
  });
  for (const compact of [false, true]) test.each(["reserve", "reserve-before-included", "ordinary", "sol"])(`Responses${compact ? " compact" : ""} HTTP %s dispatches only the expected upstream model`, async state => {
    if (state !== "ordinary") { reserve(); noReserve(A); } else noReserve(B);
    if (state === "ordinary" || state === "reserve-before-included") ordinary(A, 40);
    const cfg = config(); cfg.providers.openai = { ...base, codexAccountMode: "pool" };
    let sends = 0; let sentModel: string | undefined; let sentAccount: string | undefined;
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe(`${CODEX_RESPONSES_HTTP_URL}${compact ? "/compact" : ""}`);
      sends++; sentModel = (await request.json()).model;
      sentAccount = request.headers.get("chatgpt-account-id") ?? undefined;
      return Response.json({ id: "resp_pool_reserve", object: "response", status: "completed", created_at: 1,
        model: sentModel, output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
    }, { preconnect() {} }));
    const release = acquireOwnedSpendHome();
    try {
      const request = new Request(`http://localhost/v1/responses${compact ? "/compact" : ""}`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({
          model: `openai/${state === "sol" ? "gpt-6.1-sol" : "gpt-6-luna"}`, input: "ping", stream: false,
        }) });
      const response = compact ? await handleResponsesCompact(request, cfg, { model: "", provider: "" })
        : await handleResponses(request, cfg, { model: "", provider: "" });
      const body = await response.json();
      expect(response.status).toBe(state === "sol" ? 429 : 200);
      expect(sends).toBe(state === "sol" ? 0 : 1);
      if (state === "sol") expect(body.error.code).toBe("usage_limit_reached");
      else {
        expect(sentModel).toBe(state === "ordinary" ? "gpt-6-luna" : "gpt-reserve");
        expect(sentAccount).toBe(`fixture-workspace-${state === "ordinary" ? A : B}`);
      }
    } finally { release(); }
  });
  test("a key scoped to Luna keeps its native compact when the hub moves it to Reserve", async () => {
    // Reserve is a capacity substitution the hub makes on its own; the key's scope covers the model
    // its caller selected, as on the ordinary Responses path.
    reserve(); noReserve(A);
    const cfg = config(); cfg.providers.openai = { ...base, codexAccountMode: "pool" };
    cfg.apiKeys = [{ id: "luna-only", name: "luna-only", key: "ocx_data_" + "f".repeat(40), createdAt: "2026-11-25T00:00:00Z",
      allowedModels: ["openai/gpt-6-luna"] }];
    const sends: Array<{ url: string; model: string }> = [];
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const model = (await request.json()).model as string;
      sends.push({ url: request.url, model });
      return Response.json({ id: "resp_pool_reserve", object: "response", status: "completed", created_at: 1,
        model, output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
    }, { preconnect() {} }));
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai/gpt-6-luna", input: "ping", stream: false }),
      }), cfg, { model: "", provider: "" }, undefined, { kind: "configured", keyId: "luna-only", source: "bearer" });
      await response.text();
      expect(response.status).toBe(200);
      expect(sends).toEqual([{ url: `${CODEX_RESPONSES_HTTP_URL}/compact`, model: "gpt-reserve" }]);
    } finally { release(); }
  });
});

describe("request-local native Luna capacity intent", () => {
  const strict = { modelId: "gpt-6-luna", poolCapacityIntent: "reserve-only" } as const;
  const resolve = (cfg: OcxConfig, extra: Partial<Parameters<typeof resolveCodexAuthContext>[3]> = {}) =>
    resolveCodexAuthContext(new Headers(), cfg, "pool", { ...strict, ...extra });
  test("reserve-only refuses with a typed error when no seat can serve Reserve, where no intent still serves ordinary Luna", async () => {
    ordinary(A, 40); noReserve(B);
    await expect(resolve(config())).rejects.toBeInstanceOf(CodexReserveUnavailableError);
    await expect(resolve(config())).rejects.toThrow("nothing was sent");
    const unchanged = await build();
    expect(unchanged.ctx.accountId).toBe(A);
    expect(JSON.parse(unchanged.request.body).model).toBe("gpt-6-luna");
  });
  test("a refused trial leaves reserve-only refusing while ordinary Luna keeps serving", async () => {
    ordinary(A, 40);
    const cfg = config();
    const trial = await resolve(cfg);
    expect(trial.kind === "pool" && trial.accountId === B && trial.poolReserve === true).toBe(true);
    recordCodexUpstreamOutcome(cfg, B, 429, { ...codexFailureWindowOutcomeMeta(trial), modelId: "gpt-6-luna", now, retryAfter: "3600" });
    await expect(resolve(cfg)).rejects.toBeInstanceOf(CodexReserveUnavailableError);
    expect((await build(cfg)).ctx.accountId).toBe(A);
  });
  test("the bounded alternate selects only a verified Reserve seat, never ordinary Luna or a discovery trial", async () => {
    const cfg = config();
    const third = "pool-reserve-c";
    cfg.codexAccounts!.push({ id: third, email: "c@example.test", isMain: false, plan: "pro" });
    saveCodexAccountCredential(third, { accessToken: "access-c", refreshToken: "refresh-c",
      chatgptAccountId: `fixture-workspace-${third}`, expiresAt: now + 86_400_000 });
    ordinary(third, 40);
    // B is depleted with no reported grant: unverified, and the alternate may not explore it.
    await expect(resolve(cfg, { excludeAccountId: A, verifiedPoolReserveOnly: true })).rejects.toBeInstanceOf(CodexReserveUnavailableError);
    reserve(B);
    const moved = await resolve(cfg, { excludeAccountId: A, verifiedPoolReserveOnly: true });
    expect(moved.kind === "pool" && moved.accountId === B && moved.poolReserve === true).toBe(true);
  });
  test("a grant lost between selection and send fails closed instead of spending ordinary Luna", async () => {
    reserve(); noReserve(A);
    const cfg = config();
    const ctx = await resolve(cfg);
    const guard = createCodexAuthDispatchGuard(ctx, cfg, "gpt-6-luna")!;
    setAccountQuotaFromParsed(B, { customWindows: [] });
    expect(() => guard(new Headers())).toThrow(CodexAccountCooldownError);
  });
  test("ordinary-only never takes Reserve even when a verified grant exists", async () => {
    reserve(); ordinary(A, 40);
    const ctx = await resolve(config(), { poolCapacityIntent: "ordinary-only" });
    expect(ctx.kind === "pool" && ctx.accountId === A && ctx.poolReserve !== true).toBe(true);
  });
  test("a caller-owned main credential cannot stand in for the strict Reserve leg", async () => {
    ordinary(A, 40); noReserve(B);
    const cfg = config(); cfg.pausedCodexAccountIds = [A, B];
    const headers = new Headers({ authorization: "Bearer caller-owned-main", "chatgpt-account-id": "caller-workspace" });
    const callerOwned = { modelId: "gpt-6-luna", requestScopedMainCredential: true } as const;
    const resolved = await resolveCodexAuthContext(headers, cfg, "pool", callerOwned);
    expect(resolved.kind).toBe("main");
    await expect(resolveCodexAuthContext(headers, cfg, "pool", { ...callerOwned, poolCapacityIntent: "reserve-only" }))
      .rejects.toBeInstanceOf(CodexReserveUnavailableError);
  });
  test("over HTTP a reserve-only leg with no eligible Reserve seat reaches no upstream", async () => {
    ordinary(A, 40); noReserve(B);
    const cfg = config(); cfg.providers.openai = { ...base, codexAccountMode: "pool" };
    const fetched = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({}), { preconnect() {} }));
    const release = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-6-luna", input: "ping", stream: false }) }), cfg,
      { model: "", provider: "" }, { poolCapacityIntent: "reserve-only" });
      expect(response.status).toBe(429);
      expect((await response.json()).error.message).toContain("nothing was sent");
      expect(fetched).not.toHaveBeenCalled();
    } finally { release(); }
  });
  test("a Reserve discovery lease handed back before any send leaves the seat probeable, but a dispatched one keeps its probe interval", () => {
    const t = now;
    // A seat with no recorded probe goes back to having none.
    const first = tryAcquireCodexQuotaScopeProbeLease(A, "reserve", t, true)!;
    expect(first).toBeTruthy();
    expect(canTryUnknownCodexReserve(A, t)).toBe(false);
    releaseCodexQuotaScopeProbeLease(A, "reserve", first, t + 1);
    expect(canTryUnknownCodexReserve(A, t + 2)).toBe(true);
    // A seat whose last real probe is old keeps that stamp rather than the acquire time.
    const lastProbeAt = t - 2 * CODEX_QUOTA_PROBE_INTERVAL_MS;
    setScopedHealth(B, "reserve", { consecutiveFailures: 0, lastProbeAt });
    const second = tryAcquireCodexQuotaScopeProbeLease(B, "reserve", t, true)!;
    expect(scopedHealthFor(B, "reserve")?.lastProbeAt).toBe(t);
    releaseCodexQuotaScopeProbeLease(B, "reserve", second, t + 1);
    expect(scopedHealthFor(B, "reserve")?.lastProbeAt).toBe(lastProbeAt);
    expect(scopedHealthFor(B, "reserve")?.probeLeaseId).toBeUndefined();
    expect(canTryUnknownCodexReserve(B, t + 2)).toBe(true);
    // Once the request is dispatched, handing the lease back records the probe that ran.
    const third = tryAcquireCodexQuotaScopeProbeLease(B, "reserve", t + 3, true)!;
    markCodexQuotaProbeLeaseDispatched(B, "reserve", third);
    releaseCodexQuotaScopeProbeLease(B, "reserve", third, t + 4);
    expect(scopedHealthFor(B, "reserve")?.lastProbeAt).toBe(t + 4);
    expect(canTryUnknownCodexReserve(B, t + 5)).toBe(false);
  });
  describe("a Reserve trial vetoed at the physical send", () => {
    const send = async (admit: () => void) => {
      ordinary(A, 40);
      const cfg = config();
      const ctx = await resolveCodexAuthContext(new Headers(), cfg, "pool", { modelId: "gpt-6-luna", poolCapacityIntent: "reserve-only" });
      expect(ctx.kind === "pool" && ctx.accountId === B && ctx.poolReserve === true).toBe(true);
      const upstream = mock(async () => Response.json({}));
      const dispatch = providerFetch({ ...base, fetch: upstream as unknown as typeof fetch }, undefined, {
        httpOnly: true, providerName: "openai", modelId: "gpt-6-luna",
        onPhysicalDispatch: admit,
        beforeDispatch: createCodexAuthDispatchGuard(ctx, cfg, "gpt-6-luna"),
      });
      const outcome = await dispatch("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" }).then(() => "sent", () => "refused");
      releaseCodexAuthContextProbeLease(ctx);
      return { outcome, upstream };
    };
    test("leaves the seat probeable when admission refuses after the guard passed", async () => {
      const { outcome, upstream } = await send(() => { throw new Error("Reserve seat dispatch was not admitted"); });
      expect(outcome).toBe("refused");
      expect(upstream).not.toHaveBeenCalled();
      expect(canTryUnknownCodexReserve(B, now + 1)).toBe(true);
    });
    test("keeps the probe interval once the send is admitted", async () => {
      const { outcome, upstream } = await send(() => {});
      expect(outcome).toBe("sent");
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(canTryUnknownCodexReserve(B, now + 1)).toBe(false);
    });
  });
});

// A seat whose included usage is spent keeps refusing Reserve until its plan window resets, so each
// refused probe episode doubles the wait toward six hours instead of re-asking every five minutes.
describe("sustained Reserve refusal backoff", () => {
  const MIN = 60_000;
  const refuse = (cfg: OcxConfig, id: string) => {
    const lease = tryAcquireCodexQuotaScopeProbeLease(id, "reserve", now, true);
    if (!lease) throw new Error("expected a Reserve discovery lease");
    recordCodexUpstreamOutcome(cfg, id, 429, { modelId: "gpt-reserve", poolReserve: true, now, probeQuotaScope: "reserve", probeLeaseId: lease });
  };
  /** Milliseconds until the seat may be asked for Reserve again, found by bisecting the public gate. */
  const dueAfterMs = (id: string) => {
    let lo = 0;
    let hi = 7 * 60 * MIN;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (canTryUnknownCodexReserve(id, now + mid)) hi = mid; else lo = mid;
    }
    return hi;
  };

  test("consecutive refused probe episodes back off to six hours and desynchronize seats", () => {
    const cfg = config();
    const expected = [5, 15, 30, 60, 120, 360, 360].map(minutes => minutes * MIN);
    const dues: Record<string, number[]> = { [A]: [], [B]: [] };
    for (const base of expected) {
      for (const id of [A, B]) refuse(cfg, id);
      for (const id of [A, B]) {
        const due = dueAfterMs(id);
        expect(due).toBeGreaterThanOrEqual(base);
        expect(due).toBeLessThanOrEqual(Math.round(base * 1.15));
        dues[id]!.push(due);
      }
      now += Math.max(dues[A]!.at(-1)!, dues[B]!.at(-1)!);
    }
    expect(dues[A]![0]).toBe(5 * MIN);
    expect(dues[B]![0]).toBe(5 * MIN);
    expect(dues[A]!.slice(1).some((due, index) => due !== dues[B]![index + 1])).toBe(true);
  });

  test("concurrent refusals inside one episode do not advance the backoff", () => {
    const cfg = config();
    for (let i = 0; i < 3; i++) {
      recordCodexUpstreamOutcome(cfg, B, 429, { modelId: "gpt-reserve", poolReserve: true, now });
      now += 1_000;
    }
    expect(scopedHealthFor(B, "reserve")?.consecutiveFailures).toBe(1);
    // The last sibling stamped the probe clock one second before `now`; the wait is still the five-minute episode-1 wait.
    expect(dueAfterMs(B)).toBe(5 * MIN - 1_000);
  });

  test("a multi-hour Reserve hold is restored after a restart", () => {
    const cfg = config();
    for (let i = 0; i < 3; i++) { refuse(cfg, B); now += 2 * 60 * MIN; }
    refuse(cfg, B);
    now += 40 * MIN;
    expect(flushCodexHealthCooldowns()).toBe(true);
    reloadCodexHealthCooldownsForTests();
    expect(scopedHealthFor(B, "reserve")?.consecutiveFailures).toBe(4);
    expect(canTryUnknownCodexReserve(B, now)).toBe(false);
    now += 30 * MIN;
    expect(canTryUnknownCodexReserve(B, now)).toBe(true);
  });

  test("a served Reserve turn returns the seat to the five-minute probe interval", async () => {
    ordinary(A, 40);
    const cfg = config();
    for (let i = 0; i < 3; i++) { refuse(cfg, B); now += 60 * MIN; }
    expect(scopedHealthFor(B, "reserve")?.consecutiveFailures).toBe(3);
    const probe = await build(cfg);
    if (probe.ctx.kind !== "pool" || !probe.ctx.probeLeaseId) throw new Error("expected a discovery lease");
    expect(probe.ctx.accountId).toBe(B);
    recordCodexUpstreamOutcome(cfg, B, 200, { ...codexFailureWindowOutcomeMeta(probe.ctx), reserveServed: true,
      probeQuotaScope: "reserve", probeLeaseId: probe.ctx.probeLeaseId });
    expect(scopedHealthFor(B, "reserve")?.consecutiveFailures).toBe(0);
    recordCodexUpstreamOutcome(cfg, B, 429, { modelId: "gpt-reserve", poolReserve: true, now });
    expect(canTryUnknownCodexReserve(B, now + 5 * MIN + 1)).toBe(true);
  });

  test("a new ordinary quota cycle ends the old Reserve backoff", async () => {
    ordinary(A, 40);
    const cfg = config();
    for (let i = 0; i < 3; i++) { refuse(cfg, B); now += 20 * MIN; }
    expect(scopedHealthFor(B, "reserve")?.consecutiveFailures).toBe(3);
    now += MIN;
    updateAccountQuota(B, 14, now + 7 * 86_400_000);
    expect((await build(cfg)).ctx.accountId).toBe(A);
    expect(scopedHealthFor(B, "reserve")).toBeUndefined();
    now += MIN;
    updateAccountQuota(B, 100, now + 86_400_000);
    const next = await build(cfg);
    expect(next.ctx.accountId).toBe(B);
    expect(JSON.parse(next.request.body).model).toBe("gpt-reserve");
  });

  test("an operator clear ends a multi-hour Reserve wait after its cooldown lapsed", () => {
    const cfg = config();
    for (let i = 0; i < 3; i++) { refuse(cfg, B); now += 2 * 60 * MIN; }
    refuse(cfg, B);
    now += 40 * MIN;
    expect(canTryUnknownCodexReserve(B, now)).toBe(false);
    expect(clearCodexAccountCooldown(B, now)).toBe(true);
    expect(scopedHealthFor(B, "reserve")?.consecutiveFailures ?? 0).toBe(0);
    expect(canTryUnknownCodexReserve(B, now)).toBe(true);
  });

  test("a replaced credential ends the old Reserve backoff", async () => {
    ordinary(A, 40);
    const cfg = config();
    for (let i = 0; i < 3; i++) { refuse(cfg, B); now += 20 * MIN; }
    expect(scopedHealthFor(B, "reserve")?.consecutiveFailures).toBe(3);
    now += MIN;
    saveCodexAccountCredential(B, { accessToken: "fixture-access-replaced", refreshToken: "fixture-refresh-replaced",
      chatgptAccountId: `fixture-workspace-${B}`, expiresAt: now + 86_400_000 });
    const next = await build(cfg);
    expect(next.ctx.accountId).toBe(B);
    expect(JSON.parse(next.request.body).model).toBe("gpt-reserve");
  });

  test("an incomplete Reserve terminal restarts the backoff instead of repeating it", async () => {
    ordinary(A, 40);
    const cfg = config();
    for (let i = 0; i < 3; i++) { refuse(cfg, B); now += 60 * MIN; }
    const probe = await build(cfg);
    if (probe.ctx.kind !== "pool" || !probe.ctx.probeLeaseId) throw new Error("expected a discovery lease");
    expect(probe.ctx.accountId).toBe(B);
    recordCodexUpstreamOutcome(cfg, B, 200, { ...codexFailureWindowOutcomeMeta(probe.ctx),
      probeQuotaScope: "reserve", probeLeaseId: probe.ctx.probeLeaseId });
    expect(scopedHealthFor(B, "reserve")?.consecutiveFailures).toBe(0);
    expect(scopedHealthFor(B, "reserve")?.reserveSuccess).toBeUndefined();
    now += 5 * MIN;
    refuse(cfg, B);
    expect(scopedHealthFor(B, "reserve")?.consecutiveFailures).toBe(1);
  });
});
