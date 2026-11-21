import { createHash } from "node:crypto";
import { getCombo, targetKey } from "../../combos/types";
import { CODEX_THREAD_AFFINITY_IDLE_TTL_MS } from "../../codex/routing/thread-affinity";
import { captureConfigGeneration, type GenerationContext } from "../../lib/state-store-sweeper";
import { affinityDigest, COMBO_PIN_LIMIT, registerComboPinSnapshot, type StoredComboPin as ComboPin } from "../../codex/routing/thread-affinity-store";
import type { OcxConfig, OcxComboTarget } from "../../types";

type Owners = Pick<GenerationContext, "comboIds" | "comboTargets" | "providerNames">;
const pins = new Map<string, ComboPin>();
// A bare compaction selector has no combo id. Only the lane's last completion can claim it.
const latest = new Map<string, ComboPin>();
let lastReconciledGeneration = 0;
let liveOwners: Owners | undefined;

registerComboPinSnapshot({
  restore(rows) {
    pins.clear();
    latest.clear();
    for (const pin of rows) {
      if (typeof pin.lane !== "string" || !/^[0-9a-f]{64}$/.test(pin.lane) || !Number.isSafeInteger(pin.at)
        || typeof pin.comboId !== "string" || typeof pin.provider !== "string" || typeof pin.model !== "string"
        || (pin.responseDigest !== null && !/^[0-9a-f]{64}$/.test(pin.responseDigest))) continue;
      pins.set(pinKey(pin.lane, pin.comboId), pin);
      if (pin.responseDigest !== null) latest.set(pin.lane, pin);
    }
  },
  *rows() {
    for (const pin of pins.values()) {
      yield latest.get(pin.lane) === pin ? pin : { ...pin, responseDigest: null };
    }
  },
});

function pinKey(lane: string, comboId: string): string {
  return JSON.stringify([lane, comboId]);
}
function remove(key: string, pin: ComboPin): void {
  pins.delete(key);
  if (latest.get(pin.lane) === pin) latest.delete(pin.lane);
}
function ownsPin(context: Owners, pin: ComboPin): boolean {
  return context.comboIds.has(pin.comboId) && context.providerNames.has(pin.provider)
    && context.comboTargets.has(`${pin.comboId}::${targetKey(pin)}`);
}
function expired(pin: ComboPin, now: number): boolean {
  return pin.at > now || now - pin.at > CODEX_THREAD_AFFINITY_IDLE_TTL_MS;
}
/** Store only a fixed-size digest of the provider-reported response model, never its bytes. */
function modelDigest(model: string): string | undefined {
  if (model.length > 1024 || Buffer.byteLength(model) > 1024 || !model.trim()) return undefined;
  return createHash("sha256").update(model).digest("hex");
}

export function rememberComboForLane(
  lane: string | undefined, comboId: string, target: Pick<OcxComboTarget, "provider" | "model">,
  responseModel: string, writerGeneration: number,
): void {
  if (!lane || !comboId || writerGeneration < Math.max(lastReconciledGeneration, captureConfigGeneration())) return;
  const responseDigest = modelDigest(responseModel);
  if (!responseDigest) return;
  lane = affinityDigest("combo-lane", lane);
  const pin = { lane, comboId, provider: target.provider, model: target.model, responseDigest, at: Date.now() };
  if (liveOwners && !ownsPin(liveOwners, pin)) return;
  const key = pinKey(lane, comboId);
  pins.delete(key);
  pins.set(key, pin);
  latest.set(lane, pin);
  if (pins.size > COMBO_PIN_LIMIT) {
    const oldest = pins.entries().next().value;
    if (oldest) remove(...oldest);
  }
}

function recordedPin(config: OcxConfig, pin: ComboPin | undefined): ComboPin | undefined {
  if (!pin) return undefined;
  const provider = config.providers[pin.provider];
  if (!expired(pin, Date.now()) && Object.hasOwn(config.providers, pin.provider) && provider
    && getCombo(config, pin.comboId)?.targets.some(target => targetKey(target) === targetKey(pin))) return pin;
  remove(pinKey(pin.lane, pin.comboId), pin);
  return undefined;
}
export function recallComboForLane(config: OcxConfig, lane: string | undefined, model: string): string | undefined {
  if (!lane || !model || model.includes("/")) return undefined;
  const pin = recordedPin(config, latest.get(affinityDigest("combo-lane", lane)));
  return pin && !config.providers[pin.provider]?.disabled && pin.responseDigest === modelDigest(model) ? pin.comboId : undefined;
}
export function recallComboTargetForLane(config: OcxConfig, lane: string | undefined, comboId: string): Pick<OcxComboTarget, "provider" | "model"> | undefined {
  if (!lane || !comboId) return undefined;
  // The picker checks eligibility. Disabling a member does not change who issued its state.
  const pin = recordedPin(config, pins.get(pinKey(affinityDigest("combo-lane", lane), comboId)));
  return pin && { provider: pin.provider, model: pin.model };
}
export function sweepExpiredComboRecall(now: number): number {
  const before = pins.size;
  for (const [key, pin] of pins) if (expired(pin, now)) remove(key, pin);
  return before - pins.size;
}
export function reconcileComboRecall(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  lastReconciledGeneration = context.generation;
  liveOwners = context;
  const before = pins.size;
  const now = Date.now();
  for (const [key, pin] of pins) if (!ownsPin(context, pin) || expired(pin, now)) remove(key, pin);
  return before - pins.size;
}
export function clearComboRecallForTests(): void {
  pins.clear();
  latest.clear();
  lastReconciledGeneration = 0;
  liveOwners = undefined;
}
