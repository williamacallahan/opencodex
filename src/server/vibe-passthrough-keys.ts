/**
 * Pooled CHAT-plan API key selection, affinity pinning, cooldowns, and monthly 402 parks
 * for the Mistral Vibe pass-through (`/vibe`).
 */
import { createHash, randomInt } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { withConfigDirHardeningSettled } from "../config/paths";
import { apiKeyAccountLogLabel } from "../codex/account-label";
import { VIBE_PROVIDER_ID } from "../lib/native-harness";
import { registerOptionalAsyncFlushHook } from "../lib/optional-shutdown-hooks";
import {
  getKeyCooldownUntil,
  getLastKeyCooldownClearAt,
  isKeyInCooldown,
  registerKeyCooldownClearListener,
  resetKeyCooldownsForTests,
  setKeyCooldown,
} from "../providers/api-key-cooldowns";
import { isProviderApiKeyPaused } from "../providers/api-key-pause-state";
import { apiKeyPoolEntryId } from "../providers/api-keys";
import { resolveProviderApiKey } from "../providers/key-store";
import type { OcxProviderConfig } from "../types";

const MAX_AFFINITY_ENTRIES = 2048;
const AFFINITY_TTL_MS = 6 * 60 * 60_000;
const MIN_429_COOLDOWN_MS = 5_000;
const DEFAULT_429_COOLDOWN_MS = 60_000;
const MAX_429_COOLDOWN_MS = 3_600_000;
const AUTH_FAILURE_COOLDOWN_MS = 15 * 60_000;
const MAX_COOLDOWN_FILE_BYTES = 256 * 1024;
const COOLDOWN_FILENAME = "vibe-key-cooldowns.json";

export interface VibePooledKey {
  readonly id: string;
  readonly apiKey: string;
  readonly reference: string;
  readonly label?: string;
}

export type VibeKeyChoice =
  | { kind: "key"; key: VibePooledKey; accountLogLabel: string | undefined }
  | { kind: "pool-empty" }
  | { kind: "pool-unavailable" }
  | { kind: "pool-exhausted"; retryAfterSeconds: number };

const affinityMap = new Map<string, { keyId: string; expiresAt: number }>();
let rotationCursor = randomInt(1_000_000);
let hydratedConfigDir: string | null = null;
const persistedParks = new Map<string, number>();
let persistQueue: Promise<void> = Promise.resolve();
let persistEpoch = 0;
let resettingState = false;

function affinitySlotKey(affinityHeader: string): string {
  return createHash("sha256")
    .update(getConfigDir())
    .update("\0")
    .update(affinityHeader.trim())
    .digest("hex");
}

function hydratePersistedCooldowns(now: number): void {
  const configDir = getConfigDir();
  if (hydratedConfigDir === configDir) return;
  hydratedConfigDir = configDir;
  persistedParks.clear();
  try {
    const filePath = join(configDir, COOLDOWN_FILENAME);
    if (!existsSync(filePath)) return;
    const stat = statSync(filePath);
    if (stat.size > MAX_COOLDOWN_FILE_BYTES) return;
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown; savedAt?: unknown; parks?: unknown };
    if (!parsed || parsed.version !== 1 || !parsed.parks || typeof parsed.parks !== "object" || Array.isArray(parsed.parks)) {
      return;
    }
    const lastClearedAt = getLastKeyCooldownClearAt(VIBE_PROVIDER_ID);
    const savedAt = typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt) ? parsed.savedAt : stat.mtimeMs;
    if (lastClearedAt > 0 && savedAt <= lastClearedAt) {
      persistEpoch += 1;
      void schedulePersistParks(now);
      return;
    }
    for (const [keyId, until] of Object.entries(parsed.parks)) {
      if (typeof until === "number" && Number.isFinite(until) && until > now) {
        persistedParks.set(keyId, until);
        setKeyCooldown(VIBE_PROVIDER_ID, keyId, until);
      }
    }
  } catch {
    // Missing or unreadable persistence leaves in-memory cooldowns clean.
  }
}

function schedulePersistParks(now: number): Promise<void> {
  const configDir = getConfigDir();
  const epoch = persistEpoch;
  for (const [keyId, until] of persistedParks) {
    if (until <= now) persistedParks.delete(keyId);
  }
  const snapshot: Record<string, number> = Object.fromEntries(persistedParks);
  const payload = JSON.stringify({ version: 1, savedAt: now, parks: snapshot });
  persistQueue = persistQueue.then(async () => {
    await withConfigDirHardeningSettled(configDir, () => {
      if (persistEpoch !== epoch || hydratedConfigDir !== configDir) return;
      atomicWriteFile(join(configDir, COOLDOWN_FILENAME), payload);
    });
  }).catch(() => {});
  return persistQueue;
}

