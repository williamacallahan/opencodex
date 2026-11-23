import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAnthropicAccountPoolState } from "../../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential, setAccountPaused, setActiveAccount } from "../../src/oauth/store";
import { clearAccountQuotaCache, clearProviderQuotaCache, fetchProviderQuotaReports, flushProviderQuotaObservationsForTests, setCachedProviderAccountQuotaForTests, setProviderQuotaBeforePublishForTests } from "../../src/providers/quota";
import type { QuotaResetEvent } from "../../src/quota/reset-detector";
import { setQuotaResetSink } from "../../src/quota/reset-observer";
import { resetQuotaResetNotifyCacheForTests } from "../../src/quota/reset-notify-config";
import { resetQuotaResetStoreForTests } from "../../src/quota/reset-seen-store";
import { fetchAnthropicQuota } from "../../src/providers/quota/vendor-probes-oauth";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;
let ids: string[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-pool-capacity-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache();
  for (let i = 0; i < 3; i++) await saveCredential("anthropic", {
    access: `synthetic-access-${i}`, refresh: `synthetic-refresh-${i}`,
    expires: Date.now() + 3_600_000, accountId: `pool-capacity-${i}`, source: "oauth",
  });
  ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
  // The active account's live usage probe: 40% of 5h, 20% of the week.
  globalThis.fetch = (async input => {
    expect(String(input)).toBe("https://api.anthropic.com/api/oauth/usage");
    return Response.json({
      five_hour: { utilization: 40, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAnthropicAccountPoolState(); clearPoolRotationState(); clearAccountQuotaCache(); clearProviderQuotaCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function config(poolEnabled: boolean): OcxConfig {
  return {
    port: 0,
    defaultProvider: "anthropic",
    providers: { anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } },
    anthropicAccountPool: { enabled: poolEnabled },
  };
}

test("an enabled Anthropic account pool reports the pool-wide capacity estimate like the Codex pool", async () => {
  const [, b, c] = ids as [string, string, string];
  const now = Date.now();
  setCachedProviderAccountQuotaForTests("anthropic", b, {
    fiveHourPercent: 100, fiveHourResetAt: now + 1_800_000, weeklyPercent: 60, weeklyResetAt: now + 172_800_000, updatedAt: now,
  });
  setCachedProviderAccountQuotaForTests("anthropic", c, {
    fiveHourPercent: 10, weeklyPercent: 0, updatedAt: now,
  });

  const result = await fetchAnthropicQuota("anthropic", config(true));

  expect(result?.source).toBe("anthropic:oauth-usage");
  // Equal weights: (40 + 100 + 10) / 3 and (20 + 60 + 0) / 3.
  expect(result?.quota.fiveHourPercent).toBeCloseTo(50, 5);
  expect(result?.quota.weeklyPercent).toBeCloseTo(80 / 3, 5);
  expect(result?.aggregation).toMatchObject({
    kind: "capacity-weighted-v1",
    presentation: "aggregate",
    includedAccounts: 3,
    excludedAccounts: 0,
    unknownPlanAccounts: 0,
    incomplete: false,
    currentAccount: { quota: { fiveHourPercent: 40, weeklyPercent: 20 } },
  });
  // The next 5-hour recovery is account b's reset, returning its full share of the pool.
  expect(result?.aggregation?.fiveHour?.nextRecoveryAt).toBe(now + 1_800_000);
  expect(result?.aggregation?.fiveHour?.nextRecoveryPercent).toBeCloseTo(100 / 3, 5);
});

test("stale-while-revalidate returns cached report immediately while deduplicating one background refresh", async () => {
  const realDateNow = Date.now;
  let nowOffset = 0;
  let releaseRefresh: ((response: Response) => void) | undefined;
  Date.now = () => realDateNow() + nowOffset;
  try {
    let calls = 0;
    let refreshPending = new Promise<Response>(resolve => { releaseRefresh = resolve; });
    const resetAt = new Date(Date.now() + 86_400_000).toISOString();
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ five_hour: { utilization: 25, resets_at: resetAt } });
      }
      return await refreshPending;
    }) as typeof fetch;

    const cfg = config(false);
    const initial = await fetchProviderQuotaReports(cfg, false, { staleWhileRevalidate: true });
    expect(calls).toBe(1);
    expect(initial.reports.find(r => r.provider === "anthropic")?.quota.fiveHourPercent).toBe(25);

    // Advance past CACHE_TTL_MS (60s) and ACCOUNT_QUOTA_TTL_MS (10m) while staying inside LAST_GOOD_MAX_AGE_MS (30m).
    nowOffset = 11 * 60_000;
    const swrFirst = await fetchProviderQuotaReports(cfg, false, { staleWhileRevalidate: true });
    const swrSecond = await fetchProviderQuotaReports(cfg, false, { staleWhileRevalidate: true });
    expect(swrFirst.reports.find(r => r.provider === "anthropic")?.quota.fiveHourPercent).toBe(25);
    expect(swrSecond.reports.find(r => r.provider === "anthropic")?.quota.fiveHourPercent).toBe(25);
    await new Promise(resolve => setTimeout(resolve, 10));
    // Only one singleflight background probe starts even across repeated stale reads.
    expect(calls).toBe(2);

    releaseRefresh?.(Response.json({ five_hour: { utilization: 65, resets_at: resetAt } }));
    releaseRefresh = undefined;
    await new Promise(resolve => setTimeout(resolve, 20));

    const updated = await fetchProviderQuotaReports(cfg, false, { staleWhileRevalidate: true });
    expect(updated.reports.find(r => r.provider === "anthropic")?.quota.fiveHourPercent).toBe(65);
    expect(calls).toBe(2);

    // `?refresh=1` (`forceRefresh: true`) still waits for the live probe instead of serving stale.
    nowOffset = 11 * 60_000 + 5_000;
    refreshPending = new Promise<Response>(resolve => { releaseRefresh = resolve; });
    const forcedPromise = fetchProviderQuotaReports(cfg, true, { staleWhileRevalidate: false });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls).toBe(3);
    releaseRefresh?.(Response.json({ five_hour: { utilization: 80, resets_at: resetAt } }));
    releaseRefresh = undefined;
    const forced = await forcedPromise;
    expect(forced.reports.find(r => r.provider === "anthropic")?.quota.fiveHourPercent).toBe(80);
  } finally {
    releaseRefresh?.(Response.json({}));
    await new Promise(resolve => setTimeout(resolve, 10));
    Date.now = realDateNow;
  }
});

