/**
 * Which pooled Antigravity account serves one `agy` request on the pass-through lane.
 *
 * The request body is never rewritten, so the account must match what the body already says.
 * Every Cloud Code call except `loadCodeAssist` and `writeTrajectoryAcls` names a `project`, so a
 * project-bearing call goes to an account that owns it. Google can hand several accounts the same
 * project (two pooled Antigravity sign-ins measured on 2026-11-22 shared one), so among owners the
 * caller's own account wins. A caller with no account yet (a restart, or agy refreshing its own
 * token about hourly) takes the next owner in rotation that is not cooling down, so new callers
 * spread across owners instead of all landing on the first one. A project-less
 * call keeps the account this caller last used. Only `loadCodeAssist` (agy's per-turn "which project
 * am I?" call) may move a caller off a cooling account; that answer hands agy the new account's
 * project, so every later body matches the token the hub sends with it. A `writeTrajectoryAcls`
 * stays on the caller's account even while it cools, because the trajectory lives there.
 *
 * Project ownership comes from the stored credential and from the project Google returned on a
 * `loadCodeAssist` this lane relayed; a learned project is written back to the stored credential.
 * Caller identity is a digest; the token itself is never stored. The caller map is process-local:
 * a restart forgets it, and agy's next `loadCodeAssist` rebuilds it.
 */
import { randomInt } from "node:crypto";
import { credentialGeneration, listAccounts, mergeAccountCredential } from "../oauth/store";
import { eligibleFailoverAccounts, genericFailoverRetryAfterSeconds } from "../oauth/generic-account-failover";
import { ANTIGRAVITY_OAUTH_STORE_KEY } from "../providers/antigravity-quota-identity";
import { getCachedProviderAccountQuota } from "../providers/quota/account-cache";

const CALLER_AFFINITY_LIMIT = 1024;
const CALLER_AFFINITY_TTL_MS = 6 * 60 * 60_000;
/**
 * At a turn boundary a caller moves to another account only when that one is at least this many
 * percentage points less used, so two nearly equal accounts do not trade the caller every turn.
 * ponytail: fixed margin; becomes a setting if an operator needs to tune it.
 */
const BALANCE_MARGIN_PERCENT = 10;

const learnedProjects = new Map<string, string>();
const callerAccounts = new Map<string, { accountId: string; at: number }>();
// A random start spreads callers after a restart instead of sending the first one to account zero.
let rotationCursor = randomInt(1_000_000);

export type AgyAccountChoice =
  | { kind: "account"; accountId: string }
  | { kind: "project-unowned" }
  | { kind: "project-account-unavailable" }
  | { kind: "pool-empty" }
  | { kind: "pool-exhausted"; retryAfterSeconds: number | null };

export interface AgyAccountRequest {
  readonly project: string | undefined;
  readonly callerKey: string;
  /** True only for `loadCodeAssist`: the one call after which agy re-reads its project. */
  readonly mayRotate: boolean;
}

function rememberCaller(callerKey: string, accountId: string, now: number): void {
  callerAccounts.delete(callerKey);
  callerAccounts.set(callerKey, { accountId, at: now });
  while (callerAccounts.size > CALLER_AFFINITY_LIMIT) {
    const oldest = callerAccounts.keys().next().value;
    if (oldest === undefined) break;
    callerAccounts.delete(oldest);
  }
}

/**
 * An account's most-used current Gem or Cla window, from agy's own quota readings of the last six
 * hours (the routing horizon of `getCachedProviderAccountQuota`). An account with no recent reading
 * counts as unused, so it is chosen, and agy's next quota call reads it.
 */
function bindingUsage(accountId: string, now: number): number {
  const windows = getCachedProviderAccountQuota(ANTIGRAVITY_OAUTH_STORE_KEY, accountId)?.customWindows ?? [];
  return windows.reduce((most, window) => window.modelId === undefined && (window.resetAt === undefined || window.resetAt > now)
    ? Math.max(most, window.percent) : most, 0);
}

