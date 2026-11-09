import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { capturePoolQuotaWriter, saveCodexAccountCredential } from "../../src/codex/account-store";
import { fetchPoolAccountQuota } from "../../src/codex/auth-api/pool-quota-probe";
import { poolAccountDto } from "../../src/codex/auth-api/account-list";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { applyAccountQuotaFromUpstreamHeaders, clearAccountQuota, getAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { POOL_RESERVE_FRESHNESS_MS, poolLunaReserveSelection } from "../../src/codex/pool-reserve";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexQuotaHealthSnapshot, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { bindThreadAffinity } from "../../src/codex/routing/thread-affinity";
import { forgetCodexFailureWindows, isCodexFailureWindowDegraded, noteCodexFailureWindowSample } from "../../src/codex/routing/failure-window";
import { codexFailureWindowOutcomeMeta } from "../../src/codex/routing/failure-window";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import {
  resolveCodexAuthContext, applyCodexAuthContextToProvider, materializeCodexUpstreamAuth,
  createCodexAuthDispatchGuard, CodexPoolExhaustedError, CodexPoolAccountCreditsOffError, cooldownErrorResponse,
} from "../../src/codex/auth-context";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { prepareCodexWsRequest, CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { rebindPoolCreditPolicy } from "../../src/codex/pool-credit-policy";
import { handleResponses } from "../../src/server/responses/core";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

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
function usage(grant = true) {
  return { plan_type: "pro", rate_limit: { allowed: false, primary_window: {
    used_percent: 100, reset_at: Math.floor(now / 1000) + 86_400, limit_window_seconds: 604_800,
  } }, rate_limit_upsell: { banner_type: grant ? "luna_reserve" : "other" },
  additional_rate_limits: [{ limit_name: "gpt-reserve", rate_limit: { allowed: true, primary_window: {
    used_percent: 25, reset_at: Math.floor(now / 1000) + 604_800, limit_window_seconds: 604_800,
  } } }] };
}
async function build(cfg = config(), modelId = "gpt-6-luna") {
  const ctx = await resolveCodexAuthContext(new Headers(), cfg, "pool", { modelId });
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

describe("automatic Luna Reserve selection and shared HTTP/WebSocket wire model", () => {
  test("all ordinary-held seats use the fresh Reserve seat on HTTP and WebSocket", async () => {
    reserve();
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
  test("a thread bound to a seat with included quota keeps Luna there; one bound to a held seat uses Reserve", () => {
    reserve(); ordinary(A, 40);
    bindThreadAffinity("luna-on-included", A, now, "shared");
    bindThreadAffinity("luna-on-held", B, now, "shared");
    const kept = poolLunaReserveSelection(config(), "gpt-6-luna", "shared", {}, undefined, "luna-on-included", now);
    expect(kept.reserve).toBe(false); expect(kept.options.poolCapacity).toBe("included");
    const moved = poolLunaReserveSelection(config(), "gpt-6-luna", "shared", {}, undefined, "luna-on-held", now);
    expect(moved.reserve).toBe(true); expect(moved.quotaScope).toBe("reserve");
  });
  test("Reserve comes before a seat that already permits spending fresh credits", async () => {
    reserve(); const cfg = config(); cfg.creditCodexAccountIds = [A];
    setAccountQuotaFromParsed(A, { credits: { hasCredits: true, balance: 20, observedAt: now } });
    const { ctx, request } = await build(cfg);
    expect(ctx.accountId).toBe(B); expect(JSON.parse(request.body).model).toBe("gpt-reserve");
  });
  test("a bound seat that only new-thread steering avoids still keeps its Luna thread", () => {
    reserve(); ordinary(A, 40);
    bindThreadAffinity("luna-on-degraded", A, now, "shared");
    try {
      for (let sample = 0; sample < 20; sample++) noteCodexFailureWindowSample(config(), A, true, now);
      expect(isCodexFailureWindowDegraded(A, now)).toBe(true);
      const kept = poolLunaReserveSelection(config(), "gpt-6-luna", "shared", {}, undefined, "luna-on-degraded", now);
      expect(kept.reserve).toBe(false); expect(kept.options.poolCapacity).toBe("included");
    } finally { forgetCodexFailureWindows(); }
  });
  test("without Reserve anywhere, Luna selection options and scope are returned untouched", () => {
    ordinary(A); ordinary(B, 40);
    const options = { modelEligibleAccountIds: new Set([A, B]) };
    const result = poolLunaReserveSelection(config(), "gpt-6-luna", "shared", options, undefined, undefined, now);
    expect(result.reserve).toBe(false); expect(result.options).toBe(options); expect(result.quotaScope).toBe("shared");
  });
  test("without Reserve the existing consented-credit path still serves ordinary Luna", async () => {
    const cfg = config(); cfg.creditCodexAccountIds = [A];
    setAccountQuotaFromParsed(A, { credits: { hasCredits: true, balance: 20, observedAt: now } });
    const { ctx, request } = await build(cfg);
    expect(ctx.accountId).toBe(A); expect(JSON.parse(request.body).model).toBe("gpt-6-luna");
  });
  test.each(["stale", "full", "elapsed", "paused", "excluded"])("%s Reserve does not admit a held pool", async state => {
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
    reserve(); const cfg = config(); cfg.creditCodexAccountIds = [B];
    setAccountQuotaFromParsed(B, { credits: { hasCredits: true, balance: 20, observedAt: now } });
    const { ctx, headers } = await build(cfg);
    const guard = createCodexAuthDispatchGuard(ctx, cfg, "gpt-6-luna")!;
    setAccountQuotaFromParsed(B, { customWindows: [] });
    expect(() => guard(headers)).toThrow(CodexPoolAccountCreditsOffError);
  });
  test("ordinary header updates cannot refresh an old Reserve grant", async () => {
    reserve(); now += POOL_RESERVE_FRESHNESS_MS + 1; ordinary(B);
    await expect(build()).rejects.toBeInstanceOf(CodexPoolExhaustedError);
  });
  test("Reserve response quota and exhaustion do not replace or clear ordinary quota", async () => {
    reserve(); const cfg = config();
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
  for (const compact of [false, true]) test.each(["reserve", "reserve-before-included", "ordinary", "sol"])(`Responses${compact ? " compact" : ""} HTTP %s dispatches only the expected upstream model`, async state => {
    if (state !== "ordinary") reserve();
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
});
