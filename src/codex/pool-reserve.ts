import type { OcxConfig } from "../types";
import type { OcxRuntimeProviderConfig } from "./auth-context";
import type { CodexAccountUsabilityOptions } from "./account-usability";
import { codexUsageLimitResetAt } from "./account-credit-use";
import { NATIVE_RESERVE_MODEL } from "./catalog/native-models";
import { getAccountQuota } from "./quota";
import { resetAtToMs, type StoredAccountQuota, type WhamUsageResponse } from "./quota-types";
import { grantsReserve, reserveLimits } from "./reserve-availability";
import { getEligiblePoolAccounts } from "./routing/selection";
import type { CodexQuotaScope } from "./routing/health-store";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers-destination";

const LABEL = "Luna Reserve";
// Longer than the 5-minute recovery probe cadence (CODEX_QUOTA_PROBE_INTERVAL_MS), so a grant
// does not lapse between two scheduled re-reads; a revoked grant still fails closed upstream.
export const POOL_RESERVE_FRESHNESS_MS = 15 * 60_000;

/** Only a capability-aware WHAM read grants or retracts this independently timed window. */
function poolReserveWindows(
  data: WhamUsageResponse, existing: StoredAccountQuota | null, observedAt: number,
): NonNullable<StoredAccountQuota["customWindows"]> {
  const windows = (existing?.customWindows ?? []).filter(window => window.label !== LABEL);
  const window = grantsReserve(data) ? reserveLimits(data)[0]?.rate_limit?.primary_window : undefined;
  if (window && typeof window.used_percent === "number" && Number.isFinite(window.used_percent)
    && window.used_percent >= 0 && typeof window.reset_at === "number" && Number.isFinite(window.reset_at)
    && resetAtToMs(window.reset_at) > observedAt) {
    windows.push({ label: LABEL, percent: window.used_percent, resetAt: window.reset_at, observedAt });
  }
  return windows;
}

/** Even a window-less non-granting WHAM response must retract a previously stored grant. */
export function withPoolReserveQuota(
  data: WhamUsageResponse, quota: Omit<StoredAccountQuota, "updatedAt"> | null,
  existing: StoredAccountQuota | null, observedAt: number,
): Omit<StoredAccountQuota, "updatedAt"> | null {
  const customWindows = poolReserveWindows(data, existing, observedAt);
  const granted = customWindows.some(window => window.label === LABEL);
  // Only a grant or a retraction writes the list: a present list replaces the stored one on merge.
  if (!granted && !existing?.customWindows?.some(window => window.label === LABEL)) return quota;
  return { ...quota, customWindows };
}

function hasFreshPoolReserve(accountId: string, now = Date.now()): boolean {
  return getAccountQuota(accountId)?.customWindows?.some(window => window.label === LABEL
    && Number.isFinite(window.percent) && window.percent >= 0 && window.percent < 100
    && typeof window.resetAt === "number" && Number.isFinite(window.resetAt) && resetAtToMs(window.resetAt) > now
    && typeof window.observedAt === "number" && window.observedAt <= now
    && now - window.observedAt <= POOL_RESERVE_FRESHNESS_MS) === true;
}

/** A selected Reserve request must fail closed on expiry, even if credits could otherwise serve. */
export function poolReserveHoldResetAt(accountId: string, now = Date.now()): number | undefined {
  if (hasFreshPoolReserve(accountId, now)) return undefined;
  return now + 60_000;
}

/** Keep the existing selector and its pause, credential, health, affinity and priority policies. */
export function poolLunaReserveSelection(
  config: OcxConfig, modelId: string | undefined, quotaScope: CodexQuotaScope | undefined,
  options: CodexAccountUsabilityOptions, excludeId?: string, now = Date.now(),
): { options: CodexAccountUsabilityOptions; quotaScope: CodexQuotaScope | undefined; reserve: boolean } {
  const unchanged = { options, quotaScope, reserve: false };
  if (modelId !== "gpt-6-luna") return unchanged;
  // With no Reserve anywhere, selection must stay exactly as before (credit seats and affinity included).
  const reserveIds = new Set((config.codexAccounts ?? []).filter(account => account.id !== excludeId
    && codexUsageLimitResetAt(getAccountQuota(account.id), account.plan, now) !== undefined
    && hasFreshPoolReserve(account.id, now)).map(account => account.id));
  if (reserveIds.size === 0) return unchanged;
  const includedOnly: CodexAccountUsabilityOptions = { ...options, poolCapacity: "included" };
  if (getEligiblePoolAccounts(config, excludeId, now, quotaScope, includedOnly).length > 0) {
    return { ...unchanged, options: includedOnly };
  }
  const reserveOptions: CodexAccountUsabilityOptions = { ...options, modelEligibleAccountIds: reserveIds, poolCapacity: "reserve" };
  if (getEligiblePoolAccounts(config, excludeId, now, "reserve", reserveOptions).length === 0) return unchanged;
  return { options: reserveOptions, quotaScope: "reserve", reserve: true };
}

/** The shared Responses serialization feeds both HTTP and WebSocket dispatch. */
export function poolReserveWireBody<T>(body: T, provider: OcxRuntimeProviderConfig): T {
  const override = provider._codexAccountOverride;
  if (!override?.poolReserve || !isCanonicalOpenAiForwardProvider(provider)
    || !body || typeof body !== "object" || !("model" in body) || body.model !== "gpt-6-luna") return body;
  return { ...body, model: NATIVE_RESERVE_MODEL };
}