test("a cold pool waits for its inactive accounts instead of publishing an active-only estimate", async () => {
  const utilization = new Map(getAccountSet("anthropic")!.accounts.map((row, index) => [
    `Bearer ${row.credential.access}`, [90, 0, 30][index],
  ]));
  globalThis.fetch = (async (_input, init) => Response.json({
    five_hour: { utilization: utilization.get(new Headers(init?.headers).get("Authorization") ?? "") },
  })) as typeof fetch;

  const result = (await fetchProviderQuotaReports(config(true))).reports.find(row => row.provider === "anthropic");

  expect(result?.quota.fiveHourPercent).toBe(40);
  expect(result?.aggregation).toMatchObject({ includedAccounts: 3, excludedAccounts: 0, incomplete: false });
});

test("a new observation of the same quota does not remove the pool report during publication", async () => {
  const [, sibling] = ids as [string, string];
  const quota = { fiveHourPercent: 20, weeklyPercent: 35, updatedAt: Date.now() - 100 };
  setCachedProviderAccountQuotaForTests("anthropic", sibling, quota);
  setProviderQuotaBeforePublishForTests(() => {
    setCachedProviderAccountQuotaForTests("anthropic", sibling, { ...quota, updatedAt: Date.now() });
  });
  try {
    const row = (await fetchProviderQuotaReports(config(true))).reports.find(report => report.provider === "anthropic");
    expect(row?.quota.fiveHourPercent).toBeCloseTo(100 / 3);
    expect(row?.aggregation?.includedAccounts).toBe(3);
  } finally {
    setProviderQuotaBeforePublishForTests(null);
  }
});

