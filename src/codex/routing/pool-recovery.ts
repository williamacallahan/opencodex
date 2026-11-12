/**
 * When another stored pool account can serve again, for a main-account hard-lock refusal (#7046).
 *
 * A pool request that fell through to the main login and met the main-account quota guard used
 * to be told to come back at main's own reset, which can be days away while a sibling pool
 * account recovers within hours. This module answers one question: the earliest KNOWN instant at
 * which a stored pool account's every temporary hold ends. It changes no routing state, selects
 * nothing, and never lifts the main guard. The client retries at that time, and ordinary selection
 * decides again from fresh state; a reset timestamp is a hint, not proof of fresh quota.
 *
 * Conservative by construction (the policy Jun is asked to confirm in #7046):
 * - An account is a candidate only when it is a selectable stored pool account that is not
 *   paused, plan-excluded, quarantined for sign-in, otherwise unusable, or denied for the model.
 *   Those are operator or credential states no clock lifts.
 * - Its recovery time is the LATEST of every routing hold with a known end: quota-health cooldown,
 *   quota avoidance, transient soft avoidance, pool-refresh backoff, and the credits-off
 *   usage-limit reset. An account under a hold whose end is unknown, or under the sliding
 *   failure-window guard (whose end moves with every failure), is skipped rather than guessed.
 * - For an account-gated model, only accounts the resolved entitlement roster admits count, and
 *   with no resolved roster nothing does.
 * - An account with no recorded hold is skipped: nothing says when it became unavailable, so
 *   nothing says when it will be available again.
 * - Main itself is never a candidate; its own reset stays on the refusal.
 */
import { isCodexAccountPaused } from "../account-pause";
import { codexUsageLimitResetAt } from "../account-credit-use";
import { MAIN_CODEX_ACCOUNT_ID, isSelectableCodexPoolAccount } from "../account-id";
import { isAccountNeedsReauth } from "../account-runtime-state";
import { isCodexAccountUsable, type CodexAccountUsabilityOptions } from "../account-usability";
import { getCodexPoolRefreshCooldownUntil } from "../pool-refresh-backoff";
import { getAccountQuota } from "../quota";
import type { OcxConfig } from "../../types";
import { failureWindowSteersNewThreads } from "./failure-window";
import {
  codexQuotaAvoidUntil, getCodexAccountSoftAvoidUntil, getCodexQuotaHealthSnapshot, type CodexQuotaScope,
} from "./health-store";
import {
  codexAccountBlockReason, getPoolAccountPlanForSelection, isCodexAccountHeldAtUsageLimit, isCodexAccountPlanExcluded,
} from "./selection";

/** When every temporary hold on one stored pool account ends; undefined when unknown or never. */
export function poolAccountRecoveryAt(
  config: OcxConfig,
  id: string,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
): number | undefined {
  if (isCodexAccountPaused(config, id)
    || isCodexAccountPlanExcluded(config, id) || isAccountNeedsReauth(id)
    || !isCodexAccountUsable(config, id, selectionOptions) || failureWindowSteersNewThreads(config, id, now)) return undefined;
  const holds: number[] = [];
  const health = getCodexQuotaHealthSnapshot(id, quotaScope, now);
  if (health) {
    if (typeof health.cooldownUntil !== "number" || !Number.isFinite(health.cooldownUntil)) return undefined;
    holds.push(health.cooldownUntil);
  }
  const avoidUntil = codexQuotaAvoidUntil(id, quotaScope, now);
  if (avoidUntil !== null) holds.push(avoidUntil);
  const softAvoidUntil = getCodexAccountSoftAvoidUntil(id, now);
  if (softAvoidUntil !== null) holds.push(softAvoidUntil);
  const refreshCooldownUntil = getCodexPoolRefreshCooldownUntil(id, now);
  if (refreshCooldownUntil !== null) holds.push(refreshCooldownUntil);
  if (isCodexAccountHeldAtUsageLimit(config, id, now, selectionOptions)) {
    const resetAt = codexUsageLimitResetAt(getAccountQuota(id), getPoolAccountPlanForSelection(config, id, selectionOptions), now);
    if (resetAt === undefined) return undefined;
    holds.push(resetAt);
  }
  if (holds.length === 0) return undefined;
  const recoveryAt = Math.max(...holds);
  return recoveryAt > now ? recoveryAt : undefined;
}

export function nextCodexPoolRecoveryAt(
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  options: {
    deniedAccountIds?: ReadonlySet<string>;
    /** When set, only these accounts may serve the model (account-gated models). */
    eligibleAccountIds?: ReadonlySet<string>;
  } = {},
): number | undefined {
  let earliest: number | undefined;
  for (const account of config.codexAccounts ?? []) {
    if (!isSelectableCodexPoolAccount(account)) continue;
    const id = account.id;
    if (options.deniedAccountIds?.has(id) || (options.eligibleAccountIds && !options.eligibleAccountIds.has(id))) continue;
    const recoveryAt = poolAccountRecoveryAt(config, id, now, quotaScope);
    if (recoveryAt !== undefined && (earliest === undefined || recoveryAt < earliest)) earliest = recoveryAt;
  }
  return earliest;
}

/**
 * The account that recovers first, when quota is the only reason no stored account is
 * selectable: every rotation candidate (paused and plan-excluded rows are operator choices, not
 * candidates) is a usable credential refused by a quota cooldown, quota avoidance, or a
 * credits-off usage limit with a known end. Undefined when any candidate needs sign-in, is
 * otherwise unusable, or is held with no known end: a pool holding a dead credential stays a
 * credential failure even while that row still carries a stale quota hold. The caller answers a
 * retryable 429 at that reset instead of a 401, which clients treat as final.
 *
 * `mainCandidate` says the caller may still route to the main login. When main is then held out
 * only by a hold with a known end (often a cooldown of minutes), that end competes with the pool's
 * resets, so the client is not told to wait hours for a pool reset while main returns first.
 */
export function exhaustedCodexPoolRecovery(
  config: OcxConfig,
  now: number,
  quotaScope?: CodexQuotaScope,
  selectionOptions?: CodexAccountUsabilityOptions,
  mainCandidate = false,
): { accountId: string; retryAt: number } | undefined {
  let soonest: { accountId: string; retryAt: number } | undefined;
  for (const account of config.codexAccounts ?? []) {
    if (!isSelectableCodexPoolAccount(account)) continue;
    const reason = codexAccountBlockReason(config, account.id, now, quotaScope, selectionOptions);
    if (reason === "paused" || reason === "plan_excluded") continue;
    if (reason !== "cooldown" && reason !== "quota_avoided" && reason !== "credits_off") return undefined;
    // The block reason reports a quota hold before usability, so check the credential itself.
    if (isAccountNeedsReauth(account.id) || !isCodexAccountUsable(config, account.id, selectionOptions)) return undefined;
    const retryAt = poolAccountRecoveryAt(config, account.id, now, quotaScope, selectionOptions);
    if (retryAt === undefined) return undefined;
    if (soonest === undefined || retryAt < soonest.retryAt) soonest = { accountId: account.id, retryAt };
  }
  if (soonest === undefined || !mainCandidate) return soonest;
  const mainRetryAt = poolAccountRecoveryAt(config, MAIN_CODEX_ACCOUNT_ID, now, quotaScope, selectionOptions);
  return mainRetryAt !== undefined && mainRetryAt < soonest.retryAt
    ? { accountId: MAIN_CODEX_ACCOUNT_ID, retryAt: mainRetryAt } : soonest;
}
