import { PIN_ITEM_PROOFS } from "../../responses/reasoning-replay-cache";
import { createHash } from "node:crypto";
import { routeConcreteModel } from "../../router";
import { couldServeResponsesStore } from "./core-replay";
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
        || (pin.proofs != null && (pin.proofs.length > PIN_ITEM_PROOFS * 65 || !/^[0-9a-f]{64}(?:,[0-9a-f]{64})*$/.test(pin.proofs)))
        || (pin.store != null && !/^destination:[a-f0-9]{64}\/credential:[a-f0-9]{64}$/.test(pin.store))
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
  responseModel: string, writerGeneration: number, store?: string, issued?: readonly string[],
): void {
  if (!lane || !comboId || writerGeneration < Math.max(lastReconciledGeneration, captureConfigGeneration())) return;
  const responseDigest = modelDigest(responseModel);
  if (!responseDigest) return;
  lane = affinityDigest("combo-lane", lane);
  const key = pinKey(lane, comboId);
  const previous = pins.get(key)?.proofs;
  const proofs = issued ? [...new Set([...(previous?.split(",") ?? []), ...issued])].slice(-PIN_ITEM_PROOFS).join(",") : previous;
  const pin = { lane, comboId, proofs, provider: target.provider, model: target.model, responseDigest, store, at: Date.now() };
  if (liveOwners && !ownsPin(liveOwners, pin)) return;
  pins.delete(key);
  pins.set(key, pin);
  latest.set(lane, pin);
  if (pins.size > COMBO_PIN_LIMIT) {
    const oldest = pins.entries().next().value;
    if (oldest) remove(...oldest);
  }
}

function livePin(pin: ComboPin | undefined): ComboPin | undefined {
  if (pin && !expired(pin, Date.now())) return pin;
  if (pin) remove(pinKey(pin.lane, pin.comboId), pin);
}
function recordedTarget(config: OcxConfig, pin: ComboPin) {
  const targets = getCombo(config, pin.comboId)?.targets ?? [];
  const named = targets.find(target => targetKey(target) === targetKey(pin));
  const store = pin.store;
  if (!store) return named && Object.hasOwn(config.providers, named.provider) ? named : undefined;
  const matches = (target: typeof targets[number]) => {
    if (target.model !== pin.model || config.providers[target.provider]?.disabled) return false;
    try {
      const route = routeConcreteModel(config, targetKey(target));
      return route.staticPolicy.model.adapter === "openai-responses" && couldServeResponsesStore(route.provider, store);
    } catch { return false; }
  };
  if (named && matches(named)) return named;
  return targets.find(target => target !== named && matches(target)) ?? (named && config.providers[named.provider]?.disabled ? named : undefined);
}
export function recallComboForLane(config: OcxConfig, lane: string | undefined, model: string): string | undefined {
  if (!lane || !model || model.includes("/")) return undefined;
  const pin = livePin(latest.get(affinityDigest("combo-lane", lane)));
  if (!pin || pin.responseDigest !== modelDigest(model)) return;
  const target = recordedTarget(config, pin);
  return target && !config.providers[target.provider]?.disabled ? pin.comboId : undefined;
}
export function recallComboOwnerForLane(config: OcxConfig, lane: string | undefined, comboId: string) {
  if (!lane || !comboId) return;
  const pin = livePin(pins.get(pinKey(affinityDigest("combo-lane", lane), comboId)));
  if (!pin) return;
  const target = recordedTarget(config, pin);
  // A name can still be a preference for a stateless turn after retargeting, never an issuer.
  const preference = target ?? getCombo(config, comboId)?.targets.find(member => targetKey(member) === targetKey(pin));
  return { target, preference, store: pin.store ?? undefined, proofs: pin.proofs?.split(",") };
}
export function recallComboTargetForLane(config: OcxConfig, lane: string | undefined, comboId: string): Pick<OcxComboTarget, "provider" | "model"> | undefined {
  const target = recallComboOwnerForLane(config, lane, comboId)?.target;
  return target && { provider: target.provider, model: target.model };
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
  for (const [key, pin] of pins) {
    // The member may have been renamed. Match a store-bound pin against the next request's config.
    const retained = pin.store ? context.comboIds.has(pin.comboId) : ownsPin(context, pin);
    if (!retained || expired(pin, now)) remove(key, pin);
  }
  return before - pins.size;
}
export function clearComboRecallForTests(): void {
  pins.clear();
  latest.clear();
  lastReconciledGeneration = 0;
  liveOwners = undefined;
}
