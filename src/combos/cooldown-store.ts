/**
 * Disk-backed cooldown map for combo targets.
 *
 * A cooldown that lives only in memory is forgotten on every restart, so a freshly restarted proxy
 * re-offers a target that upstream said to leave alone until its reset. This Map subclass loads
 * `<config dir>/combo-cooldowns.json` on first use and writes back what this process changed.
 * Expiry is stored as an absolute epoch, so reset-aware cooldowns stay correct across restarts.
 * Pattern adopted from Hermes-agent (MIT, NousResearch): rate-limit state persisted per
 * (provider, model) so a restart does not retry a known-exhausted route.
 *
 * Several proxies can share one home, so a write never replaces the file wholesale:
 * - `set()` marks its key dirty. A flush re-reads the file under the config mutation lock and
 *   overlays only dirty keys, keeping the later of the two expiries, so it never shortens a
 *   cooldown another process wrote, except when migrating an oversized pooling-relay deadline.
 * - `dropLocal()` (and the Map `delete()`/`clear()` it backs) forgets a row in memory only. Expiry
 *   checks, sweeps and the revision-guarded probe lift use it, so an expired local copy can never
 *   erase a row another process has since extended.
 * - Explicit key, prefix and global clears are the only deletes written to disk: they record
 *   user-requested clears (combo save, rename, delete). Prefix clears also remove peer rows absent
 *   from memory. Deletes exclude old disk rows before dirty values are overlaid, so a subsequent
 *   `set()` starts a new cooldown even when the cleared row had a later expiry.
 * A busy lock or I/O failure keeps the pending state and retries with bounded backoff.
 *
 * Loading: once per config dir, on first use. Rows already in memory win; a file row loads only
 * while unexpired and gets a fresh revision from the caller's counter (revisions are never stored).
 * A running process does not re-read other processes' rows later.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { withConfigMutationLockSync } from "../config/mutation-lock";
import { getConfigDir } from "../config/paths";

export interface PersistableCooldown {
  cooldownUntil: number;
  revision: number;
  status?: number;
  scope?: "target" | "provider";
}
type StoredRow = Omit<PersistableCooldown, "revision">;

export const MAX_RELAY_COOLDOWN_MS = 5 * 60_000;
const FILE = "combo-cooldowns.json";
const FLUSH_DELAY_MS = 250;
const MAX_FLUSH_DELAY_MS = 4_000;
const MAX_LOAD_ATTEMPTS = 3;
const SHUTDOWN_ATTEMPTS = 5;
const SHUTDOWN_RETRY_MS = 200;

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

/** Valid rows of the file. Missing file or unparsable JSON is empty; other read errors throw. */
function readStoredRows(path: string): Record<string, StoredRow> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return {}; }
  const rows: Record<string, StoredRow> = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return rows;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || !("cooldownUntil" in value)
      || typeof value.cooldownUntil !== "number" || !Number.isFinite(value.cooldownUntil)) continue;
    rows[key] = {
      cooldownUntil: value.cooldownUntil,
      ...("status" in value && typeof value.status === "number" ? { status: value.status } : {}),
      ...("scope" in value && (value.scope === "target" || value.scope === "provider") ? { scope: value.scope } : {}),
    };
  }
  return rows;
}

export class PersistedCooldownMap<V extends PersistableCooldown> extends Map<string, V> {
  private loadedFor: string | undefined;
  private failedLoadDir: string | undefined;
  private failedLoads = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private delayMs = FLUSH_DELAY_MS;
  private scheduledDir: string | undefined;
  private readonly dirty = new Set<string>();
  private readonly tombstones = new Set<string>();
  private readonly clearedPrefixes = new Set<string>();
  private clearAll = false;
  private readonly nextRevision: () => number;

  constructor(nextRevision: () => number) {
    super();
    this.nextRevision = nextRevision;
  }

  private ensureLoaded(): void {
    const dir = getConfigDir();
    if (this.loadedFor === dir) return;
    if (this.failedLoadDir === dir && this.failedLoads >= MAX_LOAD_ATTEMPTS) return;
    let rows: Record<string, StoredRow>;
    try {
      rows = readStoredRows(join(dir, FILE));
    } catch {
      // A transient read failure (permissions, a locked file on Windows) retries on a later access.
      if (this.failedLoadDir !== dir) { this.failedLoadDir = dir; this.failedLoads = 0; }
      this.failedLoads += 1;
      return;
    }
    this.loadedFor = dir;
    const now = Date.now();
    for (const [key, row] of Object.entries(rows)) {
      if (row.cooldownUntil <= now || super.has(key)) continue;
      super.set(key, { ...row, revision: this.nextRevision() } as V);
    }
    this.clampRelayRows(now);
  }

  private isRelay?: (selector: string) => boolean;
  private readonly clamped = new Map<string, { previous: number; until: number }>();

  /** Legacy rows have no write timestamp or retry provenance. Bound remaining time at adoption. */
  bindRelayTargets(isRelay: (selector: string) => boolean): void {
    this.isRelay = isRelay;
    if (this.loadedFor !== getConfigDir()) this.ensureLoaded();
    else this.clampRelayRows(Date.now());
  }

