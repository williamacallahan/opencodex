import { createHash, timingSafeEqual } from "node:crypto";
import { authorizationCredential } from "../lib/authorization-scheme";
import { extractAccountId, extractEmail } from "../oauth/chatgpt";
import type { OcxConfig } from "../types";
import { getCodexAccountCredential } from "./account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { callerMatchesObservedMain } from "./request-owned-main-pin";
import { nativeUserIdClaims } from "./reserve-availability";

/** Constant-time digest comparison so bearer bytes never drive branch timing. */
function sameCredentialMaterial(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/**
 * The early-cooldown caller-main fallback must not resurrect the subscription that is cooling
 * down. Fail closed on ambiguity: an unreadable caller identity cannot be distinguished from the
 * cooled account. A distinct workspace account id is always safe; an exact materialized
 * bearer + account tuple marks the same subscription. Beyond that, the stable native user id is
 * the strongest available evidence: it survives an email change and a token rotation, and it
 * separates members who share one workspace account id even when neither credential carries an
 * email. Email remains the fallback when no comparable user id exists on both sides. Coexisting
 * personal/business registrations with the same email and account id over-deny during the
 * cooldown — the safe direction.
 */
export function callerIsCooledPoolAccount(headers: Headers, config: OcxConfig, accountId: string): boolean {
  const bearer = authorizationCredential(headers);
  if (!bearer) return true;
  const callerAccountId = headers.get("chatgpt-account-id") ?? extractAccountId(undefined, bearer);
  if (callerAccountId === undefined) return true;
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    // No physical-main read to identify the caller: the observed-main equality tag suffices.
    return callerMatchesObservedMain(headers);
  }
  const stored = getCodexAccountCredential(accountId);
  const entry = config.codexAccounts?.find(account => account.id === accountId);
  const cooledAccountId = stored?.chatgptAccountId || entry?.chatgptAccountId;
  if (!cooledAccountId) return true;
  if (cooledAccountId !== callerAccountId) return false;
  if (stored?.accessToken && sameCredentialMaterial(bearer, stored.accessToken)) return true;
  // Same namespace on both sides, never `sub`: this is the ChatGPT per-user identity the reserve
  // path already trusts. A credential whose own two encodings of it disagree cannot identify
  // anyone, so it fails closed even when the disagreement is on the stored side.
  const callerUser = nativeUserIdClaims(bearer);
  const cooledUser = stored?.accessToken
    ? nativeUserIdClaims(stored.accessToken)
    : { userId: undefined, conflict: false };
  if (callerUser.conflict || cooledUser.conflict) return true;
  if (callerUser.userId !== undefined && cooledUser.userId !== undefined) {
    return callerUser.userId === cooledUser.userId;
  }
  const callerEmail = extractEmail(undefined, bearer)?.trim().toLowerCase() || undefined;
  const cooledEmail = entry?.email?.trim().toLowerCase() || undefined;
  if (callerEmail !== undefined && cooledEmail !== undefined) return callerEmail === cooledEmail;
  return true;
}

