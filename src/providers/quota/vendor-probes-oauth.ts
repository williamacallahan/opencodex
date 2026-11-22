import { effectiveCodexAuthAccountId, fetchMainAccountInfoSnapshot, listCodexAuthAccountsSnapshot } from "../../codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../../codex/main-account";
import { loadConfig } from "../../config";
import { configuredAnthropicInstance } from "../anthropic-instance";
import { isAnthropicPoolEnabledFor } from "../../oauth/anthropic-pool-config";
import { credentialGeneration, getAccountCredential, getAccountSet } from "../../oauth/store";
import { hydrateKiroAccountState, persistKiroAccountState } from "../kiro-account-state-disk";
import { kiroProbeCurrent, kiroProbeIdentity } from "./kiro-account-probe";
import { fetchMuseKeyQuotaSnapshot } from "../muse-key-quota";
import { probeAnthropicUsageQuota, type AnthropicUsageProbe } from "../claude-cli-usage";
import { claudeSignedInIdentity, peekClaudeUsageObservation } from "../claude-cli-usage-state";
import { XAI_GROK_CLIENT_VERSION, XAI_GROK_COMPATIBILITY } from "../xai-transport";
import {
  commitKiroAccountUsageState,
  fetchKiroUsageSnapshot,
  type KiroUsageSnapshot,
  kiroUsageContextForAccount,
} from "../kiro-usage";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import { aggregateCodexPoolCapacity, CODEX_CAPACITY_MAX_QUOTA_AGE_MS, type CodexCapacityQuota } from "../codex-capacity";
import { asRecord, normalizePercent, normalizeResetAt, readQuotaJson, REQUEST_TIMEOUT_MS, toFiniteNumber } from "../quota-wire";
import { providerCodexAccountMode } from "../registry";
import {
  accountReportCurrent, observedQuotaFor,
  AUTHORITATIVE_EMPTY_QUOTA,
  TERMINAL_QUOTA_FAILURE,
  providerLabel,
  providerQuotaFromCodexQuota,
  publicCapacityAggregation,
  report,
  tagNativeMainReport,
  type CodexAuthAccountsSnapshotPromise,
  type ProviderQuotaProbeResult,
  type ProviderQuotaReport,
} from "./report-cache";
import {
  accountCacheKey,
  captureProviderAccountQuotaEpoch,
  accountQuotaCache,
  getCachedProviderAccountQuota,
  hydrateAccountQuotaCache,
  mayCommitAccountQuotaKey,
  persistAccountQuotaCache,
} from "./account-cache";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import type { ProviderQuota, ProviderQuotaWindow } from "../quota-types";
import { mapQuotaRoster } from "../quota-key-accounts";
import { fetchAnthropicAccountQuota } from "./anthropic-account-quota";
import type { AnthropicInstanceId } from "../anthropic-instance-id";

const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const XAI_CREDITS_URL = `${XAI_BILLING_URL}?format=credits`;

