import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexQuotaHealthSnapshot, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { bindThreadAffinity, deleteThreadAffinity, getThreadAffinity } from "../../src/codex/routing/thread-affinity";
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
  test("a pinned depleted seat with no Reserve window serves Luna from its own Reserve (case e)", async () => {
    const { ctx, request } = await buildPinned(A);
    expect(ctx.accountId).toBe(A);
    expect(JSON.parse(request.body).model).toBe("gpt-reserve");
  });
  test("a pin to a seat with included quota keeps ordinary Luna and never borrows a depleted seat's Reserve (case e)", async () => {
    ordinary(A, 40);
    const { ctx, request } = await buildPinned(A);
    expect(ctx.accountId).toBe(A);
    expect(JSON.parse(request.body).model).toBe("gpt-6-luna");
  });
});

describe("automatic Luna Reserve selection and shared HTTP/WebSocket wire model", () => {
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
  test("a retry that excludes the refused seat moves to the next depleted seat's Reserve before included Luna", () => {
    const cfg = config();
    const third = "pool-reserve-c";
    cfg.codexAccounts!.push({ id: third, email: "c@example.test", isMain: false, plan: "pro" });
    ordinary(third);
    const retry = poolLunaReserveSelection(cfg, "gpt-6-luna", "shared", {}, A, undefined, now);
    expect(retry.reserve).toBe(true);
    expect([...retry.options.modelEligibleAccountIds!].sort()).toEqual([B, third].sort());
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
  test("a retracted grant leaves the seat unreported, so the dispatch guard still lets Reserve through", async () => {
    reserve(); noReserve(A);
    const { ctx, headers } = await build();
    const guard = createCodexAuthDispatchGuard(ctx, config(), "gpt-6-luna")!;
    setAccountQuotaFromParsed(B, { customWindows: [] });
    expect(() => guard(headers)).not.toThrow();
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
});