test("a changed account reading during report collection updates the pool instead of dropping it", async () => {
  const [, sibling] = ids as [string, string];
  setCachedProviderAccountQuotaForTests("anthropic", sibling, { fiveHourPercent: 20, updatedAt: Date.now() });
  setProviderQuotaBeforePublishForTests(() => {
    setCachedProviderAccountQuotaForTests("anthropic", sibling, { fiveHourPercent: 70, updatedAt: Date.now() });
  });
  try {
    const row = (await fetchProviderQuotaReports(config(true))).reports.find(report => report.provider === "anthropic");
    expect(row?.quota.fiveHourPercent).toBeCloseTo(50);
    expect(row?.aggregation?.includedAccounts).toBe(3);
  } finally {
    setProviderQuotaBeforePublishForTests(null);
  }
});

test("a recently checked seat is refreshed when its five-hour window rolls over", async () => {
  const [, b, c] = ids as [string, string, string];
  const now = Date.now();
  setCachedProviderAccountQuotaForTests("anthropic", b, {
    fiveHourPercent: 80, fiveHourResetAt: now - 1, weeklyPercent: 20, updatedAt: now - 100,
  });
  setCachedProviderAccountQuotaForTests("anthropic", c, { fiveHourPercent: 40, weeklyPercent: 20, updatedAt: now });

  const row = (await fetchProviderQuotaReports(config(true))).reports.find(report => report.provider === "anthropic");
  expect(row?.quota.fiveHourPercent).toBeCloseTo(40);
  expect(row?.aggregation?.fiveHour).toMatchObject({ includedAccounts: 3, incomplete: false });
});

test("a paused pool account is excluded from the estimate and reported as incomplete coverage", async () => {
  const [, b, c] = ids as [string, string, string];
  const now = Date.now();
  setCachedProviderAccountQuotaForTests("anthropic", b, { fiveHourPercent: 100, weeklyPercent: 100, updatedAt: now });
  setCachedProviderAccountQuotaForTests("anthropic", c, { fiveHourPercent: 0, weeklyPercent: 0, updatedAt: now });
  await setAccountPaused("anthropic", b, true);

  const result = await fetchAnthropicQuota("anthropic", config(true));

  expect(result?.quota.fiveHourPercent).toBeCloseTo(20, 5);
  expect(result?.aggregation).toMatchObject({ includedAccounts: 2, excludedAccounts: 1, pausedAccounts: 1, incomplete: true });
});

test("with the account pool off the report stays the active account's own reading", async () => {
  const [, b] = ids as [string, string, string];
  setCachedProviderAccountQuotaForTests("anthropic", b, { fiveHourPercent: 100, weeklyPercent: 100, updatedAt: Date.now() });

  const result = await fetchAnthropicQuota("anthropic", config(false));

  expect(result?.quota.fiveHourPercent).toBe(40);
  expect(result?.quota.weeklyPercent).toBe(20);
  expect(result?.aggregation).toBeUndefined();
});

