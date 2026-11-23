/**
 * Last-known per-account provider quota, kept across restarts.
 *
 * The in-memory cache is process-local, so a restart forgets every measurement and the
 * pool opens the next turn with no idea which account has room — exactly the state
 * pre-dispatch selection exists to avoid. Codex solved this for its own pool with a small
 * disk snapshot (`codex/quota.ts`), and this is the same shape for provider accounts.
 *
 * What is written is percentages and reset timestamps. No token, no email, no account
 * label — the account id is the store's own opaque id, which is already what keys the
 * in-memory cache.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { withConfigDirHardeningSettled } from "../config/paths";
import type { ProviderQuota, ProviderQuotaWindow } from "./quota-types";
import type { KiroPersistedQuota, KiroPersistedVerdict } from "./kiro-account-state-disk";
import { ACCOUNT_QUOTA_TTL_MS, epochMillis, PASSIVE_OBSERVATION_MAX_AGE_MS } from "./quota-wire";

const FILENAME = "provider-account-quota-cache.json";

/**
 * Older than this and the snapshot is discarded on load.
 *
 * Six hours matches the Codex cache. A stale bar is still better than none for ORDERING —
 * it decides which account to try first, and a wrong guess costs one 429 that rotation
 * already handles — but a day-old reading of a monthly window has drifted far enough that
 * it should not outrank a fresh probe.
 */
export const DISK_MAX_AGE_MS = 6 * 60 * 60_000;
/**
 * An agy observation (or setup-token header observation) is passive and idle seats get no newer
 * one. It is kept past a weekly window so restarts never blank valid active reset windows.
 */
const AGY_OBSERVATION_MAX_AGE_MS = PASSIVE_OBSERVATION_MAX_AGE_MS;
const PERSIST_DEBOUNCE_MS = 250;
/** Match the reset ledger's maximum deferral under sustained quota observations. */
const MAX_PERSIST_DEFERRAL_MS = 1_000;

/** Private Anthropic ownership metadata in the existing snapshot, never in quota DTOs. */
export type AnthropicPersistedQuota = ProviderQuota & { anthropicCredentialGeneration?: string };

type DiskFile = {
  version: 1;
  /** provider\u0000accountId -> quota, the same key the in-memory cache uses. */
  rows: Record<string, ProviderQuota | KiroPersistedQuota | AnthropicPersistedQuota>;
  kiroVerdicts?: Record<string, KiroPersistedVerdict>;
};

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistStartedAt: number | null = null;
/** Bumped by cancellation so a fired callback still waiting for ACL admission writes nothing. */
let persistGeneration = 0;
let persistWrite: Promise<void> = Promise.resolve();
/** Test seam: wait for a fired persistence callback's admitted write (as settleQuotaPersistenceForTests). */
export function settleAccountQuotaPersistForTests(): Promise<void> { return persistWrite; }

function futureReset(resetAt: unknown, now: number): boolean {
  return typeof resetAt === "number" && (epochMillis(resetAt) ?? 0) > now;
}

/** Beyond the normal snapshot lifetime, only a live reset extends its own measurement. */
function retainedAnthropicSnapshot(quota: ProviderQuota, now: number, expired: boolean): ProviderQuota | null {
  const retained = { ...quota };
  let hasFutureWindow = false;
  for (const [percent, reset] of [
    ["fiveHourPercent", "fiveHourResetAt"], ["weeklyPercent", "weeklyResetAt"], ["monthlyPercent", "monthlyResetAt"],
  ] as const) {
    if (typeof quota[percent] === "number" && Number.isFinite(quota[percent]) && futureReset(quota[reset], now)) {
      hasFutureWindow = true;
    } else if (expired) {
      delete retained[percent];
      delete retained[reset];
    }
  }
  for (const field of ["customWindows", "displayWindows"] as const) {
    const windows = quota[field];
    const valid = Array.isArray(windows) ? windows.filter((window: ProviderQuotaWindow) =>
      window && typeof window.label === "string" && Number.isFinite(window.percent)
      && (!expired || futureReset(window.resetAt, now))) : [];
    if (valid.length) {
      retained[field] = valid;
      if (expired) hasFutureWindow = true;
    } else delete retained[field];
  }
  return expired && !hasFutureWindow ? null : retained;
}