export async function fetchChatGptForwardQuota(
  config: OcxConfig,
  provider: string,
  providerConfig: OcxProviderConfig,
  forceRefresh: boolean,
  prefetchedSnapshot?: CodexAuthAccountsSnapshotPromise,
): Promise<ProviderQuotaProbeResult> {
  if (providerCodexAccountMode(provider, providerConfig) === "direct") {
    const snapshot = await fetchMainAccountInfoSnapshot(forceRefresh, config);
    // A parsed return from a replaced credential cannot retain an older cached report either.
    if (snapshot.infoUnpublished) return TERMINAL_QUOTA_FAILURE;
    const quota = providerQuotaFromCodexQuota(snapshot.info.quota);
    if (quota) quota.updatedAt = Date.now();
    return quota
      ? tagNativeMainReport(report(provider, "chatgpt:wham", quota), snapshot.mainIdentityGeneration)
      : null;
  }
  const snapshot = await (prefetchedSnapshot ?? listCodexAuthAccountsSnapshot(config, forceRefresh));
  const accounts = snapshot.accounts;
  const activeId = effectiveCodexAuthAccountId(config);
  const capacityAccounts = accounts.map(account => ({
    ...account,
    active: account.id === activeId,
    quota: providerQuotaFromCodexQuota(account.quota),
  }));
  const active = capacityAccounts.find(account => account.active)
    ?? capacityAccounts.find(account => account.id === MAIN_CODEX_ACCOUNT_ID)
    ?? capacityAccounts[0];
  const now = Date.now();
  const capacity = aggregateCodexPoolCapacity(capacityAccounts, now);
  if (capacity.aggregation && capacity.quota) {
    return tagNativeMainReport(
      report(
        provider,
        "chatgpt:wham",
        capacity.quota as ProviderQuota,
        publicCapacityAggregation(capacity.aggregation, "aggregate"),
      ),
      snapshot.mainIdentityGeneration,
    );
  }
  const activeUsable = !!active && !active.paused && active.needsReauth !== true;
  const quota = activeUsable && active?.quota
    ? { ...active.quota, updatedAt: active.quota.updatedAt ?? Date.now() } as CodexCapacityQuota
    : null;
  const quotaFresh = !!quota
    && Number.isFinite(quota.updatedAt)
    && now - quota.updatedAt < CODEX_CAPACITY_MAX_QUOTA_AGE_MS;
  if (quota && quotaFresh) {
    const fallback = report(
      provider,
      "chatgpt:wham",
      quota as ProviderQuota,
      capacity.aggregation
        ? publicCapacityAggregation(capacity.aggregation, "effective-account-fallback")
        : undefined,
    );
    return tagNativeMainReport(fallback, snapshot.mainIdentityGeneration);
  }
  if (capacity.aggregation) {
    const updatedAt = Date.now();
    return tagNativeMainReport(
      {
        provider,
        label: providerLabel(provider),
        source: "chatgpt:wham",
        quota: { updatedAt },
        updatedAt,
        aggregation: publicCapacityAggregation(capacity.aggregation, "coverage-only"),
      },
      snapshot.mainIdentityGeneration,
    );
  }
  return null;
}

function centsValue(value: unknown): number | undefined {
  const rec = asRecord(value);
  return rec ? toFiniteNumber(rec.val) : undefined;
}