  private clampRelayRows(now: number): void {
    if (!this.isRelay) return;
    const until = now + MAX_RELAY_COOLDOWN_MS;
    for (const [key, row] of super.entries()) {
      if (row.cooldownUntil <= until || !this.isRelay(key.slice(key.indexOf("\0") + 1))) continue;
      super.set(key, { ...row, cooldownUntil: until, revision: this.nextRevision() });
      this.clamped.set(key, { previous: row.cooldownUntil, until });
    }
    if (this.clamped.size) this.schedule();
  }

  private pending(): boolean {
    return this.clearAll || this.dirty.size > 0 || this.clamped.size > 0 || this.tombstones.size > 0 || this.clearedPrefixes.size > 0;
  }

  private schedule(): void {
    this.scheduledDir ??= getConfigDir();
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Write pending changes now. Returns false, keeping them and rescheduling, if the write could not run. */
  flush(): boolean {
    if (!this.pending()) return true;
    const dir = this.scheduledDir ?? getConfigDir();
    const path = join(dir, FILE);
    try {
      withConfigMutationLockSync(() => {
        const file = readStoredRows(path);
        const now = Date.now();
        const out: Record<string, StoredRow> = {};
        const clearedPrefixes = [...this.clearedPrefixes];
        if (!this.clearAll) {
          for (const [key, row] of Object.entries(file)) {
            const clamp = this.clamped.get(key);
            // Preserve a peer's newer in-policy write or clear; never restore the old seat horizon.
            if (clamp) row.cooldownUntil = row.cooldownUntil === clamp.previous ? clamp.until
              : Math.min(row.cooldownUntil, now + MAX_RELAY_COOLDOWN_MS);
            if (row.cooldownUntil > now && !this.tombstones.has(key)
              && !clearedPrefixes.some(prefix => key.startsWith(prefix))) out[key] = row;
          }
        }
        for (const key of this.dirty) {
          const own = super.get(key);
          if (!own || own.cooldownUntil <= now) continue;
          const other = out[key];
          const { revision: _revision, ...row } = own;
          out[key] = other && other.cooldownUntil > row.cooldownUntil ? other : row;
        }
        mkdirSync(dir, { recursive: true });
        atomicWriteFile(path, JSON.stringify(out));
      }, dir);
    } catch {
      // Lock held by another process (busy_timeout 0) or an I/O error: keep everything and retry.
      this.delayMs = Math.min(this.delayMs * 2, MAX_FLUSH_DELAY_MS);
      if (!this.timer) this.schedule();
      return false;
    }
    this.dirty.clear();
    this.clamped.clear();
    this.tombstones.clear();
    this.clearedPrefixes.clear();
    this.clearAll = false;
    this.scheduledDir = undefined;
    this.delayMs = FLUSH_DELAY_MS;
    return true;
  }

  /** Bounded final write for process shutdown; never blocks for more than about a second. */
  flushForShutdown(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    for (let attempt = 0; attempt < SHUTDOWN_ATTEMPTS; attempt += 1) {
      if (this.flush()) break;
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      if (attempt < SHUTDOWN_ATTEMPTS - 1) Bun.sleepSync(SHUTDOWN_RETRY_MS);
    }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }

  /** Forget a row in memory only (expiry, sweep, probe lift); nothing is written. */
  dropLocal(key: string): boolean { this.ensureLoaded(); return super.delete(key); }

  /** A user-requested clear of these keys, written to disk as deletes. */
  clearPersisted(keys: Iterable<string>): void {
    this.ensureLoaded();
    for (const key of keys) {
      super.delete(key);
      this.dirty.delete(key);
      this.tombstones.add(key);
    }
    this.schedule();
  }

  /** Clear a combo prefix in memory and in the fresh file read under the mutation lock. */
  clearPrefixPersisted(prefix: string): void {
    this.ensureLoaded();
    for (const key of super.keys()) {
      if (key.startsWith(prefix)) {
        super.delete(key);
        this.dirty.delete(key);
      }
    }
    this.clearedPrefixes.add(prefix);
    this.schedule();
  }

  /** A user-requested clear of every row, written to disk as a global reset. */
  clearAllPersisted(): void {
    this.ensureLoaded();
    super.clear();
    this.dirty.clear();
    this.tombstones.clear();
    this.clearedPrefixes.clear();
    this.clearAll = true;
    this.schedule();
  }

  override get(key: string): V | undefined { this.ensureLoaded(); return super.get(key); }
  override has(key: string): boolean { this.ensureLoaded(); return super.has(key); }
  override get size(): number { this.ensureLoaded(); return super.size; }
  override keys(): MapIterator<string> { this.ensureLoaded(); return super.keys(); }
  override values(): MapIterator<V> { this.ensureLoaded(); return super.values(); }
  override entries(): MapIterator<[string, V]> { this.ensureLoaded(); return super.entries(); }
  override [Symbol.iterator](): MapIterator<[string, V]> { this.ensureLoaded(); return super[Symbol.iterator](); }
  override set(key: string, value: V): this {
    this.ensureLoaded();
    super.set(key, value);
    // Keep queued clears until flush excludes the previous disk row, then overlays this value.
    this.dirty.add(key);
    this.schedule();
    return this;
  }
  override delete(key: string): boolean { return this.dropLocal(key); }
  override clear(): void { this.ensureLoaded(); super.clear(); }
}
