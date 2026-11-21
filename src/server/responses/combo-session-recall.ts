import { PIN_ITEM_PROOFS, type IssuedReasoningProof, type LookupItemIssuer } from "../../responses/reasoning-replay-cache";
import { createHash } from "node:crypto";
import { routeConcreteModel } from "../../router";
import { couldServeResponsesStore } from "./core-replay";
import { getCombo, targetKey } from "../../combos/types";
import { CODEX_THREAD_AFFINITY_IDLE_TTL_MS } from "../../codex/routing/thread-affinity";
import { captureConfigGeneration, type GenerationContext } from "../../lib/state-store-sweeper";
import { affinityDigest, COMBO_EVIDENCE_LIMIT, type StoredComboEvidence, COMBO_PIN_LIMIT, registerComboPinSnapshot, type StoredComboPin as ComboPin } from "../../codex/routing/thread-affinity-store";
import type { OcxConfig, OcxComboTarget } from "../../types";

type Owners = Pick<GenerationContext, "comboIds" | "comboTargets" | "providerNames">;
const evidence = new Map<string, StoredComboEvidence>();
const pins = new Map<string, ComboPin>();
// A bare compaction selector has no combo id. Only the lane's last completion can claim it.
const latest = new Map<string, ComboPin>();
let lastReconciledGeneration = 0;
let liveOwners: Owners | undefined;