/** Read the snapshot. Returns an empty map for a missing, corrupt or stale file. */
export function readPersistedAccountQuotas(now = Date.now()): Map<string, ProviderQuota> {
  const rows = new Map<string, ProviderQuota>();
  try {
    const path = join(getConfigDir(), FILENAME);
    if (!existsSync(path)) return rows;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DiskFile;
    if (!parsed || parsed.version !== 1 || !parsed.rows || typeof parsed.rows !== "object") return rows;
    for (const [key, quota] of Object.entries(parsed.rows)) {
      if (!quota || typeof quota !== "object" || typeof quota.updatedAt !== "number"
        || !Number.isFinite(quota.updatedAt)) continue;
      const agyObservation = key.startsWith("google-antigravity\0") && typeof (quota as KiroPersistedQuota).identity === "string";
      const anthropicKey = key.startsWith("anthropic\0") || key.startsWith("anthropic2\0");
      const rawAnthropicGen = (quota as AnthropicPersistedQuota).anthropicCredentialGeneration;
      const validAnthropicGen = anthropicKey && typeof rawAnthropicGen === "string" && /^[a-f0-9]{64}$/.test(rawAnthropicGen);
      const age = now - quota.updatedAt;
      const maxAgeMs = agyObservation || validAnthropicGen ? AGY_OBSERVATION_MAX_AGE_MS : DISK_MAX_AGE_MS;
      if (age > maxAgeMs) continue;
      if (key.startsWith("kiro\0") && (quota.updatedAt > now
        || typeof (quota as KiroPersistedQuota).identity !== "string"
        || !/^[a-f0-9]{64}$/.test((quota as KiroPersistedQuota).identity))) continue;
      if (anthropicKey) {
        const { anthropicCredentialGeneration, ...bars } = quota as AnthropicPersistedQuota;
        const retained: AnthropicPersistedQuota | null = retainedAnthropicSnapshot(bars, now, age > DISK_MAX_AGE_MS);
        if (!retained) continue;
        // Legacy or malformed ownership remains historical, never bound to today's login.
        if (validAnthropicGen) retained.anthropicCredentialGeneration = anthropicCredentialGeneration;
        rows.set(key, retained);
      } else rows.set(key, quota);
    }
  } catch {
    // A corrupt cache must never block routing or the dashboard.
  }
  return rows;
}

export function readPersistedKiroVerdicts(now = Date.now()): Map<string, KiroPersistedVerdict> {
  const result = new Map<string, KiroPersistedVerdict>();
  try {
    const file: unknown = JSON.parse(readFileSync(join(getConfigDir(), FILENAME), "utf8"));
    if (!file || typeof file !== "object" || Array.isArray(file)) return result;
    const parsed = file as Partial<DiskFile>;
    if (parsed.version !== 1 || !parsed.kiroVerdicts || typeof parsed.kiroVerdicts !== "object"
      || Array.isArray(parsed.kiroVerdicts)) return result;
    for (const [key, value] of Object.entries(parsed.kiroVerdicts)) {
      if (!key.startsWith("kiro\0") || !value || typeof value !== "object") continue;
      const row = value as Partial<KiroPersistedVerdict>;
      if (typeof row.exhausted !== "boolean" || typeof row.identity !== "string"
        || !/^[a-f0-9]{64}$/.test(row.identity) || typeof row.observedAt !== "number"
        || !Number.isFinite(row.observedAt) || row.observedAt > now
        || now - row.observedAt >= ACCOUNT_QUOTA_TTL_MS
        || (row.resetAt !== undefined && (typeof row.resetAt !== "number"
          || !Number.isFinite(row.resetAt) || row.resetAt <= now
          || !Number.isFinite(new Date(row.resetAt).getTime())))) continue;
      result.set(key, row as KiroPersistedVerdict);
    }
  } catch { /* Missing or malformed evidence is unknown. */ }
  return result;
}

/** Debounce snapshots without starving writes under load. Failures remain best-effort. */
export function schedulePersistAccountQuotas(
  rows: () => Iterable<[string, ProviderQuota | KiroPersistedQuota | AnthropicPersistedQuota]>,
  verdicts: () => Iterable<[string, KiroPersistedVerdict]> = () => [],
): void {
  const now = performance.now();
  persistStartedAt ??= now;
  const delay = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS,
    MAX_PERSIST_DEFERRAL_MS - (now - persistStartedAt)));
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistStartedAt = null;
    // Writes under the config root wait out an overlapping optional config-root ACL flight,
    // whose inheritance can drop the fresh file's explicit grant (#7815). Rows are read inside
    // the admitted callback so a late admission still writes the newest snapshot; a timeout
    // skips this best-effort write.
    const dir = getConfigDir();
    const generation = persistGeneration;
    persistWrite = withConfigDirHardeningSettled(dir, () => {
      if (generation !== persistGeneration) return;
      const out: Record<string, ProviderQuota> = {};
      for (const [key, quota] of rows()) out[key] = quota;
      const kiroVerdicts: Record<string, KiroPersistedVerdict> = {};
      for (const [key, verdict] of verdicts()) {
        if (key.startsWith("kiro\0") && /^[a-f0-9]{64}$/.test(verdict.identity)) kiroVerdicts[key] = verdict;
      }
      const body: DiskFile = { version: 1, rows: out, kiroVerdicts };
      atomicWriteFile(join(dir, FILENAME), `${JSON.stringify(body)}\n`);
    }).catch(() => {
      // Best-effort persistence only.
    });
  }, delay);
}

/** Test seam: drop any pending write so a suite cannot leak one into the next file. */
export function cancelPendingAccountQuotaPersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  persistStartedAt = null;
  persistGeneration += 1;
}