registerKeyCooldownClearListener(providerName => {
  if (resettingState) return;
  if (providerName !== undefined && providerName !== VIBE_PROVIDER_ID) return;
  const now = Date.now();
  persistedParks.clear();
  persistEpoch += 1;
  const configDir = getConfigDir();
  if (hydratedConfigDir === configDir || existsSync(join(configDir, COOLDOWN_FILENAME))) {
    hydratedConfigDir = configDir;
    void schedulePersistParks(now);
  }
});

/** Flush queued disk writes before server shutdown or in tests. */
export function flushVibeKeyCooldownWrites(): Promise<void> {
  return persistQueue;
}

registerOptionalAsyncFlushHook("vibe-passthrough-keys", flushVibeKeyCooldownWrites);

export const flushVibeKeyCooldownWritesForTests = flushVibeKeyCooldownWrites;

function collectEnabledPoolKeys(provider: OcxProviderConfig | undefined): { totalConfigured: number; enabled: VibePooledKey[] } {
  if (!provider || provider.disabled === true || provider.authMode === "oauth" || provider.authMode === "forward") {
    return { totalConfigured: 0, enabled: [] };
  }
  const pool = provider.apiKeyPool;
  if (pool && pool.length > 0) {
    const seen = new Set<string>();
    const enabled: VibePooledKey[] = [];
    for (const entry of pool) {
      if (entry.disabled) continue;
      const resolved = resolveProviderApiKey(entry.key)?.trim();
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      enabled.push({
        id: entry.id,
        apiKey: resolved,
        reference: entry.key,
        ...(entry.label ? { label: entry.label } : {}),
      });
    }
    return { totalConfigured: pool.length, enabled };
  }
  if (!provider.apiKey || isProviderApiKeyPaused(provider)) {
    return { totalConfigured: provider.apiKey ? 1 : 0, enabled: [] };
  }
  const resolved = resolveProviderApiKey(provider.apiKey)?.trim();
  if (!resolved) return { totalConfigured: 0, enabled: [] };
  return {
    totalConfigured: 1,
    enabled: [{ id: apiKeyPoolEntryId(provider.apiKey), apiKey: resolved, reference: provider.apiKey }],
  };
}

/** Promote or insert an affinity pin in O(1), evicting expired/oldest entries above MAX_AFFINITY_ENTRIES. */
export function rememberVibeAffinity(affinityHeader: string | null, keyId: string, now = Date.now()): void {
  const normalized = affinityHeader?.trim();
  if (!normalized) return;
  const slot = affinitySlotKey(normalized);
  // Bounded head sweep keeps expired pins from occupying active LRU slots.
  let checked = 0;
  for (const [candidateKey, entry] of affinityMap) {
    if (entry.expiresAt <= now) affinityMap.delete(candidateKey);
    if (++checked >= 4) break;
  }
  affinityMap.delete(slot);
  affinityMap.set(slot, { keyId, expiresAt: now + AFFINITY_TTL_MS });
  while (affinityMap.size > MAX_AFFINITY_ENTRIES) {
    const oldest = affinityMap.keys().next().value;
    if (oldest === undefined) break;
    affinityMap.delete(oldest);
  }
}

export function forgetVibeAffinity(affinityHeader: string | null): void {
  const normalized = affinityHeader?.trim();
  if (!normalized) return;
  affinityMap.delete(affinitySlotKey(normalized));
}

function logLabelFor(key: VibePooledKey): string | undefined {
  return apiKeyAccountLogLabel(VIBE_PROVIDER_ID, { entryId: key.id, reference: key.reference });
}

export function chooseVibeKey(
  provider: OcxProviderConfig | undefined,
  affinityHeader: string | null,
  excludeKeyIds?: ReadonlySet<string>,
  now = Date.now(),
): VibeKeyChoice {
  hydratePersistedCooldowns(now);
  const { totalConfigured, enabled } = collectEnabledPoolKeys(provider);
  if (totalConfigured === 0) return { kind: "pool-empty" };
  if (enabled.length === 0) return { kind: "pool-unavailable" };

  const healthy = enabled.filter(entry =>
    (!excludeKeyIds || !excludeKeyIds.has(entry.id)) && !isKeyInCooldown(VIBE_PROVIDER_ID, entry.id, now),
  );
  if (healthy.length === 0) {
    let earliestReset: number | null = null;
    for (const entry of enabled) {
      if (excludeKeyIds?.has(entry.id)) continue;
      const until = getKeyCooldownUntil(VIBE_PROVIDER_ID, entry.id, now);
      if (until !== null && (earliestReset === null || until < earliestReset)) earliestReset = until;
    }
    if (earliestReset !== null) {
      const retryAfterSeconds = Math.max(1, Math.ceil((earliestReset - now) / 1000));
      return { kind: "pool-exhausted", retryAfterSeconds };
    }
    return { kind: "pool-unavailable" };
  }

  const normalized = affinityHeader?.trim();
  if (normalized) {
    const slot = affinitySlotKey(normalized);
    const pinned = affinityMap.get(slot);
    if (pinned) {
      if (pinned.expiresAt <= now) {
        affinityMap.delete(slot);
      } else {
        const match = healthy.find(entry => entry.id === pinned.keyId);
        if (match) {
          // Promote only when healthy and refresh sliding TTL to maintain monotonic LRU+TTL order.
          affinityMap.delete(slot);
          affinityMap.set(slot, { keyId: pinned.keyId, expiresAt: now + AFFINITY_TTL_MS });
          return { kind: "key", key: match, accountLogLabel: logLabelFor(match) };
        }
      }
    }
  }

  const selected = healthy[rotationCursor % healthy.length]!;
  rotationCursor = (rotationCursor + 1) % Number.MAX_SAFE_INTEGER;
  return { kind: "key", key: selected, accountLogLabel: logLabelFor(selected) };
}

