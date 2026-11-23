/**
 * Disk-backed persistence for Codex per-account (`upstreamHealth`) and scoped
 * (`quotaScopedHealth`) cooldowns, avoidance deadlines, and Reserve refusal streaks.
 *
 * Mirrors {@link PersistedCooldownMap}: `<config dir>/codex-health-cooldowns.json` loads lazily per
 * config dir and flushes coalesced dirty writes under the config mutation lock so a restart does
 * not immediately sweep exhausted or backed-off OAuth seats again.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config/atomic-write";
import { withConfigMutationLockSync } from "../../config/mutation-lock";
import { getConfigDir } from "../../config/paths";
import { registerOptionalShutdownHook } from "../../lib/optional-shutdown-hooks";
import type { CodexQuotaScope, CodexUpstreamHealth } from "./health-store";

const FILE = "codex-health-cooldowns.json";
const FLUSH_DELAY_MS = 250;
const MAX_FLUSH_DELAY_MS = 4_000;
const MAX_LOAD_ATTEMPTS = 3;
const SHUTDOWN_ATTEMPTS = 5;
const SHUTDOWN_RETRY_MS = 200;
const MAX_PERSISTED_RESERVE_STREAK_IDLE_MS = 60 * 60_000;
const ACCOUNT_KEY_PREFIX = "a\0";
const SCOPED_KEY_PREFIX = "s\0";

type UpstreamMap = Map<string, CodexUpstreamHealth>;
type ScopedMap = Map<string, Map<CodexQuotaScope, CodexUpstreamHealth>>;

function accountStoreKey(accountId: string): string {
  return `${ACCOUNT_KEY_PREFIX}${accountId}`;
}

function scopedStoreKey(accountId: string, scope: CodexQuotaScope): string {
  return `${SCOPED_KEY_PREFIX}${accountId}\0${scope}`;
}

function parseStoreKey(key: string):
  | { kind: "account"; accountId: string }
  | { kind: "scoped"; accountId: string; scope: CodexQuotaScope }
  | null {
  if (key.startsWith(ACCOUNT_KEY_PREFIX)) {
    const accountId = key.slice(ACCOUNT_KEY_PREFIX.length);
    return accountId ? { kind: "account", accountId } : null;
  }
  if (key.startsWith(SCOPED_KEY_PREFIX)) {
    const rest = key.slice(SCOPED_KEY_PREFIX.length);
    const sep = rest.indexOf("\0");
    if (sep <= 0) return null;
    const accountId = rest.slice(0, sep);
    const scope = rest.slice(sep + 1);
    if (scope !== "shared" && scope !== "reserve") return null;
    return { kind: "scoped", accountId, scope };
  }
  return null;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeStoredRow(raw: unknown): CodexUpstreamHealth | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const consecutiveFailures = finiteNumber(src.consecutiveFailures) ?? 0;
  const row: CodexUpstreamHealth = { consecutiveFailures };
  const numberFields = [
    "consecutiveSuccesses",
    "lastFailureStatus",
    "lastFailureAt",
    "cooldownUntil",
    "quotaAvoidUntil",
    "softAvoidUntil",
    "cooldownSince",
    "cooldownGeneration",
    "lastProbeAt",
    "reserveRefusalStreak",
    "credentialFailureGeneration",
  ] as const;
  for (const field of numberFields) {
    const val = finiteNumber(src[field]);
    if (val !== undefined) row[field] = val;
  }
  if (src.cooldownSource === "retry-after" || src.cooldownSource === "reset-derived" || src.cooldownSource === "default") {
    row.cooldownSource = src.cooldownSource;
  }
  if (src.capacityEvidence && typeof src.capacityEvidence === "object" && "confirmed" in src.capacityEvidence
    && typeof (src.capacityEvidence as { confirmed?: unknown }).confirmed === "boolean") {
    row.capacityEvidence = { confirmed: (src.capacityEvidence as { confirmed: boolean }).confirmed };
  }
  if (src.reserveSuccess && typeof src.reserveSuccess === "object") {
    const rs = src.reserveSuccess as { at?: unknown; credentialGeneration?: unknown };
    const at = finiteNumber(rs.at);
    const gen = finiteNumber(rs.credentialGeneration);
    if (at !== undefined && gen !== undefined) row.reserveSuccess = { at, credentialGeneration: gen };
  }
  return row;
}

function serializeForDisk(health: CodexUpstreamHealth): CodexUpstreamHealth {
  const { probeLeaseId: _id, probeLeaseGeneration: _gen, ...persisted } = health;
  return persisted;
}

export function codexHealthRowHorizon(row: CodexUpstreamHealth): number {
  return Math.max(
    finiteNumber(row.cooldownUntil) ?? 0,
    finiteNumber(row.quotaAvoidUntil) ?? 0,
    finiteNumber(row.softAvoidUntil) ?? 0,
    (finiteNumber(row.reserveRefusalStreak) ?? 0) > 0
      ? Math.max(finiteNumber(row.cooldownUntil) ?? 0, finiteNumber(row.lastFailureAt) ?? 0) +
        MAX_PERSISTED_RESERVE_STREAK_IDLE_MS
      : 0,
  );
}

export function isCodexHealthRowAlive(row: CodexUpstreamHealth, now: number): boolean {
  if ((finiteNumber(row.cooldownUntil) ?? 0) > now) return true;
  if ((finiteNumber(row.quotaAvoidUntil) ?? 0) > now) return true;
  if ((finiteNumber(row.softAvoidUntil) ?? 0) > now) return true;
  if (
    (finiteNumber(row.reserveRefusalStreak) ?? 0) > 0 &&
    Math.max(finiteNumber(row.cooldownUntil) ?? 0, finiteNumber(row.lastFailureAt) ?? 0) +
      MAX_PERSISTED_RESERVE_STREAK_IDLE_MS >
      now
  ) {
    return true;
  }
  return false;
}

function readStoredRows(path: string): Record<string, CodexUpstreamHealth> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const rows: Record<string, CodexUpstreamHealth> = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return rows;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!parseStoreKey(key)) continue;
    const row = sanitizeStoredRow(value);
    if (row) rows[key] = row;
  }
  return rows;
}

class CodexHealthCooldownStore {
  private loadedFor: string | undefined;
  private failedLoadDir: string | undefined;
  private failedLoads = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delayMs = FLUSH_DELAY_MS;
  private scheduledDir: string | undefined;
  private readonly dirty = new Set<string>();
  private readonly tombstones = new Set<string>();
  private readonly clearedAccounts = new Set<string>();
  private boundMaps: { upstream: UpstreamMap; scoped: ScopedMap } | undefined;

  bindMaps(upstream: UpstreamMap, scoped: ScopedMap): void {
    this.boundMaps = { upstream, scoped };
  }

  ensureLoaded(upstream: UpstreamMap, scoped: ScopedMap): void {
    this.boundMaps = { upstream, scoped };
    const dir = getConfigDir();
    if (this.loadedFor === dir) return;
    if (this.failedLoadDir === dir && this.failedLoads >= MAX_LOAD_ATTEMPTS) return;
    let rows: Record<string, CodexUpstreamHealth>;
    try {
      rows = readStoredRows(join(dir, FILE));
    } catch {
      if (this.failedLoadDir !== dir) {
        this.failedLoadDir = dir;
        this.failedLoads = 0;
      }
      this.failedLoads += 1;
      return;
    }
    this.loadedFor = dir;
    const now = Date.now();
    for (const [key, row] of Object.entries(rows)) {
      if (!isCodexHealthRowAlive(row, now)) continue;
      const parsed = parseStoreKey(key);
      if (!parsed) continue;
      if (parsed.kind === "account") {
        if (!upstream.has(parsed.accountId)) upstream.set(parsed.accountId, row);
        continue;
      }
      let scopes = scoped.get(parsed.accountId);
      if (!scopes) {
        scopes = new Map();
        scoped.set(parsed.accountId, scopes);
      }
      if (!scopes.has(parsed.scope)) scopes.set(parsed.scope, row);
    }
  }

  private schedule(): void {
    this.scheduledDir ??= getConfigDir();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.boundMaps) this.flush(this.boundMaps.upstream, this.boundMaps.scoped);
    }, this.delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  markAccountDirty(accountId: string): void {
    const key = accountStoreKey(accountId);
    this.dirty.add(key);
    this.schedule();
  }

  markAccountReplaced(accountId: string): void {
    const key = accountStoreKey(accountId);
    this.tombstones.add(key);
    this.dirty.add(key);
    this.schedule();
  }

  markAccountDeleted(accountId: string): void {
    const key = accountStoreKey(accountId);
    this.dirty.delete(key);
    this.tombstones.add(key);
    this.schedule();
  }

  markScopedDirty(accountId: string, scope: CodexQuotaScope): void {
    const key = scopedStoreKey(accountId, scope);
    this.dirty.add(key);
    this.schedule();
  }

  markScopedReplaced(accountId: string, scope: CodexQuotaScope): void {
    const key = scopedStoreKey(accountId, scope);
    this.tombstones.add(key);
    this.dirty.add(key);
    this.schedule();
  }

  markScopedDeleted(accountId: string, scope: CodexQuotaScope): void {
    const key = scopedStoreKey(accountId, scope);
    this.dirty.delete(key);
    this.tombstones.add(key);
    this.schedule();
  }

  markAllForAccountDeleted(accountId: string): void {
    const acctPrefix = accountStoreKey(accountId);
    const scopePrefix = `${SCOPED_KEY_PREFIX}${accountId}\0`;
    for (const key of this.dirty) {
      if (key === acctPrefix || key.startsWith(scopePrefix)) this.dirty.delete(key);
    }
    this.clearedAccounts.add(accountId);
    this.schedule();
  }

  resetMemoryStateForClear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.dirty.clear();
    this.tombstones.clear();
    this.clearedAccounts.clear();
    this.scheduledDir = undefined;
    this.delayMs = FLUSH_DELAY_MS;
    this.failedLoadDir = undefined;
    this.failedLoads = 0;
    this.loadedFor = getConfigDir();
  }

  resetLoaderForTests(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.dirty.clear();
    this.tombstones.clear();
    this.clearedAccounts.clear();
    this.scheduledDir = undefined;
    this.delayMs = FLUSH_DELAY_MS;
    this.failedLoadDir = undefined;
    this.failedLoads = 0;
    this.loadedFor = undefined;
  }

  private pending(): boolean {
    return this.dirty.size > 0 || this.tombstones.size > 0 || this.clearedAccounts.size > 0;
  }

  flush(upstream: UpstreamMap, scoped: ScopedMap): boolean {
    this.boundMaps = { upstream, scoped };
    if (!this.pending()) return true;
    const dir = this.scheduledDir ?? getConfigDir();
    const path = join(dir, FILE);
    try {
      withConfigMutationLockSync(() => {
        const file = readStoredRows(path);
        const now = Date.now();
        const out: Record<string, CodexUpstreamHealth> = {};
        for (const [key, row] of Object.entries(file)) {
          const parsed = parseStoreKey(key);
          if (!parsed || !isCodexHealthRowAlive(row, now)) continue;
          if (this.tombstones.has(key) || this.clearedAccounts.has(parsed.accountId)) continue;
          out[key] = row;
        }
        for (const key of this.dirty) {
          const parsed = parseStoreKey(key);
          if (!parsed) continue;
          const own = parsed.kind === "account"
            ? upstream.get(parsed.accountId)
            : scoped.get(parsed.accountId)?.get(parsed.scope);
          if (!own || !isCodexHealthRowAlive(own, now)) continue;
          const persisted = serializeForDisk(own);
          const other = out[key];
          out[key] = other && codexHealthRowHorizon(other) > codexHealthRowHorizon(persisted) ? other : persisted;
        }
        mkdirSync(dir, { recursive: true });
        atomicWriteFile(path, JSON.stringify(out));
      }, dir);
    } catch {
      this.delayMs = Math.min(this.delayMs * 2, MAX_FLUSH_DELAY_MS);
      if (!this.timer) this.schedule();
      return false;
    }
    this.dirty.clear();
    this.tombstones.clear();
    this.clearedAccounts.clear();
    this.scheduledDir = undefined;
    this.delayMs = FLUSH_DELAY_MS;
    return true;
  }

  flushForShutdown(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.boundMaps) return;
    for (let attempt = 0; attempt < SHUTDOWN_ATTEMPTS; attempt += 1) {
      if (this.flush(this.boundMaps.upstream, this.boundMaps.scoped)) break;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      if (attempt < SHUTDOWN_ATTEMPTS - 1) Bun.sleepSync(SHUTDOWN_RETRY_MS);
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

export const codexHealthCooldownStore = new CodexHealthCooldownStore();
registerOptionalShutdownHook("codex-health-cooldowns", () => codexHealthCooldownStore.flushForShutdown());
