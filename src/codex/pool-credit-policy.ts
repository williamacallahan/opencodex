import type { OcxConfig } from "../types";
import { codexAccountUsesCreditsAfterLimit, codexUsageLimitResetAt, isCodexAccountHeldForCredits } from "./account-credit-use";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import { isSelectableCodexPoolAccount } from "./account-id";
import { getAccountQuota } from "./quota";
import { hasSpendableCodexCredits, type PoolQuotaWriter } from "./quota-types";
import { getCodexAccountCooldownUntil, scopedHealthFor, type CodexQuotaScope } from "./routing/health-store";
import { nextQuotaQueryDelay } from "./quota-query-backoff";
import { failureWindowSteeringEndsAt } from "./routing/failure-window";
import { poolReserveHoldResetAt } from "./pool-reserve";

export type PoolCreditPolicyConfig = Readonly<Pick<OcxConfig, "creditCodexAccountIds" | "codexAccounts">>;
type PoolContext = { kind: "pool"; accountId: string; poolReserve?: true; poolQuotaWriter?: PoolQuotaWriter };

// Keep live policy references private: they must not enter DTOs or serialized auth context.
const policies = new WeakMap<object, {
  config: PoolCreditPolicyConfig;
  policy: PoolCreditPolicyConfig;
}>();

/** Read cached usage only. This helper never opens or refreshes a credential. */
export function poolCreditHoldResetAt(
  policy: PoolCreditPolicyConfig,
  accountId: string,
  catalog: PoolCreditPolicyConfig = policy,
  now = Date.now(),
  reserve = false,
): number | undefined {
  // Native main has an independent identity-bound quota policy. Never read its physical plan.
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return undefined;
  if (reserve) return poolReserveHoldResetAt(accountId, now);
  const quota = getAccountQuota(accountId);
  const plan = catalog.codexAccounts
    ?.find(account => isSelectableCodexPoolAccount(account) && account.id === accountId)?.plan;
  if (!isCodexAccountHeldForCredits(policy, accountId, quota, plan, now)) return undefined;
  return codexUsageLimitResetAt(quota, plan, now);
}

/** Remember policy by reference so later credential materialization rechecks current values. */
export function bindPoolCreditPolicy<T extends PoolContext>(
  context: T,
  config: PoolCreditPolicyConfig,
  policy: PoolCreditPolicyConfig = config,
): T {
  policies.set(context, { config, policy });
  if (context.poolReserve && context.poolQuotaWriter) context.poolQuotaWriter.poolReserve = true;
  return context;
}

/**
 * Carry the resolver's live policy onto a context rebuilt by spread copy. The WeakMap keys on
 * object identity, so `{ ...ctx }` alone loses the binding and every caller that omits an
 * explicit override would skip credit-hold enforcement on the copy. A source with no binding
 * leaves the target unbound rather than inventing a policy.
 */
export function rebindPoolCreditPolicy<S extends PoolContext, T extends object>(source: S, target: T): T {
  const bound = policies.get(source);
  if (bound) policies.set(target, bound);
  if (source.poolReserve && "poolQuotaWriter" in target && target.poolQuotaWriter) {
    Object.assign(target.poolQuotaWriter, { poolReserve: true });
  }
  return target;
}

/** Explicit policy wins; omitted materialization options retain the resolver's policy. */
export function poolContextCreditHoldResetAt(
  context: PoolContext,
  override?: PoolCreditPolicyConfig,
  now = Date.now(),
): number | undefined {
  const bound = policies.get(context);
  const policy = override ?? bound?.policy;
  // Unbound contexts skip credit-hold enforcement entirely: callers that require
  // enforcement must supply `override` (or resolve through bindPoolCreditPolicy).
  if (!policy) return undefined;
  const catalog = override?.codexAccounts ? override : bound?.config ?? policy;
  return poolCreditHoldResetAt(policy, context.accountId, catalog, now, context.poolReserve === true);
}

/** Retry advice only: absent/uncertain evidence can be re-observed, never spent. */
export function poolCreditRecoveryNeeded(policy: PoolCreditPolicyConfig, accountId: string, now = Date.now()): boolean {
  if (!codexAccountUsesCreditsAfterLimit(policy, accountId)) return false;
  const quota = getAccountQuota(accountId);
  const credits = quota?.credits;
  // Only parser-proven unavailable null is re-observable. Legacy null and known
  // vetoes remain conservative; unlimited overrides balance, never an explicit veto.
  if (credits === null) return quota?.creditObservationUnavailable === true;
  if (credits?.allowed === false || credits?.overageLimitReached === true
    || credits?.hasCredits === false || (credits?.unlimited !== true && typeof credits?.balance === "number"
      && Number.isFinite(credits.balance) && credits.balance <= 0)) return false;
  return !hasSpendableCodexCredits({ credits }, now);
}

