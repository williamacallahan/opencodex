import { inspectedReserveRefusal } from "./reserve-refusal-body";
import { comboFailureDecision, comboFailureCooldownScope, comboTargetSkipTrigger, earliestComboCooldownExpiry, getCombo, isComboTargetInCooldown, targetKey, type ComboPick } from "../../combos";
import type { OcxConfig } from "../../types";
import type { ConsumedComboFailure, HandleResponsesOptions } from "./core-options";
import { consumeComboFailure } from "./core-combo-failure";
import { captureCallerDirectAuth } from "../../providers/caller-authorization";
import { isNonReplayableResponse } from "../../lib/upstream-retry";
import { wasAccountAutoPaused } from "../../oauth/account-auto-pause";
import { isReserveQuotaCode } from "./combo-stream-preflight";
import { createPoolReserveWalk, modelHasPoolReserve } from "../../codex/pool-reserve";
import { getEligiblePoolAccounts } from "../../codex/routing/selection";
import { MAIN_CODEX_ACCOUNT_ID } from "../../codex/account-id";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { isCodexLbProvider } from "../../providers/quota/codex-lb-url";
import type { RouteResult } from "../../router";

import { stripPreviousResponseId } from "../../adapters/openai-responses/canonical-forward";
import { closedReasoningPrefix, hasReasoningSummary } from "../../adapters/openai-responses/luna-reasoning";
import { sanitizeReasoningInputContent } from "../../adapters/openai-responses/reasoning";
import { CODEX_TURN_STATE_HEADER } from "../../codex/forward-transport-headers";
import { isPlainObject } from "../../lib/plain-data";
import { canPortConversationState, collectConversationStateCarriers, type PortabilityDenial } from "./account-change-state";
import { tailAgentMessageIndex } from "./encrypted-payload";

type Combo = NonNullable<ReturnType<typeof getCombo>>;
type ComboTarget = Combo["targets"][number];

export function isReserveSeatQuotaRefusal(failure: ConsumedComboFailure, scope = comboFailureCooldownScope(
  failure.response.status, failure.classificationText, { code: failure.upstreamCode },
)): boolean {
  return failure.wrappedReserveQuota === true || (failure.response.status === 429 && scope === "target")
    || (failure.response.status === 402 && isReserveQuotaCode(failure.upstreamCode ?? failure.upstreamType)
      && !failure.upstreamRootCode && (!failure.upstreamType || isReserveQuotaCode(failure.upstreamType)));
}

/** The pool already classified this response as quota (including body-confirmed 5xx). */
export async function reserveQuotaPermitsMove(response: Response, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || wasAccountAutoPaused(response) || isNonReplayableResponse(response)) return false;
  const inspection = inspectedReserveRefusal(response);
  if (response.status >= 500 && !inspection) return true;
  // Reuse the completed bounded read, never tee the stream the walker may have to return.
  const evidence = inspection ? new Response(inspection.text, { status: response.status, headers: response.headers }) : response.clone();
  const failure = await consumeComboFailure(evidence, signal);
  return response.status >= 500 ? comboFailureDecision(response.status, failure.classificationText,
    { code: failure.upstreamCode, rootCode: failure.upstreamRootCode, cyberPolicy: failure.cyberPolicy }) === "hop" : isReserveSeatQuotaRefusal(failure);
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

