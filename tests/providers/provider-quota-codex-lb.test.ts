import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** codex-lb pooled usage (`GET /v1/usage`) read through the provider's own key. */
import { clearProviderQuotaCache, fetchProviderQuotaReports, flushProviderQuotaObservationsForTests, providerApiKeyQuotaMode } from "../../src/providers/quota";
import { getCachedProviderRoutingQuota } from "../../src/providers/quota-routing-cache";
import { clearAccountQuota, flushQuotaObservationsForTests, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { setQuotaResetSink } from "../../src/quota/reset-observer";
import { resetQuotaResetStoreForTests } from "../../src/quota/reset-seen-store";
import type { QuotaResetEvent } from "../../src/quota/reset-detector";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { handleManagementAPI } from "../../src/server/management-api";
import { ManagementRequest } from "../helpers/management-auth";

const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome = "";

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-quota-codex-lb-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearProviderQuotaCache();
});

afterEach(() => {
  clearProviderQuotaCache();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
});

// The live hub's codex-lb answer, trimmed to the fields the reader consumes.
const LIVE_USAGE = {
  request_count: 4250692,
  total_tokens: 823530489269,
  cached_input_tokens: 755684417408,
  total_cost_usd: 522587.88,
  limits: [],
  upstream_limits: [{
    limit_type: "credits", limit_window: "7d", max_value: 504000, current_value: 455616,
    remaining_value: 48384, model_filter: null, reset_at: "2026-11-09T10:38:52Z", source: "aggregate",
  }],
  account_pool_usage: { primary: 62.5, secondary: 9.6 },
  purchased_credits: { balance: 52451.317714, unlimited: false, observed_at: "2026-11-09T03:07:43Z", is_partial: false },
  credit_estimate: null,
};

type Seen = { url: string; authorization: string | null };

function provider(baseUrl: string, body: unknown, seen: Seen[], status = 200): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    authMode: "key",
    baseUrl,
    apiKey: "lb-secret",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json(body, { status });
    }) as typeof fetch,
  } as OcxProviderConfig;
}

function config(name: string, providerConfig: OcxProviderConfig): OcxConfig {
  return { defaultProvider: name, providers: { [name]: providerConfig } } as OcxConfig;
}

