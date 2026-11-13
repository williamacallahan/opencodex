import { parseCodexCredits } from "../../codex/credits";
import { providerOutboundGet } from "../../lib/provider-outbound";
import { resolveProviderApiKey } from "../key-store";
import { QUOTA_JSON_READ_FAILURE, asRecord, normalizePercent, normalizeResetAt, readQuotaJson, REQUEST_TIMEOUT_MS, toFiniteNumber } from "../quota-wire";
import { CODEX_LB_USAGE_SOURCE, type ProviderQuota } from "../quota-types";
import type { OcxProviderConfig } from "../../types";
import { codexLbUsageUrl } from "./codex-lb-url";
import { AUTHORITATIVE_EMPTY_QUOTA, hasQuotaRows, report, TERMINAL_QUOTA_FAILURE, type ProviderQuotaProbeResult } from "./report-cache";

/** Used percent of one window from codex-lb's aggregate upstream limit row. */
function limitWindow(rows: unknown[], window: string): { percent: number; resetAt?: number } | undefined {
  const row = rows.map(asRecord).find(item => item?.limit_window === window);
  const max = toFiniteNumber(row?.max_value), current = toFiniteNumber(row?.current_value);
  if (!row || max === undefined || current === undefined || max <= 0) return undefined;
  const percent = normalizePercent((current / max) * 100);
  const resetAt = normalizeResetAt(row.reset_at);
  return percent === undefined ? undefined : { percent, ...(resetAt !== undefined ? { resetAt } : {}) };
}

/** Pool remaining percent, reported by `account_pool_usage` when upstream limit rows are absent. */
function usedFromRemaining(value: unknown): number | undefined {
  const remaining = normalizePercent(value);
  return remaining === undefined ? undefined : 100 - remaining;
}

const LUNA_RESERVE_MODEL = "gpt-reserve";

/**
 * Luna Reserve across the relay's seats. A pool where no seat reports a Reserve bucket shows a
 * spent "none offered" row, because 0 seats means no Luna capacity beyond ordinary usage. The
 * Reserve model id keeps the row display-only: windows carrying a model never gate routing.
 */
function lunaReserveWindow(value: unknown): ProviderQuota["customWindows"] {
  const reserve = asRecord(value);
  const seats = toFiniteNumber(reserve?.seats);
  if (!reserve || seats === undefined || seats < 0) return undefined;
  if (seats === 0) return [{ label: "Luna Reserve: none offered", percent: 100, modelId: LUNA_RESERVE_MODEL }];
  const used = usedFromRemaining(reserve.remaining_percent);
  if (used === undefined) return undefined;
  const resetAt = normalizeResetAt(reserve.reset_at);
  const label = seats === 1 ? "Luna Reserve (1 seat)" : `Luna Reserve (${seats} seats)`;
  return [{ label, percent: used, ...(resetAt !== undefined ? { resetAt } : {}), modelId: LUNA_RESERVE_MODEL }];
}

/**
 * codex-lb `V1UsageResponse`: per-window pooled quota (upstream limit rows first, then the
 * remaining-percent pool summary), pooled Luna Reserve, and the summed purchased credit balance
 * of the key's pool. Null for a body that is not that response, so another relay on the same path
 * shows nothing.
 */
export function parseCodexLbUsage(body: unknown): ProviderQuota | typeof AUTHORITATIVE_EMPTY_QUOTA | null {
  const usage = asRecord(body);
  if (!usage || !Array.isArray(usage.limits) || !("account_pool_usage" in usage || "purchased_credits" in usage)) return null;
  const rows = Array.isArray(usage.upstream_limits) ? usage.upstream_limits : [];
  const pool = asRecord(usage.account_pool_usage);
  const fiveHour = limitWindow(rows, "5h"), weekly = limitWindow(rows, "7d"), monthly = limitWindow(rows, "monthly");
  const fiveHourPercent = fiveHour?.percent ?? usedFromRemaining(pool?.primary);
  const weeklyPercent = weekly?.percent ?? usedFromRemaining(pool?.secondary);
  const purchased = asRecord(usage.purchased_credits);
  const codexCredits = purchased && purchased.is_partial !== true
    ? parseCodexCredits({ balance: purchased.balance ?? undefined, unlimited: purchased.unlimited }, { allowNegative: true })
    : null;
  const customWindows = lunaReserveWindow(usage.luna_reserve);
  const quota: ProviderQuota = {
    ...(fiveHourPercent !== undefined ? { fiveHourPercent } : {}),
    ...(fiveHour?.resetAt !== undefined ? { fiveHourResetAt: fiveHour.resetAt } : {}),
    ...(weeklyPercent !== undefined ? { weeklyPercent } : {}),
    ...(weekly?.resetAt !== undefined ? { weeklyResetAt: weekly.resetAt } : {}),
    ...(monthly ? { monthlyPercent: monthly.percent } : {}),
    ...(monthly?.resetAt !== undefined ? { monthlyResetAt: monthly.resetAt } : {}),
    ...(customWindows ? { customWindows } : {}),
    ...(codexCredits ? { codexCredits } : {}),
    updatedAt: Date.now(),
  };
  return hasQuotaRows(quota) ? quota : AUTHORITATIVE_EMPTY_QUOTA;
}

/**
 * Display-only report: codex-lb spends purchased credits once included quota runs out, so a full
 * pool is not proof the provider refuses requests, and the report carries no routing evidence.
 */
export async function fetchCodexLbQuota(provider: string, config: OcxProviderConfig): Promise<ProviderQuotaProbeResult> {
  const url = codexLbUsageUrl(config);
  const apiKey = resolveProviderApiKey(config.apiKey)?.trim();
  if (!url || !apiKey) return null;
  // The inference destination policy (private-network opt-in, DNS pinning, proxy, no redirects).
  const response = await providerOutboundGet(provider, config, url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    void response.body?.cancel();
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  const raw = await readQuotaJson(response);
  if (raw === QUOTA_JSON_READ_FAILURE) return null;
  const quota = parseCodexLbUsage(raw);
  if (quota === null || quota === AUTHORITATIVE_EMPTY_QUOTA) return quota;
  return report(provider, CODEX_LB_USAGE_SOURCE, quota);
}
