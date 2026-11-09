import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** codex-lb pooled usage (`GET /v1/usage`) read through the provider's own key. */
import { clearProviderQuotaCache, fetchProviderQuotaReports, providerApiKeyQuotaMode } from "../../src/providers/quota";
import { getCachedProviderRoutingQuota } from "../../src/providers/quota-routing-cache";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

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

  test("hidden upstream quota is an authoritative empty answer, not a row", async () => {
    const seen: Seen[] = [];
    const hidden = { ...LIVE_USAGE, upstream_limits: [], account_pool_usage: null, purchased_credits: null };
    const result = await fetchProviderQuotaReports(
      config("codex-lb", provider("https://lb.example.com/backend-api/codex/", hidden, seen)), true);
    expect(seen).toHaveLength(1);
    expect(result.reports).toEqual([]);
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