describe("codex-lb pooled usage quota", () => {
  test("one rejected provider probe does not prevent other quota reports", async () => {
    const failing = provider("https://lb.example.com/backend-api/codex", LIVE_USAGE, []);
    failing.fetch = (async () => { throw new Error("fixture transport failure"); }) as typeof fetch;
    const healthy = provider("https://lb.example.com/backend-api/codex", LIVE_USAGE, []);
    const cfg = { defaultProvider: "healthy", providers: { failing, healthy } } as OcxConfig;
    const url = new URL("http://localhost/api/provider-quotas?refresh=1");
    const response = await handleManagementAPI(new ManagementRequest(url), url, cfg);
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.reports.map((row: { provider: string }) => row.provider)).toEqual(["healthy"]);
  });

  test("a relay on the Codex backend path reports pool windows and the credit balance", async () => {
    const seen: Seen[] = [];
    const poolProvider = provider("https://lb.example.com/backend-api/codex", LIVE_USAGE, seen);
    const result = await fetchProviderQuotaReports(config("my-pool", poolProvider), true);

    expect(seen).toEqual([{ url: "https://lb.example.com/v1/usage", authorization: "Bearer lb-secret" }]);
    expect(result.reports).toHaveLength(1);
    const report = result.reports[0]!;
    expect(report).toMatchObject({ provider: "my-pool", label: "my-pool", source: "codex-lb:usage" });
    // 7d comes from the upstream limit row (with its reset); 5h falls back to the pool summary.
    expect(report.quota.weeklyPercent).toBeCloseTo(90.4, 1);
    expect(report.quota.weeklyResetAt).toBe(Date.parse("2026-11-09T10:38:52Z"));
    expect(report.quota.fiveHourPercent).toBeCloseTo(37.5, 5);
    expect(report.quota.codexCredits).toEqual({ balance: "52451.317714", unlimited: false });
    // Display only: codex-lb spends credits past a full pool, so routing must not read it.
    expect(getCachedProviderRoutingQuota("my-pool", poolProvider, Date.now())).toBeNull();
  });

  test("pooled Luna Reserve shows as a display-only row, including when no seat offers it", async () => {
    let body: unknown = { ...LIVE_USAGE, luna_reserve: { seats: 2, remaining_percent: 30, reset_at: "2026-11-16T02:20:50Z" } };
    const poolProvider = provider("https://lb.example.com/backend-api/codex", undefined, []);
    poolProvider.fetch = (async () => Response.json(body)) as typeof fetch;
    const cfg = config("my-pool", poolProvider);

    const offered = (await fetchProviderQuotaReports(cfg, true)).reports[0]!.quota.customWindows;
    expect(offered).toEqual([{
      label: "Luna Reserve (2 seats)", percent: 70, resetAt: Date.parse("2026-11-16T02:20:50Z"), modelId: "gpt-reserve",
    }]);

    body = { ...LIVE_USAGE, luna_reserve: { seats: 0, remaining_percent: null, reset_at: null } };
    expect((await fetchProviderQuotaReports(cfg, true)).reports[0]!.quota.customWindows)
      .toEqual([{ label: "Luna Reserve: none offered", percent: 100, modelId: "gpt-reserve" }]);
    // A spent or absent Reserve never reads as provider exhaustion.
    expect(getCachedProviderRoutingQuota("my-pool", poolProvider, Date.now())).toBeNull();

    // An older relay that does not report Reserve shows no Reserve row at all.
    body = LIVE_USAGE;
    expect((await fetchProviderQuotaReports(cfg, true)).reports[0]!.quota.customWindows).toBeUndefined();
  });

  test("a credits-only refresh replaces held windows and clears partial credits", async () => {
    const seen: Seen[] = [];
    let body: unknown = LIVE_USAGE;
    const poolProvider = provider("https://lb.example.com/backend-api/codex", undefined, seen);
    poolProvider.fetch = (async () => Response.json(body)) as typeof fetch;
    const cfg = config("my-pool", poolProvider);
    expect((await fetchProviderQuotaReports(cfg, true)).reports[0]!.quota.weeklyPercent).toBeCloseTo(90.4, 1);

    body = { ...LIVE_USAGE, upstream_limits: [], account_pool_usage: null, purchased_credits: { balance: 12.5, unlimited: false } };
    const result = await fetchProviderQuotaReports(cfg, true);
    expect(result.reports).toHaveLength(1);
    const { quota } = result.reports[0]!;
    expect(quota.codexCredits).toEqual({ balance: "12.5", unlimited: false });
    expect([quota.fiveHourPercent, quota.weeklyPercent, quota.monthlyPercent]).toEqual([undefined, undefined, undefined]);

    // An unknown workspace can coexist with an unlimited flag, but neither is a complete pool balance.
    body = { ...LIVE_USAGE, upstream_limits: [], account_pool_usage: null,
      purchased_credits: { balance: 10, unlimited: true, is_partial: true } };
    expect((await fetchProviderQuotaReports(cfg, true)).reports).toEqual([]);
    expect((await fetchProviderQuotaReports(cfg)).reports).toEqual([]);

    body = { ...LIVE_USAGE, upstream_limits: [], account_pool_usage: null,
      purchased_credits: { balance: 12.5, unlimited: false, is_partial: false } };
    expect((await fetchProviderQuotaReports(cfg, true)).reports[0]!.quota.codexCredits)
      .toEqual({ balance: "12.5", unlimited: false });
  });

  test("the dashboard shows relay credits only when enabled and not marked partial", async () => {
    const seen: Seen[] = [];
    let body = { ...LIVE_USAGE, upstream_limits: [...LIVE_USAGE.upstream_limits, {
      limit_type: "credits", limit_window: "monthly", max_value: 100, current_value: 35,
      remaining_value: 65, model_filter: null, reset_at: "2026-12-01T00:00:00Z", source: "aggregate",
    }] };
    const poolProvider = provider("https://lb.example.com/backend-api/codex", undefined, seen);
    poolProvider.fetch = (async () => Response.json(body)) as typeof fetch;
    const cfg = config("my-pool", poolProvider);
    const dashboardQuota = async (refresh = true) => {
      const url = new URL(`http://localhost/api/provider-quotas${refresh ? "?refresh=1" : ""}`);
      const response = await handleManagementAPI(new ManagementRequest(url), url, cfg);
      expect(response?.status).toBe(200);
      return (await response!.json()).reports[0].quota;
    };
    for (const shown of [undefined, false]) {
      cfg.showCodexCredits = shown;
      const quota = await dashboardQuota();
      expect(quota).not.toHaveProperty("codexCredits");
      expect(quota.weeklyPercent).toBeCloseTo(90.4, 1);
    }
    cfg.showCodexCredits = true;
    expect((await dashboardQuota()).codexCredits).toEqual({ balance: "52451.317714", unlimited: false });

    body = { ...body, purchased_credits: { ...body.purchased_credits, balance: 10, is_partial: true } };
    const partial = await dashboardQuota();
    expect(partial).not.toHaveProperty("codexCredits");
    expect(partial.fiveHourPercent).toBeCloseTo(37.5, 5);
    expect(partial.weeklyPercent).toBeCloseTo(90.4, 1);
    expect(partial.weeklyResetAt).toBe(Date.parse("2026-11-09T10:38:52Z"));
    expect(partial.monthlyPercent).toBe(35);
    expect(partial.monthlyResetAt).toBe(Date.parse("2026-12-01T00:00:00Z"));
    const cachedPartial = await dashboardQuota(false);
    expect(cachedPartial).not.toHaveProperty("codexCredits");
    expect(cachedPartial.weeklyPercent).toBeCloseTo(90.4, 1);

    body = { ...body, purchased_credits: { ...body.purchased_credits, balance: -5, is_partial: false } };
    expect((await dashboardQuota()).codexCredits).toEqual({ balance: "-5", unlimited: false });
  });

  test("hidden upstream quota is an authoritative empty answer, not a row", async () => {
    const seen: Seen[] = [];
    const hidden = { ...LIVE_USAGE, upstream_limits: [], account_pool_usage: null, purchased_credits: null };
    const result = await fetchProviderQuotaReports(
      config("codex-lb", provider("https://lb.example.com/backend-api/codex/", hidden, seen)), true);
    expect(seen).toHaveLength(1);
    expect(result.reports).toEqual([]);
  });

  test("relay seat deadlines do not notify a pool reset, while native account resets still notify", async () => {
    const events: QuotaResetEvent[] = [];
    const expired = Date.now() - 60_000;
    const next = Date.now() + 7 * 24 * 60 * 60_000;
    const payload = (current: number, reset: number) => ({ ...LIVE_USAGE, upstream_limits: [{
      ...LIVE_USAGE.upstream_limits[0], current_value: current, max_value: 100,
      remaining_value: 100 - current, reset_at: new Date(reset).toISOString(),
    }] });
    let body = payload(96, expired);
    const poolProvider = provider("https://lb.example.com/backend-api/codex", undefined, []);
    poolProvider.fetch = (async () => Response.json(body)) as typeof fetch;
    const cfg = config("my-pool", poolProvider);
    await flushProviderQuotaObservationsForTests();
    resetQuotaResetStoreForTests();
    setQuotaResetSink(event => { events.push(event); });
    try {
      expect((await fetchProviderQuotaReports(cfg, true)).reports[0]!.quota.weeklyPercent).toBe(96);
      await flushProviderQuotaObservationsForTests();
      body = payload(2, next);
      expect((await fetchProviderQuotaReports(cfg, true)).reports[0]!.quota.weeklyPercent).toBe(2);
      await flushProviderQuotaObservationsForTests();
      expect(events).toEqual([]);

      setAccountQuotaFromParsed("native-seat", { weeklyPercent: 96, weeklyResetAt: expired });
      await flushQuotaObservationsForTests();
      setAccountQuotaFromParsed("native-seat", { weeklyPercent: 2, weeklyResetAt: next });
      await flushQuotaObservationsForTests();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ scope: "codex", kind: "scheduled", window: "weekly" });
    } finally {
      setQuotaResetSink(null);
      clearAccountQuota("native-seat");
      await flushQuotaObservationsForTests();
      resetQuotaResetStoreForTests();
    }
  });

  test("another relay's /v1/usage shape or a refusal publishes nothing", async () => {
    for (const [body, status] of [[{ object: "list", data: [] }, 200], [{ detail: "Not Found" }, 404]] as const) {
      clearProviderQuotaCache();
      const seen: Seen[] = [];
      const result = await fetchProviderQuotaReports(
        config("relay", provider("https://relay.example.com/backend-api/codex", body, seen, status)), true);
      expect(seen).toHaveLength(1);
      expect(result.reports).toEqual([]);
    }
  });

  test("ChatGPT itself, other paths and cleartext URLs are never probed", async () => {
    for (const baseUrl of [
      "https://chatgpt.com/backend-api/codex",
      "https://lb.example.com/v1",
      "http://lb.example.com/backend-api/codex",
      "https://lb.example.com/backend-api/codex?x=1",
    ]) {
      clearProviderQuotaCache();
      const seen: Seen[] = [];
      const providerConfig = provider(baseUrl, LIVE_USAGE, seen);
      const result = await fetchProviderQuotaReports(config("relay", providerConfig), true);
      expect(result.reports).toEqual([]);
      expect(seen).toEqual([]);
      expect(providerApiKeyQuotaMode("relay", providerConfig)).toBe("unsupported");
    }
  });
});