/** Use the same live policy/override as the context's admission check. */
export function poolContextCreditRecoveryNeeded(context: PoolContext, override?: PoolCreditPolicyConfig): boolean {
  const policy = override ?? policies.get(context)?.policy;
  return !!policy && poolCreditRecoveryNeeded(policy, context.accountId);
}

/** Retry advice observes both applicable holds without changing routing's health precedence. */
export function poolCreditRecoveryRetryAt(
  accountId: string, resetAt: number, quotaScope?: CodexQuotaScope, now = Date.now(),
): number {
  const scopedUntil = quotaScope ? scopedHealthFor(accountId, quotaScope)?.cooldownUntil : undefined;
  const liveScopedUntil = typeof scopedUntil === "number" && Number.isFinite(scopedUntil) && scopedUntil > now
    ? scopedUntil : 0;
  return Math.max(Math.min(resetAt, now + nextQuotaQueryDelay()),
    getCodexAccountCooldownUntil(accountId, now) ?? 0, liveScopedUntil);
}

export type PoolUnavailableHorizon =
  | { kind: "failure-window"; accountId: string; lapsesAt: number }
  | { kind: "credit-recheck"; accountId: string; resetAt: number; retryAt: number }
  | { kind: "exhausted"; accountId: string; resetAt: number; mainNeedsSignIn: boolean };

/**
 * Explain the existing no-capacity decision without depending on authentication error classes.
 * `isUsable` names the seats whose credential can actually serve a turn: a seat that needs
 * sign-in is not "held for credits", so it must answer the credential 401 rather than a quota
 * 429 whose reset would not help. `main.recoveryAt` is the usable main login's own hold end, so
 * a shorter main hold is not hidden behind a pool seat's later reset.
 */
export function poolUnavailableUntilKnownHorizon(
  policy: PoolCreditPolicyConfig & Pick<OcxConfig, "pausedCodexAccountIds">,
  catalog: OcxConfig,
  now: number,
  main: { candidate: boolean; needsSignIn: boolean; recoveryAt?: number },
  quotaScope?: CodexQuotaScope,
  isUsable?: (accountId: string) => boolean,
): PoolUnavailableHorizon | undefined {
  let hold: { accountId: string; resetAt: number } | undefined;
  let lapse: { accountId: string; lapsesAt: number } | undefined;
  let unheld = false;
  // A credits-allowed seat held only because its credit reading went stale serves again after
  // the next reading, so it answers the short recheck retry, never the included reset days away.
  let recheck: { accountId: string; resetAt: number; retryAt: number } | undefined;
  const noteLapse = (accountId: string): void => {
    const lapsesAt = failureWindowSteeringEndsAt(catalog, accountId, now);
    if (lapsesAt !== undefined && (!lapse || lapsesAt < lapse.lapsesAt)) lapse = { accountId, lapsesAt };
  };
  for (const account of catalog.codexAccounts ?? []) {
    if (!isSelectableCodexPoolAccount(account) || policy.pausedCodexAccountIds?.includes(account.id)) continue;
    // A seat whose credential is unusable is not held for credits: it must answer the
    // credential 401, not the quota 429. Treat it as unheld so the caller falls through to
    // the credential check instead of reporting a reset that will not help.
    if (isUsable && !isUsable(account.id)) { unheld = true; continue; }
    const resetAt = poolCreditHoldResetAt(policy, account.id, catalog);
    if (resetAt !== undefined) {
      if (!hold || resetAt < hold.resetAt) hold = { accountId: account.id, resetAt };
      if (poolCreditRecoveryNeeded(policy, account.id)) {
        const retryAt = poolCreditRecoveryRetryAt(account.id, resetAt, quotaScope, now);
        if (!recheck || retryAt < recheck.retryAt) recheck = { accountId: account.id, resetAt, retryAt };
      }
      continue;
    }
    unheld = true;
    noteLapse(account.id);
  }
  // Main is a first-class rotation candidate outside `codexAccounts`; its policy holds already
  // threw above, so only its failure-window exclusion can make this wait short.
  if (main.candidate) noteLapse(MAIN_CODEX_ACCOUNT_ID);
  if (lapse) return { kind: "failure-window", ...lapse };
  // Only when the recheck is the soonest way back: another seat's earlier reset, or a recheck
  // held to its own reset by a cooldown, keeps the usage_limit_reached answer.
  if (recheck && !unheld && !main.needsSignIn && hold && recheck.retryAt < hold.resetAt) {
    return { kind: "credit-recheck", ...recheck };
  }
  if (hold && !unheld) {
    // A usable main login's own hold can end before the pool seat's reset; report the sooner
    // one so the client is not told to wait past a seat that will serve again first.
    if (main.recoveryAt !== undefined && main.recoveryAt < hold.resetAt) {
      return { kind: "exhausted", accountId: MAIN_CODEX_ACCOUNT_ID, resetAt: main.recoveryAt, mainNeedsSignIn: main.needsSignIn };
    }
    return { kind: "exhausted", ...hold, mainNeedsSignIn: main.needsSignIn };
  }
  return undefined;
}
