import { comboFailureCooldownScope, targetKey, type getCombo } from "../../combos";
import type { ConsumedComboFailure } from "./core-options";
import { consumeComboFailure } from "./core-combo-failure";
import { isNonReplayableResponse } from "../../lib/upstream-retry";
import { wasAccountAutoPaused } from "../../oauth/account-auto-pause";
import { isReserveQuotaCode } from "./combo-stream-preflight";
import { modelHasPoolReserve } from "../../codex/pool-reserve";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { isCodexLbProvider } from "../../providers/quota/codex-lb-url";
import type { RouteResult } from "../../router";

import { stripPreviousResponseId } from "../../adapters/openai-responses/canonical-forward";
import { sanitizeReasoningInputContent } from "../../adapters/openai-responses/reasoning";
import { CODEX_TURN_STATE_HEADER } from "../../codex/forward-transport-headers";
import { isPlainObject } from "../../lib/plain-data";
import { canPortConversationState, collectConversationStateCarriers, type PortabilityDenial } from "./account-change-state";

type Combo = NonNullable<ReturnType<typeof getCombo>>;
type ComboTarget = Combo["targets"][number];

export function isReserveSeatQuotaRefusal(failure: ConsumedComboFailure, scope = comboFailureCooldownScope(
  failure.response.status, failure.classificationText, { code: failure.upstreamCode },
)): boolean {
  return (failure.response.status === 429 && scope === "target")
    || (failure.response.status === 402 && isReserveQuotaCode(failure.upstreamCode ?? failure.upstreamType)
      && !failure.upstreamRootCode && (!failure.upstreamType || isReserveQuotaCode(failure.upstreamType)));
}

/** The pool already classified this response as quota (including body-confirmed 5xx). */
export async function reserveQuotaPermitsMove(response: Response, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || wasAccountAutoPaused(response) || isNonReplayableResponse(response)) return false;
  return response.status >= 500 || isReserveSeatQuotaRefusal(await consumeComboFailure(response.clone(), signal));
}

const notStarted = new WeakSet<object>();
/** The transport proved this attempt's request never reached the host: a connect failure before any byte. */
export const markUpstreamNotStarted = (attemptLog: object): void => { notStarted.add(attemptLog); };

/**
 * Where a failover combo orders its native ChatGPT pool around a relay that fronts its own pool:
 * native Reserve (strict), then the relay, then native ordinary Luna, then the remaining targets.
 * Without this order a Reserve refusal let the native target spend ordinary Luna, so the relay's
 * own Reserve was never offered.
 */
export interface LunaReserveLegPlan {
  nativeKey: string;
  relayKey: string;
  /** Declared targets plus the extra native ordinary leg, for the shared send budget. */
  legCount: number;
}

/** Judge the same expanded transcript the child will send. A native compaction blob or an
 * encrypted task is not a reasoning summary: if any opaque carrier survives, keep its owner. */
export function prepareLunaReplay(body: unknown, expanded: boolean, headers: Headers):
  { kind: "portable"; body: unknown } | { kind: "bound"; reason: PortabilityDenial | "turn-state" | "item-reference" } {
  if (headers.has(CODEX_TURN_STATE_HEADER) || (isPlainObject(body) && isPlainObject(body.client_metadata)
    && CODEX_TURN_STATE_HEADER in body.client_metadata)) return { kind: "bound", reason: "turn-state" };
  const full = stripPreviousResponseId(body, expanded);
  if (isPlainObject(full) && Array.isArray(full.input) && full.input.some(item => isPlainObject(item) && item.type === "item_reference")) {
    return { kind: "bound", reason: "item-reference" };
  }
  const verdict = canPortConversationState(collectConversationStateCarriers(full));
  if (verdict.portable) return { kind: "portable", body: full };
  if (verdict.reason === "encrypted-reasoning") {
    const scrubbed = sanitizeReasoningInputContent(full, { stripEncryptedContent: true, dropForeignItemId: true, preserveRawReasoningContent: true });
    if (scrubbed !== full && canPortConversationState(collectConversationStateCarriers(scrubbed)).portable) {
      return { kind: "portable", body: scrubbed };
    }
  }
  return { kind: "bound", reason: verdict.reason };
}

export function planLunaReserveLegs(
  combo: Combo,
  /** The leg's real destination, or undefined when it cannot route or the caller's key may not reach it. */
  resolve: (target: ComboTarget) => RouteResult | undefined,
  eligible: (target: ComboTarget) => boolean,
  hopAllowed: (from: ComboTarget, to: ComboTarget) => boolean,
): LunaReserveLegPlan | undefined {
  // Configured model ids are enough to rule out every other combo before any route is resolved.
  if (combo.strategy !== "failover" || !combo.targets.some(target => modelHasPoolReserve(target.model))) return undefined;
  // Each leg is judged by its resolved destination: a model redirect can leave Luna, and a per-model wire
  // override can make the relay a Chat route whose failures carry no Responses no-start evidence.
  const nativeIndex = combo.targets.findIndex(target => {
    if (!modelHasPoolReserve(target.model)) return false;
    const route = resolve(target);
    return route?.codexAccountMode === "pool" && isCanonicalOpenAiForwardProvider(route.provider) && modelHasPoolReserve(route.modelId);
  });
  const native = combo.targets[nativeIndex];
  const relay = combo.targets[nativeIndex + 1];
  const relayRoute = native && relay ? resolve(relay) : undefined;
  if (!native || !relay || !relayRoute || relay.metered || !modelHasPoolReserve(relayRoute.modelId)
    || !isCodexLbProvider(relayRoute.provider) || relayRoute.staticPolicy.model.adapter !== "openai-responses"
    || !eligible(native) || !eligible(relay)
    // Both added hops must pass fallback policy, or a strict-Reserve refusal would end in fallback_refused where native ordinary Luna used to serve.
    || !hopAllowed(native, relay) || !hopAllowed(relay, native)) return undefined;
  return { nativeKey: targetKey(native), relayKey: targetKey(relay), legCount: combo.targets.length + 1 };
}

/** Only evidence that the relay never received the turn lets native ordinary Luna send it again. */
export const relayProvedNotStarted = (attemptLog: object, sendCount: number): boolean => sendCount === 0 || notStarted.has(attemptLog);
