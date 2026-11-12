import type { OcxConfig } from "../types";
import type { OcxRuntimeProviderConfig } from "./auth-context-provider";
import type { CodexAccountUsabilityOptions } from "./account-usability";
import { codexUsageLimitResetAt } from "./account-credit-use";
import { NATIVE_RESERVE_MODEL } from "./catalog/native-models";
import { getAccountQuota } from "./quota";
import { resetAtToMs, type StoredAccountQuota, type WhamUsageResponse } from "./quota-types";
import { grantsReserve, reserveLimits } from "./reserve-availability";
import { getEligiblePoolAccounts, isCodexAccountSelectable } from "./routing/selection";
import { getThreadAffinity, isThreadAffinityExpired, isThreadAffinityGenerationLive } from "./routing/thread-affinity";
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

// Stale evidence is deliberately not re-read on the request path. The hub's `quota-refresh` service
// force-probes every seat about once a minute, well inside POOL_RESERVE_FRESHNESS_MS, and a seat whose
// probe keeps failing is not helped by a request waiting on it. A Luna request that meets a cold or
// stale reading (a restart before the first probe) falls back to the unchanged selection for that
// request only; a wait here was rejected twice in review for delaying or desynchronizing bursts.

/**
 * Reserve is Luna-only while included quota is shared with Sol and Astra, so a fresh Reserve
 * goes before another seat's included quota. A thread bound to a seat that still has included
 * quota keeps Luna there, with its prompt cache. Selection keeps its pause, credential, health,
 * affinity and priority policies.
 */
export function poolLunaReserveSelection(
  config: OcxConfig, modelId: string | undefined, quotaScope: CodexQuotaScope | undefined,
  options: CodexAccountUsabilityOptions, excludeId?: string, affinityKey?: string, now = Date.now(),
  pinnedAccountId?: string,
): { options: CodexAccountUsabilityOptions; quotaScope: CodexQuotaScope | undefined; reserve: boolean } {
  const unchanged = { options, quotaScope, reserve: false };
  if (modelId !== "gpt-6-luna") return unchanged;
  // With no Reserve anywhere, selection must stay exactly as before (credit seats and affinity included).
  const reserveIds = new Set((config.codexAccounts ?? []).filter(account => account.id !== excludeId
    && (pinnedAccountId === undefined || account.id === pinnedAccountId)
    && codexUsageLimitResetAt(getAccountQuota(account.id), account.plan, now) !== undefined
    && hasFreshPoolReserve(account.id, now)).map(account => account.id));
  if (reserveIds.size === 0) return unchanged;
  const reserveOptions: CodexAccountUsabilityOptions = { ...options, modelEligibleAccountIds: reserveIds, poolCapacity: "reserve" };
  // An operator pin keeps its seat; it only chooses between that seat's own Reserve and the unchanged request.
  if (pinnedAccountId !== undefined) {
    return isCodexAccountSelectable(config, pinnedAccountId, now, "reserve", reserveOptions)
      ? { options: reserveOptions, quotaScope: "reserve", reserve: true } : unchanged;
  }
  const includedOnly: CodexAccountUsabilityOptions = { ...options, poolCapacity: "included" };
  const included = getEligiblePoolAccounts(config, excludeId, now, quotaScope, includedOnly);
  const shared = affinityKey === undefined ? undefined : getThreadAffinity(affinityKey, quotaScope);
  if (affinityKey !== undefined) {
    const serving = getThreadAffinity(affinityKey, "reserve");
    if (serving && (!shared || serving.lastUsedAt > shared.lastUsedAt)
      && !isThreadAffinityExpired(serving, now) && isThreadAffinityGenerationLive(serving)
      && isCodexAccountSelectable(config, serving.accountId, now, "reserve", reserveOptions)) {
      return { options: reserveOptions, quotaScope: "reserve", reserve: true };
    }
  }
  // The resolver's bound-reuse rule, not new-thread placement: a bound thread is never
  // steered away by the failure window that only shapes where new threads land. A binding
  // whose credential generation is stale is not a live owner — the resolver releases it —
  // so taking the included-owner exception here would spend included quota while Reserve
  // exists on another seat.
  if (shared !== undefined && !isThreadAffinityExpired(shared, now) && isThreadAffinityGenerationLive(shared)
    && shared.accountId !== excludeId
    && isCodexAccountSelectable(config, shared.accountId, now, quotaScope, includedOnly)) {
    return { ...unchanged, options: includedOnly };
  }
  if (getEligiblePoolAccounts(config, excludeId, now, "reserve", reserveOptions).length > 0) {
    return { options: reserveOptions, quotaScope: "reserve", reserve: true };
  }
  return included.length > 0 ? { ...unchanged, options: includedOnly } : unchanged;
}

/** The shared Responses serialization feeds both HTTP and WebSocket dispatch. */
export function poolReserveWireBody<T>(body: T, provider: OcxRuntimeProviderConfig): T {
  const override = provider._codexAccountOverride;
  if (!override?.poolReserve || !isCanonicalOpenAiForwardProvider(provider)
    || !body || typeof body !== "object" || !("model" in body) || body.model !== "gpt-6-luna") return body;
  return { ...body, model: NATIVE_RESERVE_MODEL };
}