/** Judge the expanded transcript the child will send. The spawn decoder alone handles its assignment. */
export function prepareLunaReplay(body: unknown, expanded: boolean, headers: Headers, unreadableAssignment = false):
  { kind: "portable"; body: unknown; ownerBody?: unknown } | { kind: "bound"; reason: PortabilityDenial | "turn-state" | "item-reference" } {
  if (headers.has(CODEX_TURN_STATE_HEADER) || (isPlainObject(body) && isPlainObject(body.client_metadata)
    && CODEX_TURN_STATE_HEADER in body.client_metadata)) return { kind: "bound", reason: "turn-state" };
  const full = stripPreviousResponseId(body, expanded);
  const input: unknown[] = isPlainObject(full) && Array.isArray(full.input) ? full.input : [];
  if (input.some(item => isPlainObject(item) && item.type === "item_reference")) {
    return { kind: "bound", reason: "item-reference" };
  }
  // Only the dedicated assignment path may replace these parts; the wire body is unchanged.
  const assignment = unreadableAssignment ? input[tailAgentMessageIndex(input)] : undefined;
  const verdict = canPortConversationState(collectConversationStateCarriers(full, assignment));
  if (!verdict.portable && verdict.reason !== "encrypted-reasoning") return { kind: "bound", reason: verdict.reason };
  let boundary: number | undefined;
  for (const [i, item] of input.entries()) {
    if (!isPlainObject(item) || item.type !== "reasoning" || !(item.id || item.encrypted_content)) continue;
    boundary ??= closedReasoningPrefix(input);
    if (i >= boundary || !hasReasoningSummary(item)) return { kind: "bound", reason: "encrypted-reasoning" };
  }
  if (boundary === undefined) return verdict.portable ? { kind: "portable", body: full } : { kind: "bound", reason: verdict.reason };
  const scrubbed = sanitizeReasoningInputContent(full, { stripEncryptedContent: true, dropForeignItemId: true, preserveRawReasoningContent: true });
  return canPortConversationState(collectConversationStateCarriers(scrubbed, assignment)).portable
    ? { kind: "portable", body: scrubbed, ownerBody: full } : { kind: "bound", reason: "encrypted-reasoning" };
}

export function portSpentLunaReasoning(body: unknown, expanded: boolean, headers: Headers): unknown | undefined {
  const full = stripPreviousResponseId(body, expanded);
  if (!isPlainObject(full) || full.store === true || !Array.isArray(full.input)) return undefined;
  const boundary = closedReasoningPrefix(full.input);
  const input: unknown[] = [];
  for (const [index, item] of full.input.entries()) {
    if (isPlainObject(item) && item.type === "reasoning" && (item.id || item.encrypted_content)
      && !(index < boundary && hasReasoningSummary(item))) continue;
    if (isPlainObject(item) && "id" in item) {
      const { id: _issuerLocal, ...portable } = item;
      input.push(portable);
    } else input.push(item);
  }
  const scrubbed = sanitizeReasoningInputContent({ ...full, input }, {
    stripEncryptedContent: true, dropForeignItemId: true, preserveRawReasoningContent: true,
  });
  const replay = prepareLunaReplay(scrubbed, false, headers);
  return replay.kind === "portable" ? replay.body : undefined;
}

/** Only a self-contained, non-storing transcript can replace an unavailable turn owner. */
export function portUnavailableLunaTurn(body: unknown, headers: Headers): unknown | undefined {
  if (!isPlainObject(body) || body.store !== false || body.previous_response_id != null || body.background === true
    || Object.hasOwn(body, "stream_id") || !Array.isArray(body.input)) return;
  if (body.tools != null && (!Array.isArray(body.tools) || !body.tools.every(tool => isPlainObject(tool)
    && (tool.type === "function" || tool.type === "custom") && typeof tool.name === "string" && tool.name.trim()))) return;
  const inlineParts = (parts: unknown) => Array.isArray(parts) && parts.every(part => isPlainObject(part)
    && ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string"
      || part.type === "refusal" && typeof part.refusal === "string"
      || part.type === "input_image" && typeof part.image_url === "string" && part.image_url.startsWith("data:image/")));
  const calls = new Map<string, string>();
  let hasUserInput = false;
  for (const item of body.input) {
    if (!isPlainObject(item)) return;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (typeof item.call_id !== "string" || !item.call_id.trim() || calls.has(item.call_id) || typeof item.name !== "string"
        || !item.name.trim() || typeof (item.type === "function_call" ? item.arguments : item.input) !== "string") return;
      calls.set(item.call_id, `${item.type}_output`);
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (typeof item.call_id !== "string" || calls.get(item.call_id) !== item.type
        || (typeof item.output !== "string" && !inlineParts(item.output))) return;
      calls.set(item.call_id, "completed");
    } else if (item.type === undefined || item.type === "message") {
      if (typeof item.content !== "string" && !inlineParts(item.content)) return;
      if (item.role === "user" && (typeof item.content === "string" ? item.content.trim()
        : Array.isArray(item.content) && item.content.some(part => isPlainObject(part) && part.type === "input_text"
          && typeof part.text === "string" && part.text.trim()))) hasUserInput = true;
    } else if (item.type !== "reasoning") return;
  }
  if (!hasUserInput || [...calls.values()].some(state => state !== "completed")) return;
  const clientMetadata = isPlainObject(body.client_metadata) ? { ...body.client_metadata } : undefined;
  if (clientMetadata) delete clientMetadata[CODEX_TURN_STATE_HEADER];
  const freshHeaders = new Headers(headers);
  freshHeaders.delete(CODEX_TURN_STATE_HEADER);
  return portSpentLunaReasoning(clientMetadata ? { ...body, client_metadata: clientMetadata } : body, false, freshHeaders);
}