function parseHeaderDelayMs(headers: Headers, now: number): number | undefined {
  const candidates = [
    headers.get("retry-after"),
    headers.get("x-ratelimit-reset-after"),
    headers.get("ratelimit-reset"),
    headers.get("x-ratelimit-reset-tokens-minute"),
    headers.get("x-ratelimit-reset-req-minute"),
    headers.get("x-ratelimit-reset"),
  ];
  for (const rawHeader of candidates) {
    const raw = rawHeader?.trim();
    if (!raw) continue;
    if (/^\d+(?:\.\d+)?$/.test(raw)) {
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) continue;
      // Values above 1e9 are Unix epoch seconds; smaller values are delta seconds.
      const deltaMs = numeric > 1_000_000_000 ? numeric * 1000 - now : numeric * 1000;
      return Math.min(MAX_429_COOLDOWN_MS, Math.max(MIN_429_COOLDOWN_MS, deltaMs));
    }
    const parsedMs = Date.parse(raw);
    if (Number.isFinite(parsedMs)) {
      const deltaMs = parsedMs - now;
      return Math.min(MAX_429_COOLDOWN_MS, Math.max(MIN_429_COOLDOWN_MS, deltaMs));
    }
  }
  return undefined;
}

export function recordVibe429Cooldown(keyId: string, headers: Headers, now = Date.now()): number {
  const delayMs = parseHeaderDelayMs(headers, now) ?? DEFAULT_429_COOLDOWN_MS;
  const until = now + delayMs;
  setKeyCooldown(VIBE_PROVIDER_ID, keyId, until);
  return until;
}

export function recordVibeAuthFailureCooldown(keyId: string, now = Date.now()): number {
  const until = now + AUTH_FAILURE_COOLDOWN_MS;
  setKeyCooldown(VIBE_PROVIDER_ID, keyId, until);
  return until;
}

export function nextMonthUtcTimestamp(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

const MAX_402_INSPECT_BYTES = 64 * 1024;

function hasBudgetExhaustedMarker(obj: Record<string, unknown>): boolean {
  const code = obj.code;
  const type = obj.type;
  if (code === 2304 || code === "2304") return true;
  if (code === "billing_vibe_budget_exhausted" || type === "billing_vibe_budget_exhausted") return true;
  return false;
}

/** Detect Mistral monthly Vibe allowance exhaustion (`billing_vibe_budget_exhausted` / code `2304`). */
export function isVibeBudgetExhausted402(status: number, bodyBytes: Uint8Array): boolean {
  if (status !== 402 || bodyBytes.byteLength === 0 || bodyBytes.byteLength > MAX_402_INSPECT_BYTES) return false;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bodyBytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const rec = parsed as Record<string, unknown>;
    if (hasBudgetExhaustedMarker(rec)) return true;
    for (const nestedKey of ["error", "detail"] as const) {
      const nested = rec[nestedKey];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        if (hasBudgetExhaustedMarker(nested as Record<string, unknown>)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function parkVibeKeyUntilNextMonthUtc(keyId: string, now = Date.now()): number {
  hydratePersistedCooldowns(now);
  const until = nextMonthUtcTimestamp(now);
  setKeyCooldown(VIBE_PROVIDER_ID, keyId, until);
  persistedParks.set(keyId, until);
  void schedulePersistParks(now);
  return until;
}

/** Test seam: reset process-local affinity LRU, rotation cursor, and in-memory cooldowns without clearing disk state. */
export function resetVibePassthroughKeyStateForTests(): void {
  resettingState = true;
  try {
    affinityMap.clear();
    persistedParks.clear();
    hydratedConfigDir = null;
    persistEpoch += 1;
    rotationCursor = 0;
    resetKeyCooldownsForTests(VIBE_PROVIDER_ID);
  } finally {
    resettingState = false;
  }
}