test("pausing an inactive pool account retires the cached pooled report", async () => {
  const [, b, c] = ids as [string, string, string];
  const now = Date.now();
  setCachedProviderAccountQuotaForTests("anthropic", b, { fiveHourPercent: 100, weeklyPercent: 100, updatedAt: now });
  setCachedProviderAccountQuotaForTests("anthropic", c, { fiveHourPercent: 10, weeklyPercent: 0, updatedAt: now });
  const cfg = config(true);

  const first = (await fetchProviderQuotaReports(cfg)).reports.find(item => item.provider === "anthropic");
  expect(first?.aggregation).toMatchObject({ includedAccounts: 3, pausedAccounts: 0 });
  // The active account stays the same, but the paused seat must no longer contribute.
  await setAccountPaused("anthropic", b, true);

  const second = (await fetchProviderQuotaReports(cfg)).reports.find(item => item.provider === "anthropic");
  expect(second?.quota.fiveHourPercent).toBe(25);
  expect(second?.aggregation).toMatchObject({ includedAccounts: 2, pausedAccounts: 1, incomplete: true });
});

test("a pool without an active reading still reports measured siblings and never substitutes one for the active account", async () => {
  const [active, sibling] = getAccountSet("anthropic")!.accounts;
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get("authorization");
    return bearer === `Bearer ${sibling!.credential.access}`
      ? Response.json({ five_hour: { utilization: 55 } }) : new Response(null, { status: 503 });
  }, { preconnect: originalFetch.preconnect });
  const cfg = config(true);
  const first = (await fetchProviderQuotaReports(cfg)).reports.find(row => row.provider === "anthropic");
  expect(first?.quota.fiveHourPercent).toBeCloseTo(55);
  expect(first?.aggregation).toMatchObject({ includedAccounts: 1, excludedAccounts: 2, incomplete: true, currentAccount: { quota: null } });

  setCachedProviderAccountQuotaForTests("anthropic", active!.id, { fiveHourPercent: 5, updatedAt: Date.now() });
  const next = (await fetchProviderQuotaReports(cfg)).reports.find(row => row.provider === "anthropic");
  expect(next?.quota.fiveHourPercent).toBeCloseTo(30);
  expect(next?.aggregation?.currentAccount?.quota?.fiveHourPercent).toBe(5);
});

test("an enabled pool holding one account reports that account's own reading", async () => {
  const [, b, c] = ids as [string, string, string];
  const { removeAccount } = await import("../../src/oauth/store");
  await removeAccount("anthropic", b);
  await removeAccount("anthropic", c);

  const result = await fetchAnthropicQuota("anthropic", config(true));

  expect(result?.quota.fiveHourPercent).toBe(40);
  expect(result?.aggregation).toBeUndefined();
});

describe("quota reset detection observes the active seat, not the pooled estimate", () => {
  let captured: QuotaResetEvent[] = [];
  let usage = { five: 90, fiveReset: 0, week: 20, weekReset: 0 };
  beforeEach(async () => {
    await flushProviderQuotaObservationsForTests();
    resetQuotaResetStoreForTests();
    resetQuotaResetNotifyCacheForTests();
    captured = [];
    setQuotaResetSink(event => { captured.push(event); });
    const now = Date.now();
    usage = { five: 90, fiveReset: now + 3_600_000, week: 20, weekReset: now + 86_400_000 };
    globalThis.fetch = (async () => Response.json({
      five_hour: { utilization: usage.five, resets_at: new Date(usage.fiveReset).toISOString() },
      seven_day: { utilization: usage.week, resets_at: new Date(usage.weekReset).toISOString() },
    })) as typeof fetch;
    const [, b, c] = ids as [string, string, string];
    setCachedProviderAccountQuotaForTests("anthropic", b, { fiveHourPercent: 0, weeklyPercent: 0, updatedAt: now });
    setCachedProviderAccountQuotaForTests("anthropic", c, { fiveHourPercent: 0, weeklyPercent: 0, updatedAt: now });
  });
  afterEach(async () => {
    await flushProviderQuotaObservationsForTests();
    setQuotaResetSink(null);
  });

  test("a pool user still gets the active seat's scheduled 5-hour reset", async () => {
    usage.fiveReset = Date.now() + 50;
    await fetchProviderQuotaReports(config(true), true);
    await flushProviderQuotaObservationsForTests();
    await new Promise(resolve => setTimeout(resolve, 120));
    usage = { ...usage, five: 5, fiveReset: Date.now() + 18_000_000 };
    await fetchProviderQuotaReports(config(true), true);
    await flushProviderQuotaObservationsForTests();
    expect(captured).toEqual([expect.objectContaining({ kind: "scheduled", window: "5h", percentBefore: 90, percentAfter: 5 })]);
  });

  test("turning the pool on mid-window raises no reset", async () => {
    await fetchProviderQuotaReports(config(false), true);
    await flushProviderQuotaObservationsForTests();
    const pooled = (await fetchProviderQuotaReports(config(true), true)).reports.find(item => item.provider === "anthropic");
    await flushProviderQuotaObservationsForTests();
    expect(pooled?.aggregation).toBeDefined();
    expect(captured).toEqual([]);
  });
});