export function nativeLunaTarget(combo: Combo, resolve: (target: ComboTarget) => RouteResult | undefined) {
  if (combo.strategy !== "failover") return;
  return combo.targets.find(target => {
    if (!modelHasPoolReserve(target.model)) return false;
    const route = resolve(target);
    return route?.codexAccountMode === "pool" && isCanonicalOpenAiForwardProvider(route.provider) && modelHasPoolReserve(route.modelId);
  });
}

export function planLunaReserveLegs(
  combo: Combo,
  /** The leg's real destination, or undefined when it cannot route or the caller's key may not reach it. */
  resolve: (target: ComboTarget) => RouteResult | undefined,
  eligible: (target: ComboTarget) => boolean,
  hopAllowed: (from: ComboTarget, to: ComboTarget) => boolean,
  native = nativeLunaTarget(combo, resolve),
): LunaReserveLegPlan | undefined {
  // Discovery of the owner-capable native target does not require a usable relay.
  const relay = native && combo.targets[combo.targets.indexOf(native) + 1];
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

/** Return the enabled owner target only when it is specifically blocked by combo cooldown (#1299). */
export function coolingLunaOwnerTarget(
  config: OcxConfig,
  comboId: string,
  ownerKey: string | undefined,
  now: number,
): ComboTarget | undefined {
  if (!ownerKey) return undefined;
  const owner = getCombo(config, comboId)?.targets.find(target => targetKey(target) === ownerKey);
  if (!owner || config.providers[owner.provider]?.disabled) return undefined;
  return earliestComboCooldownExpiry(comboId, [owner], now) !== undefined ? owner : undefined;
}

/** True when a bound native seat may still release its turn to other Reserve seats even while relay is cooling. */
export function canWalkRemainingNativeReserve(
  config: OcxConfig,
  comboId: string,
  target: ComboTarget,
  nativeKey: string | undefined,
  alreadyReserveOnly: boolean,
  now: number,
): boolean {
  return nativeKey !== undefined
    && targetKey(target) === nativeKey
    && !alreadyReserveOnly
    && !isComboTargetInCooldown(comboId, target, now)
    && (config.codexAccounts?.length ?? 0) > 1;
}

/** Pick the successor target when porting a spent or incompatible Luna owner conversation (#1299). */
export async function portLunaConversationTarget(args: {
  config: OcxConfig;
  comboId: string;
  combo: Combo;
  fromTarget: ComboTarget;
  native: ComboTarget | undefined;
  scopedRoute: (target: ComboTarget) => RouteResult | undefined;
  eligible: (target: ComboTarget) => boolean;
  hopAllowed: (from: ComboTarget, to: ComboTarget) => boolean;
  pickTarget: (opts: { exclude?: Iterable<string>; eligible: (target: ComboTarget) => boolean; allowCooldownReprobe?: boolean }) => Promise<ComboPick | null>;
  exclude?: readonly string[];
  isPreDispatch?: boolean;
  alreadyReserveOnly: boolean;
  forbidSameTarget?: boolean;
  /** No request reached the old owner, so even a one-seat pool can start this turn fresh. */
  noOwnerSend?: boolean;
  aborted?: () => boolean;
  now: number;
}): Promise<{ pick: ComboPick; plan: LunaReserveLegPlan | undefined; reserveOnly: boolean; retryReserve: boolean; lunaStage: "off" | "reserve" | "relay" | "done" } | null> {
  const fromKey = targetKey(args.fromTarget);
  const nativeKey = args.native && targetKey(args.native);
  const plan = args.native ? planLunaReserveLegs(args.combo, args.scopedRoute, args.eligible, args.hopAllowed, args.native) : undefined;
  const skipNativeTarget = args.alreadyReserveOnly
    || (fromKey === nativeKey && Boolean(args.forbidSameTarget))
    || (Boolean(args.isPreDispatch) && fromKey === nativeKey)
    || (fromKey !== nativeKey && Boolean(nativeKey && args.exclude?.includes(nativeKey)));

  if (plan && !skipNativeTarget && args.hopAllowed(args.fromTarget, args.native!)) {
    const startNative = await args.pickTarget({
      exclude: fromKey === nativeKey ? args.exclude?.filter(key => key !== plan.nativeKey) : args.exclude,
      allowCooldownReprobe: false,
      eligible: target => targetKey(target) === plan.nativeKey && args.eligible(target),
    });
    if (args.aborted?.()) return null;
    if (startNative) return { pick: startNative, plan, reserveOnly: false, retryReserve: false, lunaStage: "reserve" };
  }

  const retryReserve = !skipNativeTarget && (args.noOwnerSend && fromKey === nativeKey
    || canWalkRemainingNativeReserve(args.config, args.comboId, args.fromTarget, nativeKey, args.alreadyReserveOnly, args.now));
  if (retryReserve) {
    const nativeRetry = await args.pickTarget({
      allowCooldownReprobe: false,
      eligible: target => targetKey(target) === nativeKey && args.eligible(target),
    });
    if (args.aborted?.()) return null;
    if (nativeRetry) return { pick: nativeRetry, plan: undefined, reserveOnly: true, retryReserve: true, lunaStage: "done" };
  }

  const relayKey = plan?.relayKey;
  const relayTarget = relayKey ? args.combo.targets.find(target => targetKey(target) === relayKey) : undefined;
  const canUseRelay = relayTarget !== undefined
    && relayKey !== fromKey
    && !(relayKey && args.exclude?.includes(relayKey))
    && args.hopAllowed(args.fromTarget, relayTarget)
    && !coolingLunaOwnerTarget(args.config, args.comboId, relayKey, args.now);
  const relayPick = canUseRelay
    ? await args.pickTarget({ exclude: args.exclude, eligible: target => targetKey(target) === relayKey && args.eligible(target) })
    : null;
  if (args.aborted?.()) return null;
  if (relayPick) return { pick: relayPick, plan, reserveOnly: false, retryReserve: false, lunaStage: "relay" };

  const skipKeys = [
    ...(args.exclude ?? []),
    fromKey,
    ...(skipNativeTarget && nativeKey ? [nativeKey] : []),
    ...(relayKey && !relayPick ? [relayKey] : []),
  ];
  const fallback = await args.pickTarget({
    exclude: skipKeys,
    eligible: target => args.eligible(target) && args.hopAllowed(args.fromTarget, target),
  });
  if (!fallback) return null;
  const fallbackKey = targetKey(fallback.target);
  const lunaLegs = plan && (fallbackKey === plan.nativeKey || fallbackKey === plan.relayKey) ? plan : undefined;
  const reserveOnly = !lunaLegs && nativeKey !== undefined && fallbackKey === nativeKey;
  const lunaStage = lunaLegs ? (fallbackKey === lunaLegs.nativeKey ? "reserve" : "relay") : "off";
  return { pick: fallback, plan: lunaLegs, reserveOnly, retryReserve: false, lunaStage };
}

export function onlyReplayIncompatibleTargetsRemain(
  targets: readonly ComboTarget[],
  config: OcxConfig,
  excluded: Iterable<string>,
  payloadEligible: (target: ComboTarget) => boolean,
  reasoningReplayEligible: (target: ComboTarget) => boolean,
): boolean {
  const excludedKeys = new Set(excluded);
  const remaining = targets.filter(target =>
    config.providers[target.provider]?.disabled !== true
    && !excludedKeys.has(targetKey(target))
    && payloadEligible(target),
  );
  return remaining.length > 0 && remaining.every(target => !reasoningReplayEligible(target));
}

export async function portCoolingLunaOwnerBeforeDispatch(args: {
  config: OcxConfig;
  comboId: string;
  combo: Combo;
  owner: ComboTarget | undefined;
  ownerKey: string;
  native: ComboTarget | undefined;
  scopedRoute: (target: ComboTarget) => RouteResult | undefined;
  eligible: (target: ComboTarget) => boolean;
  hopAllowed: (from: ComboTarget, to: ComboTarget) => boolean;
  pickTarget: (opts: { exclude?: Iterable<string>; eligible: (target: ComboTarget) => boolean; allowCooldownReprobe?: boolean }) => Promise<ComboPick | null>;
  prepareReplayEligibility: () => void;
  aborted: () => boolean;
  now: number;
}): Promise<{ pick: ComboPick; plan: LunaReserveLegPlan | undefined; reserveOnly: boolean; lunaStage: "off" | "reserve" | "relay" | "done" } | null> {
  const coolingOwner = coolingLunaOwnerTarget(args.config, args.comboId, args.ownerKey, args.now)
    ?? (args.owner && !args.config.providers[args.owner.provider]?.disabled && args.ownerKey === targetKey(args.owner)
      && (isComboTargetInCooldown(args.comboId, args.owner) || comboTargetSkipTrigger(args.config, args.owner) === "quota_exhausted")
      ? args.owner : undefined);
  if (!coolingOwner) return null;
  args.prepareReplayEligibility();
  return portLunaConversationTarget({
    config: args.config, comboId: args.comboId, combo: args.combo, fromTarget: coolingOwner,
    native: args.native, scopedRoute: args.scopedRoute, eligible: args.eligible,
    hopAllowed: args.hopAllowed, pickTarget: args.pickTarget, exclude: [args.ownerKey],
    isPreDispatch: true, alreadyReserveOnly: false, aborted: args.aborted, now: args.now,
  });
}

export async function advanceLunaLegAfterFailure(args: {
  lunaStage: "off" | "reserve" | "relay" | "done";
  failedTargetKey: string;
  legs: LunaReserveLegPlan;
  pick: ComboPick | null;
  unavailableOrdinaryTarget: string | undefined;
  attemptedTargets: readonly string[];
  aborted: boolean;
  pickOrdinary: (exclude: string[]) => Promise<ComboPick | null>;
}): Promise<{ lunaStage: "off" | "reserve" | "relay" | "done"; pick: ComboPick | null }> {
  if (!(args.lunaStage === "reserve" && args.failedTargetKey === args.legs.nativeKey
    || args.lunaStage === "relay" && args.failedTargetKey === args.legs.relayKey)) {
    return { lunaStage: args.lunaStage, pick: args.pick };
  }
  const afterReserve = args.lunaStage === "reserve";
  const ordinaryNext = afterReserve
    ? !args.pick || targetKey(args.pick.target) !== args.legs.relayKey
    : args.unavailableOrdinaryTarget !== args.legs.nativeKey;
  const nextStage: "relay" | "done" = afterReserve && args.pick && targetKey(args.pick.target) === args.legs.relayKey
    ? "relay" : "done";
  const ordinaryPick = ordinaryNext && !args.aborted
    ? await args.pickOrdinary(args.attemptedTargets.filter(key => key !== args.legs.nativeKey))
    : null;
  return {
    lunaStage: nextStage,
    pick: ordinaryPick ?? (args.pick && targetKey(args.pick.target) === args.legs.nativeKey ? null : args.pick),
  };
}

/** True when the caller supplied a direct ChatGPT-domain bearer, never proxy admission or Claude-injected main auth. */
export function hasCallerOrdinaryLunaAuth(
  headers: Headers,
  config: OcxConfig,
  options: Pick<HandleResponsesOptions, "admission" | "callerDirectAuth" | "stripClaudeMainAuthForNoncanonicalForward">,
): boolean {
  if (options.admission?.source === "bearer" || options.stripClaudeMainAuthForNoncanonicalForward === true) return false;
  const direct = options.callerDirectAuth === undefined ? captureCallerDirectAuth(headers, config) : options.callerDirectAuth;
  return direct !== null;
}

/** True when native ordinary Luna has a stored/main pool seat or a caller-owned bearer to spend. */
export const hasOrdinaryLunaCapacity = (config: OcxConfig, hasCallerAuth: boolean, now = Date.now()): boolean =>
  hasCallerAuth || getEligiblePoolAccounts(config, undefined, now, "shared").length > 0;

/** Skip strict Reserve when zero pool seats hold Reserve capacity; preserves ordinary Luna fallback. */
export async function resolveEmptyLunaReserveStart(args: {
  config: OcxConfig;
  lunaLegs: LunaReserveLegPlan | undefined;
  conversationPin: ComboPick | undefined;
  boundTargetKey: string | undefined;
  currentPick: ComboPick | null;
  targetEligible: (target: ComboTarget) => boolean;
  hasCallerAuth?: boolean;
  pickWithWait: (opts: { exclude?: Iterable<string>; eligible: (target: ComboTarget) => boolean; cooldownReprobeTargets?: Iterable<readonly [string, number]>; now: number; allowCooldownReprobe?: boolean; waitForCooldownMs?: number }) => Promise<ComboPick | null>;
}): Promise<{ pick: ComboPick | null; evaluatedStrictReserve: boolean; lunaStage: "off" | "relay" | "done"; skippedEmptyReserve: "reserve-cooldown" | "reserve-unavailable" | undefined; includedOnly: boolean }> {
  const plan = args.lunaLegs;
  const unchanged = { pick: args.currentPick, evaluatedStrictReserve: false, lunaStage: "off", skippedEmptyReserve: undefined, includedOnly: false } as const;
  if (args.conversationPin || args.boundTargetKey || !plan
    || !args.currentPick || targetKey(args.currentPick.target) !== plan.nativeKey) return unchanged;
  const now = Date.now();
  const walk = createPoolReserveWalk(args.config, now);
  if (walk.remaining.size > 0) return unchanged;
  // Native main may be draining and cannot justify skipping the relay before dispatch acquires its lease.
  const includedAvailable = getEligiblePoolAccounts(args.config, MAIN_CODEX_ACCOUNT_ID, now, "shared", { poolCapacity: "included" }).length > 0;
  const ordinaryAvailable = includedAvailable || hasOrdinaryLunaCapacity(args.config, args.hasCallerAuth === true, now);
  const cooldownReprobeTargets = args.currentPick.cooldownReprobeTargets
    ? Object.entries(args.currentPick.cooldownReprobeTargets)
    : undefined;
  const relayPick = await args.pickWithWait({
    exclude: [plan.nativeKey],
    eligible: target => targetKey(target) === plan.relayKey && args.targetEligible(target),
    cooldownReprobeTargets,
    now,
    ...(includedAvailable ? { allowCooldownReprobe: false, waitForCooldownMs: 0 } : {}),
  });
  const fallbackPick = !relayPick && !ordinaryAvailable
    ? await args.pickWithWait({
      exclude: [plan.nativeKey, plan.relayKey],
      eligible: args.targetEligible,
      cooldownReprobeTargets,
      now,
      allowCooldownReprobe: false,
    })
    : null;
  return { pick: relayPick ?? fallbackPick ?? (ordinaryAvailable ? args.currentPick : null), evaluatedStrictReserve: true, lunaStage: relayPick ? "relay" : "done",
    includedOnly: !relayPick && includedAvailable, skippedEmptyReserve: walk.hasHeldSeat ? "reserve-cooldown" : "reserve-unavailable" };
}
