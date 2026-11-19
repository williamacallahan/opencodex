import type { OcxConfig } from "../types";
import type { OcxRuntimeProviderConfig } from "./auth-context-provider";
import type { CodexAccountUsabilityOptions } from "./account-usability";
import { codexUsageLimitResetAt } from "./account-credit-use";
import { NATIVE_RESERVE_MODEL } from "./catalog/native-models";
import { getAccountQuota } from "./quota";
import { resetAtToMs, type StoredAccountQuota, type WhamUsageResponse } from "./quota-types";
import { grantsReserve, reserveLimits } from "./reserve-availability";
import { getEligiblePoolAccounts, getPoolAccountPlanForSelection, isCodexAccountSelectable, shouldFailover } from "./routing/selection";
import { mayRebindAffinityForQuota } from "./routing/cache-affinity";
import { computeCodexUsageScore } from "./routing/cooldown-math";
import { getEffectiveCodexAutoSwitchThreshold } from "./account-auto-switch";
import { codexAccountUsesCreditsAfterLimit } from "./account-credit-use";
import { getThreadAffinity, isThreadAffinityExpired, isThreadAffinityGenerationLive, lastThreadServe } from "./routing/thread-affinity";
import { isCodexAccountGenerationLive } from "./account-store";
import { hasUnrecoveredCodexQuotaRefusal, scopedHealthFor, type CodexQuotaScope } from "./routing/health-store";
import { canTryUnknownCodexReserve } from "./routing/probe-lease";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers-destination";

const LABEL = "Luna Reserve";
export const POOL_RESERVE_UNAVAILABLE_MESSAGE = "No Codex pool account can serve Luna Reserve right now; nothing was sent.";
/** The one model whose ChatGPT pool seats can hold a separate Reserve window. */
export const modelHasPoolReserve = (modelId: unknown): boolean => modelId === "gpt-6-luna";
/** Request-local capacity for a native Luna leg: Reserve or nothing, or ordinary Luna without ever consulting Reserve. */
export type PoolCapacityIntent = "reserve-only" | "ordinary-only";
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

/** Any stored Luna Reserve window, fresh or stale: its freshness lapses after 15 minutes, so the seat is read on the ordinary cadence. */
export function holdsPoolReserveWindow(accountId: string): boolean {
  return getAccountQuota(accountId)?.customWindows?.some(window => window.label === LABEL) === true;
}

export function hasFreshPoolReserve(accountId: string, now = Date.now()): boolean {
  return getAccountQuota(accountId)?.customWindows?.some(window => window.label === LABEL
    && Number.isFinite(window.percent) && window.percent >= 0 && window.percent < 100
    && typeof window.resetAt === "number" && Number.isFinite(window.resetAt) && resetAtToMs(window.resetAt) > now
    && typeof window.observedAt === "number" && window.observedAt <= now
    && now - window.observedAt <= POOL_RESERVE_FRESHNESS_MS) === true;
}

/**
 * Whether a seat may be offered Luna Reserve: a fresh reported grant, or no Reserve window at all.
 * ChatGPT serves `gpt-reserve` to seats whose usage response never lists a grant (openai/codex#40939),
 * so an unreported seat is tried and the upstream stays the entitlement authority. A stored window
 * that is exhausted, elapsed or stale is evidence against Reserve and keeps the seat out.
 */
export function hasVerifiedPoolReserve(accountId: string, now: number): boolean {
  if (hasFreshPoolReserve(accountId, now)) return true;
  if (holdsPoolReserveWindow(accountId)) return false;
  const success = scopedHealthFor(accountId, "reserve")?.reserveSuccess;
  return success !== undefined && success.at <= now && now - success.at <= POOL_RESERVE_FRESHNESS_MS
    && isCodexAccountGenerationLive(accountId, success.credentialGeneration);
}

function poolReserveOfferable(accountId: string, now: number): boolean {
  return hasFreshPoolReserve(accountId, now) || !holdsPoolReserveWindow(accountId);
}

/** A selected Reserve request must fail closed on a stored exhausted or stale window, even if credits could otherwise serve. */
export function poolReserveHoldResetAt(accountId: string, now = Date.now()): number | undefined {
  if (poolReserveOfferable(accountId, now)) return undefined;
  return now + 60_000;
}

// Stale evidence is deliberately not re-read on the request path. The hub's `quota-refresh` service
// refreshes non-exhausted seats and seats holding a Reserve window on the 5-minute cadence, well inside
// POOL_RESERVE_FRESHNESS_MS; an exhausted seat without a Reserve window is read every 15 minutes, so a
// reported window on it is seen within that hold. A seat whose probe keeps failing is not helped by a
// request waiting on it. A seat holding only a stale window is skipped for that request, which falls
// back to the unchanged selection; a wait here was rejected twice in review for delaying or
// desynchronizing bursts.

/**
 * Every Luna request goes first to Reserve on a seat whose included usage is spent. Only when no
 * such seat can serve Reserve does it use Luna on a seat that still has included usage. A thread an
 * included seat already served stays there unless the cache-affinity policy allows a quota move; a
 * binding that never served does not outrank Reserve, and a seat whose Reserve scope is
 * cooling from a refusal is skipped by the same selection. Selection keeps its pause, credential,
 * health, affinity and priority policies.
 */