/** The least-used of `candidates`; equally used accounts take turns. */
function leastUsed(candidates: readonly string[], now: number): string | undefined {
  if (candidates.length === 0) return undefined;
  const start = rotationCursor % candidates.length;
  rotationCursor = (rotationCursor + 1) % Number.MAX_SAFE_INTEGER;
  const turn = [...candidates.slice(start), ...candidates.slice(0, start)];
  return turn.reduce((best, id) => bindingUsage(id, now) < bindingUsage(best, now) ? id : best);
}

export function chooseAgyAccount(request: AgyAccountRequest, now = Date.now()): AgyAccountChoice {
  const roster = listAccounts(ANTIGRAVITY_OAUTH_STORE_KEY);
  if (roster.length === 0) return { kind: "pool-empty" };
  const usable = (accountId: string) => roster.some(row => row.id === accountId && row.paused !== true && row.needsReauth !== true);
  if (request.project !== undefined) {
    const owners = roster.filter(row => (learnedProjects.get(row.id) ?? row.credential?.projectId) === request.project);
    if (owners.length === 0) return { kind: "project-unowned" };
    const callerAccount = callerAccounts.get(request.callerKey)?.accountId;
    const nextOwner = () => {
      const id = leastUsed(eligibleFailoverAccounts(ANTIGRAVITY_OAUTH_STORE_KEY, now).filter(id => owners.some(row => row.id === id)), now);
      return owners.find(row => row.id === id) ?? owners.find(row => usable(row.id));
    };
    const owner = owners.find(row => row.id === callerAccount && usable(row.id)) ?? nextOwner();
    if (!owner) return { kind: "project-account-unavailable" };
    rememberCaller(request.callerKey, owner.id, now);
    return { kind: "account", accountId: owner.id };
  }
  const eligible = eligibleFailoverAccounts(ANTIGRAVITY_OAUTH_STORE_KEY, now);
  const previous = callerAccounts.get(request.callerKey);
  if (previous && now - previous.at < CALLER_AFFINITY_TTL_MS
    && (request.mayRotate ? eligible.includes(previous.accountId) : usable(previous.accountId))) {
    // A turn boundary (`loadCodeAssist`) is where agy learns its project, so the caller may move to
    // a clearly less-used account there; every other call stays on the caller's account.
    const better = request.mayRotate ? leastUsed(eligible.filter(id => id !== previous.accountId), now) : undefined;
    const accountId = better !== undefined
      && bindingUsage(previous.accountId, now) - bindingUsage(better, now) >= BALANCE_MARGIN_PERCENT ? better : previous.accountId;
    rememberCaller(request.callerKey, accountId, now);
    return { kind: "account", accountId };
  }
  const accountId = leastUsed(eligible, now);
  if (accountId === undefined) {
    return { kind: "pool-exhausted", retryAfterSeconds: genericFailoverRetryAfterSeconds(ANTIGRAVITY_OAUTH_STORE_KEY, now) };
  }
  rememberCaller(request.callerKey, accountId, now);
  return { kind: "account", accountId };
}

/** Record the project Google returned to this account on a relayed `loadCodeAssist`, and store it. */
export function learnAgyAccountProject(accountId: string, project: string): void {
  learnedProjects.set(accountId, project);
  const account = listAccounts(ANTIGRAVITY_OAUTH_STORE_KEY).find(row => row.id === accountId);
  if (!account?.credential || account.credential.projectId === project) return;
  void mergeAccountCredential(ANTIGRAVITY_OAUTH_STORE_KEY, accountId, { ...account.credential, projectId: project },
    { expectedGeneration: credentialGeneration(account.credential) }).catch(() => {
    // The in-memory ownership still serves this process; the next relayed answer retries the write.
  });
}

/** Test seam: forget process-local ownership and affinity. */
export function resetAgyAccountState(): void {
  learnedProjects.clear();
  callerAccounts.clear();
  rotationCursor = 0;
}