test("setup-token pool accounts survive idle age and restart hydration with observed capacity", async () => {
  const { removeAccount, saveCredential: saveOAuthCredential } = await import("../../src/oauth/store");
  const {
    getCachedProviderAccountQuota,
    recordAnthropicAccountQuotaFromHeaders,
    sweepExpiredProviderAccountQuotaRows,
  } = await import("../../src/providers/quota/account-cache");
  const { settleAccountQuotaPersistForTests } = await import("../../src/providers/account-quota-disk");
  const { freshQuotaReportsFromResponse } = await import("../../gui/src/provider-workspace/report");
  for (const id of ids) await removeAccount("anthropic", id);
  await saveOAuthCredential("anthropic", { access: "setup-a", refresh: "", expires: Date.now() + 86_400_000, accountId: "setup-a", source: "oauth" });
  await saveOAuthCredential("anthropic", { access: "setup-b", refresh: "", expires: Date.now() + 86_400_000, accountId: "setup-b", source: "oauth" });
  const setupIds = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", setupIds[0]!);

  const now = Date.now();
  const realNow = Date.now;
  let clock = now - 2 * 60 * 60_000;
  Date.now = () => clock;
  try {
    const resetSec = String(Math.floor((now + 5 * 86_400_000) / 1000));
    recordAnthropicAccountQuotaFromHeaders(setupIds[0]!, new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.25",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor((clock + 60_000) / 1000)),
      "anthropic-ratelimit-unified-7d-utilization": "0.6",
      "anthropic-ratelimit-unified-7d-reset": resetSec,
    }), 0);
    recordAnthropicAccountQuotaFromHeaders(setupIds[1]!, new Headers({
      "anthropic-ratelimit-unified-7d-utilization": "0.2",
      "anthropic-ratelimit-unified-7d-reset": resetSec,
    }), 0);
    await new Promise(resolve => setTimeout(resolve, 350));
    await settleAccountQuotaPersistForTests();

    clock = now;
    expect(sweepExpiredProviderAccountQuotaRows(now)).toBe(0);
    clearAccountQuotaCache();
    expect(getCachedProviderAccountQuota("anthropic", setupIds[0]!)?.weeklyPercent).toBe(60);
    expect(getCachedProviderAccountQuota("anthropic", setupIds[0]!)?.fiveHourPercent).toBeUndefined();
    expect(getCachedProviderAccountQuota("anthropic", setupIds[1]!)?.weeklyPercent).toBe(20);

    const report = await fetchAnthropicQuota("anthropic", config(true));
    expect(report?.observed).toBe(true);
    expect(report?.quota.weeklyPercent).toBeCloseTo(40, 5);
    expect(report?.aggregation).toMatchObject({
      includedAccounts: 2,
      staleQuotaAccounts: 0,
      currentAccount: { quota: { weeklyPercent: 60 } },
    });
    const guiReports = freshQuotaReportsFromResponse([report], now);
    expect(guiReports.anthropic?.observed).toBe(true);
  } finally {
    Date.now = realNow;
  }
});