export function poolLunaReserveSelection(
  config: OcxConfig, modelId: string | undefined, quotaScope: CodexQuotaScope | undefined,
  options: CodexAccountUsabilityOptions, excludeId?: string, affinityKey?: string, now = Date.now(),
  pinnedAccountId?: string, verifiedOnly = false, intent?: PoolCapacityIntent,
): { options: CodexAccountUsabilityOptions; quotaScope: CodexQuotaScope | undefined; reserve: boolean; discovery?: boolean } {
  const unchanged = { options, quotaScope, reserve: false };
  if (!modelHasPoolReserve(modelId) || intent === "ordinary-only") return unchanged;
  // A pin cannot move after a refusal, so it is offered Reserve only on a fresh reported grant.
  const verified = new Set<string>();
  const unknown = new Set<string>();
  for (const account of config.codexAccounts ?? []) {
    const { id } = account;
    if (id === excludeId || (pinnedAccountId !== undefined && id !== pinnedAccountId)
      || (options.modelEligibleAccountIds && !options.modelEligibleAccountIds.has(id))
      || codexUsageLimitResetAt(getAccountQuota(id), account.plan, now) === undefined) continue;
    const health = scopedHealthFor(id, "reserve");
    if (health?.probeLeaseId !== undefined) continue;
    if (pinnedAccountId === undefined ? hasVerifiedPoolReserve(id, now) : hasFreshPoolReserve(id, now)) verified.add(id);
    else if (pinnedAccountId === undefined && !verifiedOnly && !holdsPoolReserveWindow(id)
      && canTryUnknownCodexReserve(id, now)) unknown.add(id);
  }
  // The seat and capacity that completed this thread's last Luna turn; a later serve on another seat or capacity
  // outranks an older Reserve binding.
  const served = affinityKey === undefined || modelId === undefined ? undefined : lastThreadServe(affinityKey, modelId, now);
  // A thread included Luna already served keeps that seat under the same rule that governs any bound
  // conversation (#4546): only a move the cache-affinity policy allows for quota may take it elsewhere, so
  // a later turn never trades its warm prompt cache and that seat's encrypted reasoning for another seat's
  // Reserve. A strict Reserve leg (`reserve-only`) is a first placement and is not held here.
  const ownerId = pinnedAccountId !== undefined || intent === "reserve-only" || served?.capacity !== "included" ? undefined : served.accountId;
  if (ownerId !== undefined && ownerId !== excludeId && (options.modelEligibleAccountIds?.has(ownerId) ?? true)) {
    // The roster narrows to the seat that served, which a completion on an alternate seat never bound.
    const includedOnly: CodexAccountUsabilityOptions = { ...options, poolCapacity: "included", modelEligibleAccountIds: new Set([ownerId]) };
    const threshold = getEffectiveCodexAutoSwitchThreshold(config, ownerId);
    const usage = computeCodexUsageScore(getAccountQuota(ownerId), getPoolAccountPlanForSelection(config, ownerId, includedOnly),
      now, codexAccountUsesCreditsAfterLimit(config, ownerId));
    // The resolver's own bound-seat health test: a live failure streak or an unrecovered quota refusal releases the thread.
    if (isCodexAccountSelectable(config, ownerId, now, quotaScope, includedOnly)
      && !shouldFailover(config, ownerId, now) && !hasUnrecoveredCodexQuotaRefusal(ownerId, quotaScope)
      // The caller's own options, not `includedOnly`: an included capacity always retains in that policy, and the
      // operator's `pool.cacheAffinity: false` must still let a seat over its auto-switch threshold go to Reserve.
      && !mayRebindAffinityForQuota(config, ownerId, usage, threshold, options)) return { ...unchanged, options: includedOnly };
  }
  if (verified.size === 0 && unknown.size === 0 && !verifiedOnly) return unchanged;
  const reserveOptions: CodexAccountUsabilityOptions = { ...options, modelEligibleAccountIds: verified, poolCapacity: "reserve" };
  // An operator pin keeps its seat; it only chooses between that seat's own Reserve and the unchanged request.
  if (pinnedAccountId !== undefined) {
    return isCodexAccountSelectable(config, pinnedAccountId, now, "reserve", reserveOptions)
      ? { options: reserveOptions, quotaScope: "reserve", reserve: true } : unchanged;
  }
  // A thread already served by Reserve keeps its seat while that seat can still serve it.
  const serving = affinityKey === undefined ? undefined : getThreadAffinity(affinityKey, "reserve");
  if (serving && !isThreadAffinityExpired(serving, now) && isThreadAffinityGenerationLive(serving)
    && (served === undefined || (served.capacity === "reserve" && served.accountId === serving.accountId))
    && isCodexAccountSelectable(config, serving.accountId, now, "reserve", reserveOptions)) {
    return { options: reserveOptions, quotaScope: "reserve", reserve: true };
  }
  const verifiedOptions = { ...reserveOptions, modelEligibleAccountIds: verified };
  if (verified.size > 0 && getEligiblePoolAccounts(config, excludeId, now, "reserve", verifiedOptions).length > 0) {
    return { options: verifiedOptions, quotaScope: "reserve", reserve: true };
  }
  const discoveryOptions = { ...reserveOptions, modelEligibleAccountIds: unknown };
  if (unknown.size > 0 && getEligiblePoolAccounts(config, excludeId, now, "reserve", discoveryOptions).length > 0) {
    return { options: discoveryOptions, quotaScope: "reserve", reserve: true, discovery: true };
  }
  const includedOnly: CodexAccountUsabilityOptions = { ...options, poolCapacity: "included" };
  return getEligiblePoolAccounts(config, excludeId, now, quotaScope, includedOnly).length > 0
    ? { ...unchanged, options: includedOnly } : unchanged;
}

/** The shared Responses serialization feeds both HTTP and WebSocket dispatch. */
export function poolReserveWireBody<T>(body: T, provider: OcxRuntimeProviderConfig): T {
  const override = provider._codexAccountOverride;
  if (!override?.poolReserve || !isCanonicalOpenAiForwardProvider(provider)
    || !body || typeof body !== "object" || !("model" in body) || !modelHasPoolReserve(body.model)) return body;
  return { ...body, model: NATIVE_RESERVE_MODEL };
}
