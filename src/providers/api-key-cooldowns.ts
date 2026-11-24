/** Process-local cooldown state shared by selection validation and key failover. */
const keyCooldowns = new Map<string, { cooldownUntil: number }>();
const clearListeners = new Set<(providerName?: string) => void>();
const clearAtByProvider = new Map<string, number>();
let lastClearAllAt = 0;

function cooldownKey(providerName: string, keyId: string): string {
  return `${providerName}\0${keyId}`;
}

export function registerKeyCooldownClearListener(listener: (providerName?: string) => void): () => void {
  clearListeners.add(listener);
  return () => { clearListeners.delete(listener); };
}

export function getLastKeyCooldownClearAt(providerName: string): number {
  return Math.max(lastClearAllAt, clearAtByProvider.get(providerName) ?? 0);
}

export function setKeyCooldown(providerName: string, keyId: string, cooldownUntil: number): void {
  const key = cooldownKey(providerName, keyId);
  keyCooldowns.set(key, { cooldownUntil: Math.max(keyCooldowns.get(key)?.cooldownUntil ?? 0, cooldownUntil) });
}

export function isKeyInCooldown(providerName: string, keyId: string, now = Date.now()): boolean {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    keyCooldowns.delete(cooldownKey(providerName, keyId));
    return false;
  }
  return true;
}

export function getKeyCooldownUntil(providerName: string, keyId: string, now = Date.now()): number | null {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return null;
  return entry.cooldownUntil > now ? entry.cooldownUntil : null;
}

export function sweepExpiredApiKeyCooldowns(now = Date.now()): number {
  let removed = 0;
  for (const [key, cooldown] of keyCooldowns) {
    if (cooldown.cooldownUntil > now) continue;
    keyCooldowns.delete(key);
    removed += 1;
  }
  return removed;
}

/** Manual key management clears this provider's cooldowns. */
export function clearKeyCooldowns(providerName?: string, now = Date.now()): void {
  if (!providerName) {
    lastClearAllAt = Math.max(lastClearAllAt, now);
    keyCooldowns.clear();
  } else {
    clearAtByProvider.set(providerName, Math.max(clearAtByProvider.get(providerName) ?? 0, now));
    const prefix = `${providerName}\0`;
    for (const key of keyCooldowns.keys()) {
      if (key.startsWith(prefix)) keyCooldowns.delete(key);
    }
  }
  for (const listener of clearListeners) listener(providerName);
}

/** Test seam: reset process-local cooldown memory without invoking persistent-clear listeners. */
export function resetKeyCooldownsForTests(providerName?: string): void {
  if (!providerName) {
    lastClearAllAt = 0;
    clearAtByProvider.clear();
    keyCooldowns.clear();
    return;
  }
  clearAtByProvider.delete(providerName);
  const prefix = `${providerName}\0`;
  for (const key of keyCooldowns.keys()) {
    if (key.startsWith(prefix)) keyCooldowns.delete(key);
  }
}
