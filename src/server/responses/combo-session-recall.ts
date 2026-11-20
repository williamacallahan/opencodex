import { createHash } from "node:crypto";
import { getCombo, targetKey } from "../../combos/types";
import { CODEX_THREAD_AFFINITY_IDLE_TTL_MS } from "../../codex/routing/thread-affinity";
import { captureConfigGeneration, type GenerationContext } from "../../lib/state-store-sweeper";
import type { OcxConfig, OcxComboTarget } from "../../types";

const COMBO_PIN_LIMIT = 2048;
type ComboPin = Pick<OcxComboTarget, "provider" | "model"> & {
  lane: string;
  comboId: string;
  responseDigest: string;
  at: number;
};
type Owners = Pick<GenerationContext, "comboIds" | "comboTargets" | "providerNames">;
const pins = new Map<string, ComboPin>();
// A bare compaction selector has no combo id. Only the lane's last completion can claim it.
const latest = new Map<string, ComboPin>();
let lastReconciledGeneration = 0;
let liveOwners: Owners | undefined;

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

function livePin(config: OcxConfig, pin: ComboPin | undefined): ComboPin | undefined {
  if (!pin) return undefined;
  const provider = config.providers[pin.provider];
  if (!expired(pin, Date.now()) && Object.hasOwn(config.providers, pin.provider) && provider && !provider.disabled
    && getCombo(config, pin.comboId)?.targets.some(target => targetKey(target) === targetKey(pin))) return pin;
  remove(pinKey(pin.lane, pin.comboId), pin);
  return undefined;
}
export function recallComboForLane(config: OcxConfig, lane: string | undefined, model: string): string | undefined {
  if (!lane || !model || model.includes("/")) return undefined;
  const pin = livePin(config, latest.get(lane));
  return pin && pin.responseDigest === modelDigest(model) ? pin.comboId : undefined;
}
export function recallComboTargetForLane(config: OcxConfig, lane: string | undefined, comboId: string): Pick<OcxComboTarget, "provider" | "model"> | undefined {
  if (!lane || !comboId) return undefined;
  const pin = livePin(config, pins.get(pinKey(lane, comboId)));
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