/** Decode JWT payload `sub` for xAI weekly credits when the stored credential lacks accountId. */
function xaiUserIdFromAccessToken(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Grok Build weekly credits envelope:
 * `{ config: { creditUsagePercent?, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end } } }`.
 * Omitted percent is treated as 0 (proto3 default).
 */
export function parseXaiCreditsResponse(value: unknown): { percent: number; resetAt?: number } | null {
  const body = asRecord(value);
  const config = asRecord(body?.config);
  if (!config) return null;
  const period = asRecord(config.currentPeriod);
  if (!period || period.type !== "USAGE_PERIOD_TYPE_WEEKLY") return null;
  let percent = 0;
  if (config.creditUsagePercent !== undefined) {
    const normalized = normalizePercent(config.creditUsagePercent);
    if (normalized === undefined) return null;
    percent = normalized;
  }
  const resetAt = normalizeResetAt(period.end);
  return {
    percent,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

async function fetchXaiWeeklyCredits(accessToken: string, userId: string): Promise<ProviderQuota | null> {
  try {
    const response = await fetch(XAI_CREDITS_URL, {
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        [XAI_GROK_COMPATIBILITY.headers.tokenAuth]: "xai-grok-cli",
        [XAI_GROK_COMPATIBILITY.headers.authenticateResponse]: "authenticate-response",
        "x-userid": userId,
        [XAI_GROK_COMPATIBILITY.headers.clientVersion]: XAI_GROK_CLIENT_VERSION,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = parseXaiCreditsResponse(await readQuotaJson(response));
    if (!parsed) return null;
    return {
      weeklyPercent: parsed.percent,
      ...(parsed.resetAt !== undefined ? { weeklyResetAt: parsed.resetAt } : {}),
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function fetchXaiQuota(provider: string, context: { accessToken: string; upstreamAccountId?: string }): Promise<ProviderQuotaReport | null> {
  const { accessToken } = context;

  // Prefer the SuperGrok weekly credits window that actually gates prompting (#1283).
  const userId = context.upstreamAccountId?.trim() || xaiUserIdFromAccessToken(accessToken);
  if (userId) {
    const weekly = await fetchXaiWeeklyCredits(accessToken, userId);
    if (weekly) return report(provider, "xai:grok-billing-credits", weekly);
  }

  // Legacy monthly dollar pool — retained when weekly is unavailable.
  try {
    const response = await fetch(XAI_BILLING_URL, {
      redirect: "error",
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = asRecord(await readQuotaJson(response));
    const config = asRecord(body?.config);
    if (!config) return null;
    const limitCents = centsValue(config.monthlyLimit);
    const usedCents = centsValue(config.used);
    if (limitCents === undefined || usedCents === undefined || limitCents <= 0) return null;
    const percent = normalizePercent((usedCents / limitCents) * 100);
    if (percent === undefined) return null;
    return report(provider, "xai:grok-billing", {
      monthlyPercent: percent,
      monthlyResetAt: normalizeResetAt(config.billingPeriodEnd),
      updatedAt: Date.now(),
    });
  } catch {
    return null;
  }
}

const anthropicUsageInflight = new Map<string, Promise<AnthropicUsageProbe>>();

/**
 * Anthropic per-credential usage.
 *
 * This endpoint reports quota only. Its body carries `five_hour`, `seven_day`, the
 * model-scoped weekly buckets (`seven_day_fable`/`_opus`/`_sonnet`) and a `limits` array,
 * and **no subscription or tier field** — nor does the OAuth token response, which yields only
 * `account.uuid` and `account.email_address` (`src/oauth/anthropic.ts`). Subscription labels
 * instead come from the authenticated profile in `src/oauth/anthropic-identity.ts`, never
 * from this quota response.
 *
 * A tier must not be inferred from what is here. Percentages are normalized per account, so a
 * Max x5 seat at 50% is byte-identical to a Max x20 seat at 50%, and the presence of a
 * model-scoped window tracks entitlement rather than seat size. Populate `plan` only when
 * upstream returns the tier itself.
 */
export async function fetchAnthropicUsageQuota(
  accessToken: string,
  requireFreshDispatch = false,
): Promise<ProviderQuota | null> {
  return fetchAnthropicUsageQuotaForInstance("anthropic", accessToken, requireFreshDispatch);
}

export async function fetchAnthropicUsageQuotaForInstance(
  instance: AnthropicInstanceId,
  accessToken: string,
  requireFreshDispatch = false,
): Promise<ProviderQuota | null> {
  return (await fetchAnthropicUsageProbeForInstance(instance, accessToken, requireFreshDispatch)).quota;
}

/** The same shared flight as `fetchAnthropicUsageQuotaForInstance`, keeping the closed failure reason. */
export async function fetchAnthropicUsageProbeForInstance(
  instance: AnthropicInstanceId,
  accessToken: string,
  requireFreshDispatch = false,
): Promise<AnthropicUsageProbe> {
  // Recovery evidence must be requested after the claimed cooldown. Joining an older request
  // can return after the 429 while still describing provider state from before that refusal.
  const credentialIdentity = getAccountSet(instance)?.accounts.filter(row => row.credential.access === accessToken)
    .map(row => [row.id, row.loginId, row.addedAt, credentialGeneration(row.credential), row.pauseRevision]);
  const key = `${instance}\0${captureProviderAccountQuotaEpoch(instance)}\0${JSON.stringify(credentialIdentity)}\0${accessToken}`;
  const joinable = requireFreshDispatch ? undefined : anthropicUsageInflight.get(key);
  if (joinable) return joinable;

  const probe = probeAnthropicUsageQuota(accessToken).finally(() => {
    if (anthropicUsageInflight.get(key) === probe) anthropicUsageInflight.delete(key);
  });
  anthropicUsageInflight.set(key, probe);
  return probe;
}

/** `config` is the caller's live object; currency re-reads it instead of reloading the file. */
export async function fetchAnthropicQuota(
  provider: string, config: OcxConfig = loadConfig(), force = false, resetPoll = false,
): Promise<ProviderQuotaReport | null> {
  const instance = configuredAnthropicInstance(config, provider);
  const target = config.providers[provider];
  if (!instance || target?.disabled || target && target.authMode !== "oauth") return null;
  const targetIdentity = JSON.stringify(target);
  const targetCurrent = () => configuredAnthropicInstance(config, provider) === instance
    && JSON.stringify(config.providers[provider]) === targetIdentity;
  const epoch = captureProviderAccountQuotaEpoch(instance);
  const poolEnabled = isAnthropicPoolEnabledFor(config, instance);
  const initial = getAccountSet(instance);
  if (!initial?.accounts.length) return null;
  const scopeCurrent = () => targetCurrent() && epoch === captureProviderAccountQuotaEpoch(instance)
    && poolEnabled === isAnthropicPoolEnabledFor(config, instance);
  hydrateAccountQuotaCache();
  const nowAtStart = Date.now();
  const eligible = initial.accounts.filter(row => !row.paused && !row.needsReauth
    && (poolEnabled || row.id === initial.activeAccountId));
  const eligibleAtStart = new Map(eligible.map(row => [row.id, row]));
  const accountsToRead = eligible.filter(row => !resetPoll || row.id === initial.activeAccountId)
    .map(row => ({ row, age: nowAtStart - (getCachedProviderAccountQuota(instance, row.id)?.updatedAt ?? 0) }))
    .sort((a, b) => Number(b.row.id === initial.activeAccountId) - Number(a.row.id === initial.activeAccountId) || b.age - a.age);
  // The dashboard and account endpoints share each seat's cached reading and in-flight probe.
  // Bound the whole wait: a large pool must not block every other provider's report.
  let deadlineReached = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeProbeSucceeded = false;
  try {
    await Promise.race([
      mapQuotaRoster(accountsToRead, async ({ row }) => {
        if (deadlineReached || !scopeCurrent()) return;
        const reading = await fetchAnthropicAccountQuota(instance, row.id, force, config);
        if (row.id === initial.activeAccountId) {
          activeProbeSucceeded = !reading.unavailable && reading.isCurrent?.() !== false && !!reading.quota;
        }
      }),
      new Promise<void>(resolve => {
        timer = setTimeout(() => { deadlineReached = true; resolve(); }, 2 * REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!scopeCurrent()) return null;
  const roster = getAccountSet(instance);
  if (!roster?.accounts.length) return null;
  const pooled = poolEnabled && roster.accounts.length > 1;
  const belongsToBatch = (row: (typeof roster.accounts)[number]) => {
    const started = eligibleAtStart.get(row.id);
    return started?.loginId === row.loginId && started?.addedAt === row.addedAt
      && started?.pauseRevision === row.pauseRevision;
  };
  if (roster.accounts.some(row => !row.paused && !row.needsReauth
    && (pooled || row.id === roster.activeAccountId) && !belongsToBatch(row))) return null;

  const now = Date.now();
  const rows = roster.accounts.map(row => ({
    isMain: false,
    active: row.id === roster.activeAccountId,
    weight: 1,
    paused: row.paused === true,
    needsReauth: row.needsReauth === true,
    quota: getCachedProviderAccountQuota(instance, row.id),
  }));
  const activeQuota = rows.find(row => row.active && !row.paused && !row.needsReauth)?.quota ?? null;
  const source = "anthropic:oauth-usage";
  const capacity = pooled ? aggregateCodexPoolCapacity(rows, now) : null;
  const quotaReport = capacity?.aggregation ? {
    provider,
    label: providerLabel(provider),
    source,
    quota: capacity.quota ?? { updatedAt: now },
    updatedAt: capacity.quota?.updatedAt ?? now,
    aggregation: publicCapacityAggregation(capacity.aggregation, capacity.quota ? "aggregate" : "coverage-only"),
  } : activeQuota && now - activeQuota.updatedAt < CODEX_CAPACITY_MAX_QUOTA_AGE_MS
    ? report(provider, source, activeQuota) : null;
  if (!quotaReport) return null;
  // The pool estimate must never become the reset detector's reading of its active account.
  if (pooled || !activeProbeSucceeded) {
    observedQuotaFor.set(quotaReport, activeProbeSucceeded && roster.activeAccountId === initial.activeAccountId
      ? activeQuota ?? { updatedAt: now } : { updatedAt: now });
  }
  const rosterIdentity = (set: NonNullable<typeof roster>) => JSON.stringify([set.activeAccountId,
    set.accounts.map(row => [row.id, row.paused === true, row.needsReauth === true, row.pauseRevision, credentialGeneration(row.credential)])]);
  const identity = rosterIdentity(roster);
  const quotaEvidence = (quota: ProviderQuota | null, at: number) => {
    if (!quota) return null;
    const { updatedAt, ...windows } = quota;
    return JSON.stringify([at - updatedAt < CODEX_CAPACITY_MAX_QUOTA_AGE_MS, windows]);
  };
  const evidence = roster.accounts.flatMap((row, index) =>
    !row.paused && !row.needsReauth && (pooled || row.id === roster.activeAccountId)
      ? [{ id: row.id, quota: quotaEvidence(rows[index]?.quota ?? null, now) }] : []);
  accountReportCurrent.set(quotaReport, () => {
    const current = getAccountSet(instance);
    const checkedAt = Date.now();
    return !!current && scopeCurrent() && rosterIdentity(current) === identity
      && evidence.every(({ id, quota }) => quotaEvidence(getCachedProviderAccountQuota(instance, id), checkedAt) === quota);
  });
  return quotaReport;
}

/**
 * Provider-level Kiro row: the active account's usage, shown on the Providers page.
 *
 * The per-account cache is seeded from the same probe so opening that page does not read
 * the active account twice, and the account id is captured before the await so a
 * concurrent account switch cannot file this answer under the wrong account.
 */
export async function fetchKiroQuota(provider: string): Promise<ProviderQuotaReport | null> {
  hydrateKiroAccountState();
  const probedAccountId = getAccountSet("kiro")?.activeAccountId;
  if (!probedAccountId) return null;
  const identity = kiroProbeIdentity(probedAccountId);
  const probedAccountKey = accountCacheKey("kiro", probedAccountId);
  const writerGeneration = captureConfigGeneration();
  let snapshot: KiroUsageSnapshot | null;
  try {
    snapshot = await fetchKiroUsageSnapshot(await kiroUsageContextForAccount(probedAccountId));
  } catch {
    return null;
  }
  if (!snapshot) return null;
  if (!kiroProbeCurrent(probedAccountId, identity)) return null;
  if (mayCommitAccountQuotaKey(probedAccountKey, writerGeneration)) {
    accountQuotaCache.set(probedAccountKey, { ts: Date.now(), quota: snapshot.quota, identity });
    commitKiroAccountUsageState(probedAccountKey, snapshot, identity);
    persistKiroAccountState();
  }
  return report(provider, "kiro:usage-limits", snapshot.quota);
}

/**
 * Provider-level row probed from the key endpoint, for an account that CAN be probed.
 *
 * Written through the same account cache the passive path reads, so the measurement
 * survives a restart and the per-account rows at oauth-account-routes.ts:313 pick it up
 * with no mode change. Deliberately does not flip providerOAuthAccountQuotaMode: that
 * mode selects readPassiveProviderAccountQuotas, and the probed per-account path it would
 * switch to is gated on supportsPerAccountQuota, which has no meta-muse reader, so the
 * GUI account list would go from showing observations to showing nothing.
 */
export async function fetchMuseKeyQuota(provider: string): Promise<ProviderQuotaReport | null> {
  const probedAccountId = getAccountSet(provider)?.activeAccountId;
  if (!probedAccountId) return null;
  // A paused account is excluded from every automatic upstream use; a key mint is one.
  if (getAccountSet(provider)?.accounts.find(account => account.id === probedAccountId)?.paused === true) return null;
  const oauthAccessToken = getAccountCredential(provider, probedAccountId)?.muse?.oauthAccessToken;
  // An imported or pasted credential has no account token and never will: it is
  // capability, not provider id, that decides whether a probe is possible.
  if (!oauthAccessToken) return null;
  const probedAccountKey = accountCacheKey(provider, probedAccountId);
  const writerGeneration = captureConfigGeneration();
  const quota = await fetchMuseKeyQuotaSnapshot(probedAccountId, oauthAccessToken);
  if (!quota) return null;
  if (mayCommitAccountQuotaKey(probedAccountKey, writerGeneration)) {
    // Hydrate before writing, for the same reason recordPassiveAccountQuota does:
    // persistAccountQuotaCache serializes the whole in-memory map.
    hydrateAccountQuotaCache();
    accountQuotaCache.set(probedAccountKey, { ts: Date.now(), quota });
    persistAccountQuotaCache();
  }
  return report(provider, `${provider}:key-endpoint`, quota);
}
/**
 * Provider-level row for a passive provider: the ACTIVE account's last observed
 * subscription windows, the same shape `fetchAnthropicQuota` and `fetchKiroQuota`
 * return.
 *
 * Cache-only. A dashboard load or `ocx account refresh` must never spend an inference
 * turn, so `forceRefresh` does not exist on this path — there is nothing to refresh.
 * `report.updatedAt` is the observation time, which is what both GUI surfaces render
 * as the relative age of the row.
 */
export async function fetchPassiveProviderQuota(provider: string): Promise<ProviderQuotaReport | null> {
  const activeId = getAccountSet(provider)?.activeAccountId;
  if (!activeId) return null;
  // Idempotent; without it a proxy restart shows nothing until the next streaming turn
  // even though the last observation is on disk.
  hydrateAccountQuotaCache();
  const entry = accountQuotaCache.get(accountCacheKey(provider, activeId));
  if (!entry?.quota) return null;
  const built = report(provider, `${provider}:subscription-observation`, entry.quota);
  // Tagged here rather than inside report(), which every probed path shares.
  return built ? { ...built, observed: true } : null;
}

/**
 * Provider-level row for the Claude Code CLI subscription: the signed-in account's last usage the
 * admission recorded, in the same shape `fetchPassiveProviderQuota` returns.
 *
 * Cache-only. OpenCodex stores no Claude credential and this path must never spawn the CLI or
 * probe an endpoint on a dashboard load; the admission already reads Anthropic's usage endpoint
 * before a launch. A forced quota refresh re-reads the local sign-in and this snapshot, not the
 * upstream. `updatedAt` stays the observation time, which is the age the quota card renders.
 *
 * The row belongs to one account. Signed out, an unreadable sign-in, or a sign-in with no recorded
 * snapshot is authoritative empty, which clears another account's cached row. A cached row stops
 * being current as soon as any later sign-in read (a turn's admission included) names another account.
 */
export async function fetchClaudeCliObservedQuota(provider: string, forceRefresh: boolean): Promise<ProviderQuotaProbeResult> {
  // Lazy: the adapter's sign-in reader (Keychain, child process) stays off the core request path.
  const { currentClaudeIdentityKey } = await import("../../adapters/claude-cli/usage-admission");
  await currentClaudeIdentityKey(forceRefresh);
  return heldClaudeCliObservedQuota(provider);
}

/** Resolve against the latest recorded identity without accessing credentials or probing. */
export function heldClaudeCliObservedQuota(provider: string): ProviderQuotaProbeResult {
  const identity = claudeSignedInIdentity();
  if (!identity) return AUTHORITATIVE_EMPTY_QUOTA;
  const observation = peekClaudeUsageObservation({ identity });
  if (!observation?.quota) return AUTHORITATIVE_EMPTY_QUOTA;
  const built = report(provider, `${provider}:subscription-observation`, observation.quota);
  if (!built) return AUTHORITATIVE_EMPTY_QUOTA;
  // Tagged here rather than inside report(), which every probed path shares.
  const row = { ...built, observed: true };
  accountReportCurrent.set(row, () => claudeSignedInIdentity() === identity);
  return row;
}

/** Refresh only Claude CLI rows in a held response; other providers keep their cached readings. */
export function refreshHeldClaudeCliReports(config: OcxConfig, reports: ProviderQuotaReport[]): ProviderQuotaReport[] {
  const claude = Object.entries(config.providers).filter(([, provider]) => provider.adapter === "claude-cli" && provider.disabled !== true);
  if (!claude.length) return reports;
  const names = new Set(claude.map(([name]) => name));
  const current = claude.map(([name]) => heldClaudeCliObservedQuota(name))
    .filter((item): item is ProviderQuotaReport => item !== null && item !== TERMINAL_QUOTA_FAILURE && item !== AUTHORITATIVE_EMPTY_QUOTA);
  return [...reports.filter(item => !names.has(item.provider)), ...current];
}

/**
 * Before the provider-report cache fast path: re-read the Claude Code sign-in (the admission's
 * one-minute identity cache bounds this to one Keychain read a minute), so a cached Claude CLI
 * row stops being current within a minute of a sign-out or account switch. Returns undefined when
 * no Claude CLI provider is enabled: awaiting even a resolved promise would add a tick to every
 * other read and reorder its in-flight join.
 */
export function refreshClaudeCliSignIn(config: OcxConfig): Promise<unknown> | undefined {
  if (!Object.values(config.providers).some(provider => provider.adapter === "claude-cli" && provider.disabled !== true)) return undefined;
  // Lazy: the adapter's sign-in reader (Keychain, child process) stays off the core request path.
  return import("../../adapters/claude-cli/usage-admission").then(admission => admission.currentClaudeIdentityKey());
}

// ---------------------------------------------------------------------------
// Per-account quota (multiauth)
// ---------------------------------------------------------------------------


/** Cursor included usage via api2.cursor.sh (Bearer from OAuth) — unofficial, may change. */
export async function fetchCursorQuota(provider: string, accessToken: string): Promise<ProviderQuotaReport | null> {

  const authHeaders = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  } as const;

  // Prefer dashboard period usage (Pro/Team/Ultra spend allowance in USD cents).
  // Field names follow Cursor's Connect RPC shape (limit/remaining/includedSpend), not usedCents.
  try {
    const periodRes = await fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
      method: "POST",
      redirect: "error",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (periodRes.ok) {
      const body = asRecord(await readQuotaJson(periodRes));
      const planUsage = asRecord(body?.planUsage);
      if (planUsage) {
        const resetAt = normalizeResetAt(body?.billingCycleEnd ?? planUsage.billingCycleEnd ?? body?.periodEnd);

        // Primary meter: overall included allowance (Cursor Settings → Usage total %).
        // autoPercentUsed / apiPercentUsed are secondary pools and must not replace the total.
        const limit = toFiniteNumber(planUsage.limit ?? planUsage.limitCents ?? planUsage.totalLimitCents);
        const remaining = toFiniteNumber(planUsage.remaining ?? planUsage.remainingCents);
        const includedSpend = toFiniteNumber(planUsage.includedSpend ?? planUsage.usedCents ?? planUsage.used);
        const totalSpend = toFiniteNumber(planUsage.totalSpend);
        let used: number | undefined;
        if (includedSpend !== undefined) used = includedSpend;
        else if (limit !== undefined && remaining !== undefined) used = Math.max(0, limit - remaining);
        else if (totalSpend !== undefined) used = totalSpend;
        const totalPercent = normalizePercent(planUsage.totalPercentUsed ?? planUsage.percentUsed)
          ?? (limit !== undefined && limit > 0 && used !== undefined
            ? normalizePercent((used / limit) * 100)
            : undefined);

        const autoPercent = normalizePercent(planUsage.autoPercentUsed);
        const apiPercent = normalizePercent(planUsage.apiPercentUsed);
        const customWindows: ProviderQuotaWindow[] = [];
        if (autoPercent !== undefined) {
          customWindows.push({
            label: "First-party models",
            percent: autoPercent,
            ...(resetAt !== undefined ? { resetAt } : {}),
          });
        }
        if (apiPercent !== undefined) {
          customWindows.push({
            label: "API usage",
            percent: apiPercent,
            ...(resetAt !== undefined ? { resetAt } : {}),
          });
        }

        if (totalPercent !== undefined || customWindows.length > 0) {
          const built = report(provider, "cursor:period-usage", {
            ...(totalPercent !== undefined ? {
              monthlyPercent: totalPercent,
              ...(resetAt !== undefined ? { monthlyResetAt: resetAt } : {}),
            } : {}),
            ...(customWindows.length > 0 ? { customWindows } : {}),
            updatedAt: Date.now(),
          });
          if (built) return { ...built, reverseEngineered: true };
        }
      }
    }
  } catch {
    /* fall through */
  }

  // /api/usage/summary — same host, sometimes richer than /auth/usage for Team plans.
  try {
    const summaryRes = await fetch("https://api2.cursor.sh/api/usage/summary", {
      headers: authHeaders,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (summaryRes.ok) {
      const body = asRecord(await readQuotaJson(summaryRes));
      const individual = asRecord(body?.individualUsage);
      const plan = asRecord(individual?.plan);
      if (plan) {
        const used = toFiniteNumber(plan.used);
        const limit = toFiniteNumber(plan.limit);
        const percent = normalizePercent(plan.totalPercentUsed)
          ?? (used !== undefined && limit !== undefined && limit > 0
            ? normalizePercent((used / limit) * 100)
            : undefined);
        if (percent !== undefined) {
          const built = report(provider, "cursor:usage-summary", {
            monthlyPercent: percent,
            monthlyResetAt: normalizeResetAt(body?.billingCycleEnd),
            updatedAt: Date.now(),
          });
          if (built) return { ...built, reverseEngineered: true };
        }
      }
    }
  } catch {
    /* fall through to /auth/usage */
  }

  const response = await fetch("https://api2.cursor.sh/auth/usage", {
    headers: authHeaders,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await readQuotaJson(response));
  if (!body) return null;

  // Prefer the gpt-4 bucket (historical "fast requests"); else first model with used+limit.
  let used: number | undefined;
  let limit: number | undefined;
  const gpt4 = asRecord(body["gpt-4"]);
  if (gpt4) {
    used = toFiniteNumber(gpt4.numRequests ?? gpt4.used);
    limit = toFiniteNumber(gpt4.maxRequestUsage ?? gpt4.limit ?? gpt4.maxRequests);
  }
  if (used === undefined || limit === undefined || limit <= 0) {
    for (const [key, value] of Object.entries(body)) {
      if (key === "startOfMonth" || key === "billingCycleStart") continue;
      const bucket = asRecord(value);
      if (!bucket) continue;
      const bucketUsed = toFiniteNumber(bucket.numRequests ?? bucket.used);
      const bucketLimit = toFiniteNumber(bucket.maxRequestUsage ?? bucket.limit ?? bucket.maxRequests);
      if (bucketUsed !== undefined && bucketLimit !== undefined && bucketLimit > 0) {
        used = bucketUsed;
        limit = bucketLimit;
        break;
      }
    }
  }
  if (used === undefined || limit === undefined || limit <= 0) return null;
  const percent = normalizePercent((used / limit) * 100);
  if (percent === undefined) return null;
  const startOfMonth = normalizeResetAt(body.startOfMonth ?? body.billingCycleStart);
  // Next reset = same day next month, computed in UTC to avoid timezone-shifted rollover.
  const monthlyResetAt = startOfMonth !== undefined
    ? (() => {
        const start = new Date(startOfMonth);
        return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate());
      })()
    : undefined;
  const built = report(provider, "cursor:auth-usage", {
    monthlyPercent: percent,
    ...(monthlyResetAt !== undefined ? { monthlyResetAt } : {}),
    updatedAt: Date.now(),
  });
  return built ? { ...built, reverseEngineered: true } : null;
}