registerComboPinSnapshot({
  evidence: () => evidence.values(),
  restore({ pins: rows, evidence: issued }) {
    evidence.clear();
    for (const row of issued) {
      if (typeof row.comboId !== "string" || !Number.isSafeInteger(row.at)) continue;
      if (!/^[ri]:[a-f0-9]{64}$/.test(row.digest) || (row.store !== null && !validStore(row.store))) continue;
      if (row.digest.startsWith("r:") ? typeof row.provider !== "string" || typeof row.model !== "string"
        : row.model !== null || row.provider !== null) continue;
      evidence.set(pinKey(row.digest, row.comboId), row);
    }
    pins.clear();
    latest.clear();
    for (const pin of rows) {
      if (typeof pin.lane !== "string" || !/^[0-9a-f]{64}$/.test(pin.lane) || !Number.isSafeInteger(pin.at)
        || typeof pin.comboId !== "string" || typeof pin.provider !== "string" || typeof pin.model !== "string"
        || (pin.proofs != null && (pin.proofs.length > PIN_ITEM_PROOFS * 65 || !/^[0-9a-f]{64}(?:,[0-9a-f]{64})*$/.test(pin.proofs)))
        || (pin.store != null && !validStore(pin.store))
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

function validStore(store: unknown): store is string {
  return typeof store === "string" && /^destination:[a-f0-9]{64}\/credential:[a-f0-9]{64}$/.test(store);
}
function rememberEvidence(row: StoredComboEvidence) {
  const key = pinKey(row.digest, row.comboId);
  const prior = evidence.get(key);
  // Identical IDs or item fields observed at different stores are ambiguous, including after restart.
  if (prior && !expired(prior, row.at) && prior.store !== row.store) row.store = null;
  evidence.delete(key);
  evidence.set(key, row);
  if (evidence.size > COMBO_EVIDENCE_LIMIT) evidence.delete(evidence.keys().next().value!);
}
function responseKey(laneDigest: string, comboId: string, id: string) {
  return `r:${affinityDigest("response-id", JSON.stringify([laneDigest, comboId, id]))}`;
}
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
function expired(pin: { at: number }, now: number): boolean {
  return pin.at > now || now - pin.at > CODEX_THREAD_AFFINITY_IDLE_TTL_MS;
}
/** Store only a fixed-size digest of the provider-reported response model, never its bytes. */
function modelDigest(model: string): string | undefined {
  if (model.length > 1024 || Buffer.byteLength(model) > 1024 || !model.trim()) return undefined;
  return createHash("sha256").update(model).digest("hex");
}

export function rememberComboForLane(
  lane: string | undefined, comboId: string, target: Pick<OcxComboTarget, "provider" | "model">,
  responseModel: string, writerGeneration: number, store?: string, issued?: readonly IssuedReasoningProof[], responseId?: string,
): void {
  if (!lane || !comboId || writerGeneration < Math.max(lastReconciledGeneration, captureConfigGeneration())) return;
  const responseDigest = modelDigest(responseModel);
  if (!responseDigest) return;
  lane = affinityDigest("combo-lane", lane);
  const key = pinKey(lane, comboId);
  const previous = pins.get(key)?.proofs;
  const proofs = issued ? [...new Set([...(previous?.split(",") ?? []), ...issued.slice(-PIN_ITEM_PROOFS).map(proof => proof.owned)])].slice(-PIN_ITEM_PROOFS).join(",") : previous;
  const pin = { lane, comboId, proofs, provider: target.provider, model: target.model, responseDigest, store, at: Date.now() };
  if (liveOwners && !ownsPin(liveOwners, pin)) return;
  if (store) {
    for (const proof of issued ?? []) rememberEvidence({ digest: `i:${proof.item}`, comboId, at: pin.at, provider: null, model: null, store });
    if (responseId) {
      const digest = responseKey(lane, comboId, responseId);
      rememberEvidence({ digest, comboId, at: pin.at, provider: target.provider, model: target.model, store });
    }
  }
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
function recordedTarget(config: OcxConfig, pin: Pick<ComboPin, "provider" | "model" | "comboId" | "store">) {
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
  const named = getCombo(config, pin.comboId)?.targets.find(target => targetKey(target) === targetKey(pin));
  if (named && config.providers[named.provider] && !config.providers[named.provider]?.disabled) return pin.comboId;
  const target = recordedTarget(config, pin);
  return target && !config.providers[target.provider]?.disabled ? pin.comboId : undefined;
}
export function recallComboOwnerForLane(config: OcxConfig, lane: string | undefined, comboId: string, responseId?: string) {
  if (!lane || !comboId) return;
  const laneDigest = affinityDigest("combo-lane", lane);
  const pin = livePin(pins.get(pinKey(laneDigest, comboId)));
  const issued = responseId && evidence.get(pinKey(responseKey(laneDigest, comboId, responseId), comboId));
  const hasProof: LookupItemIssuer = (proof, store) => {
    if (pin?.proofs?.includes(proof.owned)) return "own";
    const row = evidence.get(pinKey(`i:${proof.item}`, comboId));
    if (!row?.store || expired(row, Date.now())) return "unknown";
    return row.store === store ? "own" : "foreign";
  };
  if (issued && !expired(issued, Date.now())) {
    const target = issued.store && issued.provider && issued.model ? recordedTarget(config, { ...issued, provider: issued.provider, model: issued.model }) : undefined;
    return { target, preference: target, store: issued.store ?? undefined, proofs: hasProof, idIssuer: true };
  }
  if (!pin) return;
  const target = recordedTarget(config, pin);
  // A name can still be a preference for a stateless turn after retargeting, never an issuer.
  const preference = target ?? getCombo(config, comboId)?.targets.find(member => targetKey(member) === targetKey(pin));
  return { target, preference, store: pin.store ?? undefined, proofs: hasProof, idIssuer: false };
}
export function recallComboTargetForLane(config: OcxConfig, lane: string | undefined, comboId: string): Pick<OcxComboTarget, "provider" | "model"> | undefined {
  const target = recallComboOwnerForLane(config, lane, comboId)?.target;
  return target && { provider: target.provider, model: target.model };
}
export function sweepExpiredComboRecall(now: number): number {
  const before = pins.size + evidence.size;
  for (const [key, row] of evidence) if (expired(row, now)) evidence.delete(key);
  for (const [key, pin] of pins) if (expired(pin, now)) remove(key, pin);
  return before - pins.size - evidence.size;
}
export function reconcileComboRecall(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  lastReconciledGeneration = context.generation;
  liveOwners = context;
  const before = pins.size + evidence.size;
  const now = Date.now();
  for (const [key, row] of evidence) if (!context.comboIds.has(row.comboId) || expired(row, now)) evidence.delete(key);
  for (const [key, pin] of pins) {
    // The member may have been renamed. Match a store-bound pin against the next request's config.
    const retained = pin.store ? context.comboIds.has(pin.comboId) : ownsPin(context, pin);
    if (!retained || expired(pin, now)) remove(key, pin);
  }
  return before - pins.size - evidence.size;
}
export function clearComboRecallForTests(): void {
  evidence.clear();
  pins.clear();
  latest.clear();
  lastReconciledGeneration = 0;
  liveOwners = undefined;
}
