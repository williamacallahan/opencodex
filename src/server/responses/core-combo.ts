import { isLegacyResponseExpansion } from "../../responses/state/body-policy";
import { comboTurnStateOwner, withComboTurnStateOwner, CodexTurnStateOwnerUnavailableError } from "../turn-state-handles";
import { comboLogLabel, comboTargetLogLabel } from "../../combos/resolve";
import { clientFacingModelLabel, clientFacingModelText } from "../../lib/error-destination";
import { projectLocalModelRefusalLog } from "../request-log-failure-detail";
import { carryProxyErrorContext, hasProxyErrorMessage, markProxyError } from "../../lib/client-error-body";
import { classifyUpstreamCondition } from "../../lib/upstream-condition";
import { effectiveAzureOutputBudget } from "../../adapters/azure";
import { buildResponsesTransport } from "../../adapters/openai-responses/transport";
import { isMetaAiResponsesDestination } from "../../responses/muse-tool-name-alias";
import { chatCanPreserveMandatoryToolChoice, hasMandatoryToolChoice } from "./combo-required-tool-contract";
import { isPolicyCandidateRefusal, isMandatoryToolChoiceRefusal } from "./policy-request-scope";
import { isCodexAccountCooldownResponse, isIssuerCapacityRefusal } from "../../codex/account-cooldown-response";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { parseSyntheticRowId } from "../fast-row";
import { resolveOpenAiVirtualModel } from "../../providers/openai-virtual-models";
import { hasUpstreamSeatPool } from "../../providers/quota/codex-lb-url";
import { clearComboTargetCooldownIfUnchanged, comboCooldownRetryAfterSeconds, relayFailureCooldownMs, isDefiniteContextOverflow, type CodexAccountModelRefusal } from "../../combos/failover";
import { fallbackHopAllowed, fallbackTriggerForStatus, guardFallbackHop } from "../../routing/fallback-policy";
import {
  isCodexReasoningEffort,
  isDeclaredReasoningEffort,
  resolveEffortAtOrBelow,
} from "../../reasoning-effort";
import { admissionMayUseMeteredComboTargets, resolveAdmissionModelScope, routeAllowedByScope } from "../admission-model-scope";
import { recordAttemptRequestedEffort } from "../request-log";
import {
  CODEX_TEXT_GUARDED_BUDGET_POLICY,
  deriveRequestExecutionBudget,
  isRequestExecutionBudget,
} from "../../lib/request-execution-budget";
import type {
  RequestExecutionBudgetPolicy,
  RequestExecutionBudget,
} from "../../lib/request-execution-budget";
import type { OcxComboDefaultEffort, OcxConfig, OcxUsage } from "../../types";
import type { RequestLogContext } from "../request-log";
import type { HandleResponsesOptions, ResponsesDispatchers, ConsumedComboFailure } from "./core-options";
import type { TranslatorBudget } from "../../lib/translator-budget";
import {
  getCombo,
  comboRequestHasImageInput,
  pickComboTarget,
  pickComboTargetWithWait,
  targetKey,
  concreteComboRequestBody,
  comboDefaultEffort,
  earliestComboCooldownExpiry,
  isComboTargetInCooldown,
  snapshotComboQuotaCooldowns,
  comboExclusionReasons,
  comboTargetSkipTrigger,
  noteComboSuccess,
  settleComboReprobeSuccess,
  comboFailureDecision,
  advanceComboAfterFailure,
  comboFailureCooldownScope,
  JEV_PROVIDER_ID,
  jevDecisionBackendFor,
  resolveJevComboDecision,
  type ComboPick,
  type JevCandidate,
  type JevDecision,
} from "../../combos";
import { formatErrorResponse } from "../../bridge";
import { SEND_BUDGET_EXHAUSTED_CODE } from "../../lib/errors";
import {
  expandPreviousResponseInput,
  previousResponseRestoredPrefixLength,
  previousResponseReplayFailure,
  previousResponseProviderState,
} from "../../responses/state";
import { hasUnreadableEncryptedAgentTask } from "./encrypted-payload";
import { eagerCodexToolCatalogSurface, warnEagerCodexToolCatalog } from "./codex-tool-catalog";
import { captureRouteStaticPolicy, routeConcreteModel, comboRouteDecisionTrace } from "../../router";
import { memoryModelRouteReason } from "./memory-models";
import { baseProviderLabel, poolAccountProviderLabel } from "../../providers/label";
import { getAccountSet } from "../../oauth/store";
import { anthropicRefusalCredentialIsCurrent } from "../../oauth/anthropic-account-refusal";
import { configuredAnthropicInstance } from "../../providers/anthropic-instance";
import { isAnthropicBillingFailure } from "../../providers/anthropic-billing-refusal";
import {
  anthropicRoutingFor,
  formatAnthropicProviderForLog,
} from "../../oauth/anthropic-routing";
import { codexAccountLogLabel, oauthAccountLogLabel } from "../../codex/account-label";
import { isGenericFailoverProvider, rotateGenericOAuthAccountOn429 } from "../../oauth/generic-account-failover";
import { codexQuotaScopeForModel, getCodexQuotaHealthSnapshot } from "../../codex/routing";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import type { AgentTaskRecoveryFailureReason } from "./agent-task-recovery";
import {
  agentTaskRecoveryConfig,
  discardEncryptedAgentTaskRecovery,
  recoverEncryptedAgentTaskWithResult,
} from "./agent-task-recovery";
import { isThreadSpawnRequest, supportedLadderFor } from "../effort-policy";
import { expandInferenceSendBudget } from "../inference/context";
import { jevChoiceEfforts } from "./jev-combo-choice";
import { applyDroidResponsesReasoningDefault } from "../droid-reasoning-default";
import { isPlainObject } from "../../lib/plain-data";
import {
  clientCancelledResponse,
  comboUnavailable,
  comboUnavailableResponse,
  targetIncompatibleResponse,
  unreadableEncryptedAgentTaskResponse,
} from "./core-errors";
import {
  buildComboChildHeaders,
  createChildPassthroughCallbackGate,
  consumeComboFailure,
  isLateAttributionRefusal,
} from "./core-combo-failure";
import {
  linkRequestSessionLane,
  reasoningReplayConversationIdFromResponsesRequest,
  sessionIdHeaderFromRequest,
} from "../request-log-conversation";
import type { CodexAuthContext } from "../../codex/auth-context";
import type { ResponsesTerminalStatus } from "../../bridge";
import { beginRequestAttempt, sealRequestAttemptIdentity, finishRequestAttempt } from "../request-log";
import { recallComboOwnerForLane, rememberComboForLane } from "./combo-session-recall";
import { COMBO_CONVERSATION_PIN_REASON, conversationPinnedPick } from "./combo-conversation-pin";
import { JEV_SESSION_PIN_ROUTE_REASON, jevSessionPinScope } from "./jev-session-pin";
import { runTurnAdapterSseResponses } from "./core-lifetime";
import { normalizePersistedJevDecision } from "../../usage/jev-stats";
import {
  isNativePassthroughSseResponse,
  isEagerRelaySseResponse,
  markNativePassthroughSseResponse,
  markEagerRelaySseResponse,
} from "../relay";
import { preflightComboStreamResponse } from "./combo-stream-preflight";
import { isOwnerCapacityRefusal, isReserveSeatQuotaRefusal, nativeLunaTarget, planLunaReserveLegs, portSpentLunaReasoning, prepareLunaReplay, relayProvedNotStarted } from "./combo-luna-legs";
import { createPoolReserveWalk, modelHasPoolReserve, type PoolCapacityIntent } from "../../codex/pool-reserve";
import { requiredToolContractOf } from "./combo-required-tool-contract";
import {
  streamingContextOverflowResponse,
  jsonContextOverflowResponse,
  lateAttributionLimitResponse,
  jsonIncompleteResponse,
  streamingIncompleteResponse,
} from "./context-overflow";
import { legacyResponseOwnerMatches, mandatoryResponsesReasoningReplayUnavailable } from "./core-replay";
import { anthropicSessionKeyFromParts } from "../../oauth/anthropic-routing";
import { agentServingThreadKey } from "../../oauth/session-affinity-key";
import { markResponseNonReplayable, isReplayRefusalResponse, settleOperatorReplacement, UPSTREAM_RESET_REPLAY_REFUSED_CODE } from "../../lib/upstream-retry";
import { attributeFinalRequest } from "../request-log-failure-attribution";
import { createComboProtocolLanes, dispatchNativeComboChild } from "./core-combo-native";
import { createJevModelInvoker } from "./jev-model-invoke";
import { comboRequestedEffortLabel } from "./combo-requested-effort";
import { clientWireOf } from "../inference/client-wire";
import { resolveContextPrincipal } from "../auth-cors";

/**
 * Sends one combo target may run on its own before the ladder moves on. A target is a whole
 * request as far as its own provider is concerned, so this is the guarded profile's base
 * allowance rather than a separate number to keep in sync.
 */
export const COMBO_TARGET_BASE_SENDS = CODEX_TEXT_GUARDED_BUDGET_POLICY.baseSendAllowance;

/**
 * OCX-11: where a combo target physically dispatches, after provider aliases and
 * blockedModelRedirects. A target that does not resolve keeps its configured selector; its
 * dispatch fails on its own.
 */
/**
 * Adopting a child's log copies only the fields the child set, so a child that never sent would
 * leave an earlier child's `sentProvider` / `nativeCacheProvider` on the parent and the cache
 * outcome would credit the wrong provider's counter to the answering one.
 */
function dropStaleSendIdentity(logCtx: RequestLogContext, childLog: RequestLogContext): void {
  if (childLog.sentProvider === undefined) delete logCtx.sentProvider;
  if (childLog.nativeCacheProvider === undefined) delete logCtx.nativeCacheProvider;
}

function resolvedComboDestination(config: OcxConfig, target: { provider: string; model: string }): { provider: string; model: string } {
  try {
    const route = routeConcreteModel(config, `${target.provider}/${target.model}`);
    return { provider: route.providerName, model: route.modelId };
  } catch {
    return { provider: target.provider, model: target.model };
  }
}

function cooledPoolAccountLabel(config: OcxConfig, providerName: string, modelId: string, label: string | undefined): string | undefined {
  if (!label) return undefined;
  const instance = configuredAnthropicInstance(config, providerName);
  if (instance && config.providers[providerName]?.authMode === "oauth") {
    const matches = getAccountSet(instance)?.accounts.filter(account =>
      formatAnthropicProviderForLog(instance, account.id) === label) ?? [];
    return matches.length === 1 && anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(matches[0]!.id) ? label : undefined;
  }
  const provider = config.providers[providerName];
  if (!provider || !isCanonicalOpenAiForwardProvider(provider)) return undefined;
  const matches = (config.codexAccounts ?? []).filter(account =>
    `${providerName}-${codexAccountLogLabel(account)}` === label);
  return matches.length === 1
    && getCodexQuotaHealthSnapshot(matches[0]!.id, codexQuotaScopeForModel(modelId))
    ? label : undefined;
}

/**
 * The generic OAuth pool's counterpart of `cooledPoolAccountLabel`. Its 429 names one account
 * through `accountLogLabel`, but the per-request account budget can end the pool's own rotation
 * before the last refused account is recorded. Hand that account to the pool's rotator, which
 * cools it under the pool's own Retry-After policy, and spare the target only when the pool still
 * has an eligible sibling. The rotator only peeks round-robin here: nothing is sent to that sibling.
 * A lone account or an all-cooled pool returns null and cools the target.
 */
function cooledGenericOAuthAccountLabel(
  config: OcxConfig, providerName: string, modelId: string, label: string | undefined, retryAfter: string | undefined,
): string | undefined {
  const provider = config.providers[providerName];
  if (!label || !provider || !isGenericFailoverProvider(providerName, provider)) return undefined;
  const base = baseProviderLabel(providerName);
  const matches = getAccountSet(providerName)?.accounts.filter(account =>
    oauthAccountLogLabel(account.id, base) === label) ?? [];
  return matches.length === 1
    && rotateGenericOAuthAccountOn429(config, providerName, matches[0]!.id, retryAfter, Date.now(), modelId, false)
    ? label : undefined;
}

/**
 * A 402 credit-balance refusal names one Anthropic OAuth account -- the evidence the pool already
 * accepts on a 403 -- but the pool rotates only on 401/403/429, so the 402 reaches the combo with
 * that account still selectable. Cool it under the pool's entitlement backoff and spare the target
 * only while a sibling is eligible; a lone account or an exhausted pool still cools the target.
 */
function creditRefusedAnthropicAccountLabel(
  config: OcxConfig, providerName: string, modelId: string, label: string | undefined,
  message: string, code: string | null | undefined, response: Response,
): string | undefined {
  const instance = configuredAnthropicInstance(config, providerName);
  if (!label || !instance || config.providers[providerName]?.authMode !== "oauth"
    || !isAnthropicBillingFailure(402, message, code)) return undefined;
  const routing = anthropicRoutingFor(instance);
  const matches = getAccountSet(instance)?.accounts.filter(account =>
    formatAnthropicProviderForLog(instance, account.id) === label) ?? [];
  return matches.length === 1
    && anthropicRefusalCredentialIsCurrent(response, instance, matches[0]!.id)
    && routing.recordAnthropicAccountRefusal(config, matches[0]!.id, 403, null)
    && routing.getEligibleAnthropicAccounts(Date.now(), modelId).length > 0
    ? label : undefined;
}

/**
 * True only for the Anthropic OAuth pool's OWN "all accounts cooled" 429. Its Retry-After is the
 * earliest per-account cooldown restated (`getAnthropicPoolRetryAfterSeconds`), which the pool
 * keeps enforcing locally, so it must not also park the combo target: an account added, resumed or
 * cleared a minute later would otherwise sit ignored until the target expired, up to the 24h
 * server-delay ceiling.
 *
 * Provenance, not just current state: the target must be the OAuth pool, no account may have been
 * identified for the failure, and the pool must be holding the wait right now. An upstream 429 on
 * a pool account always cools and names that account, and an API-key provider never qualifies, so
 * a genuine upstream Retry-After still parks the target in full.
 */
export function isAnthropicPoolLocalRefusal(
  config: OcxConfig,
  providerName: string,
  status: number,
  failedAccount: string | undefined,
  now = Date.now(),
): boolean {
  const instance = configuredAnthropicInstance(config, providerName);
  return instance !== undefined
    && config.providers[providerName]?.authMode === "oauth"
    && status === 429
    && failedAccount === undefined
    && anthropicRoutingFor(instance).getEligibleAnthropicAccounts(now).length === 0
    && anthropicRoutingFor(instance).getAnthropicPoolRetryAfterSeconds(now) !== null;
}

/**
 * A combo's execution policy is DECLARED by the combo, not inherited from the single-target
 * profile.
 *
 * `maxTargetTransitions: 1` and `maxAlternateTargetSends: 1` describe an account move, and
 * applying them to a combo would refuse the second hop of a three-target combo -- which is why
 * combo was left off `reserveDispatch` when the per-request split landed. The transitions a
 * combo may make are exactly the targets it declares minus the one it starts on. What stays
 * capped is the TOTAL: the first target's full ladder, one send for every further declared
 * target, and the one shared final-recovery reserve. A one-target combo reduces to the guarded
 * profile exactly, and a three-target combo whose every target fails hard reaches upstream six
 * times instead of the twelve #4546 measured.
 */
export function comboExecutionBudgetPolicy(declaredTargets: number, extraReserveSends = 0): RequestExecutionBudgetPolicy {
  const targets = Math.max(1, Math.trunc(declaredTargets));
  const hops = targets - 1;
  const reserve = CODEX_TEXT_GUARDED_BUDGET_POLICY.finalRecoveryAllowance;
  const total = COMBO_TARGET_BASE_SENDS + hops + reserve + extraReserveSends;
  return {
    maxTotalModelSends: total,
    baseSendAllowance: total - reserve,
    finalRecoveryAllowance: reserve,
    maxAlternateTargetSends: Math.max(1, hops),
    maxTargetTransitions: Math.max(1, hops),
  };
}


/**
 * A budget scope that keeps its own recovery ledgers but spends the SAME request-wide counter.
 *
 * The sharing has to happen inside the factory. Redefining `used` as an accessor onto the parent
 * only shared what callers read from the outside: `remainingBaseSends`, the total check and the
 * reserve test all consult the factory's own private counter, which an overridden property
 * cannot reach. Each derived scope therefore admitted dispatches as though the request had spent
 * nothing, and the per-target holdback below -- expressed against `maxTotalModelSends` -- had
 * nothing to hold back from.
 *
 * `deriveRequestExecutionBudget` binds the scope to the parent's real ledger, including pending
 * externally-counted bookings and the durable-spend observer, all of which must travel together.
 * A pending booking is a send already counted in the total and waiting for its reporter, and the
 * observer books by watching that same counter move (#4707) -- so a scope that spent the counter
 * without carrying the observer would move it without booking, and this combo's child sends
 * would go missing from the spend ledger. The reserve, alternate-target and transition ledgers
 * stay per-scope on purpose: a combo target's account failover is its own recovery decision,
 * while the request total still bounds every target together.
 */
export function deriveSendBudgetScope(
  parent: RequestExecutionBudget,
  policy: RequestExecutionBudgetPolicy,
): RequestExecutionBudget {
  const maxTotalModelSends = Math.min(policy.maxTotalModelSends, parent.policy.maxTotalModelSends);
  return deriveRequestExecutionBudget(parent, { ...policy, maxTotalModelSends,
    baseSendAllowance: Math.min(policy.baseSendAllowance, maxTotalModelSends) });
}


/**
 * The ladder one combo target may run, expressed as an allowance on the request-wide counter.
 *
 * `used + COMBO_TARGET_BASE_SENDS` gives this target its own ladder from wherever the request
 * already stands, and the clamp holds back one send for each target still declared after it: a
 * first target that 5xx-streaks must not eat the send the last declared target is entitled to.
 * That guarantee is the difference between a per-target policy and a shared pool the first
 * target drains.
 */
export function comboTargetSendBudget(
  comboScope: RequestExecutionBudget,
  targetsDeclaredAfterThisOne: number,
  reserveSeats?: number,
): RequestExecutionBudget {
  const policy = comboScope.policy;
  const heldForLaterTargets = Math.max(0, targetsDeclaredAfterThisOne);
  const ceiling = Math.max(1, policy.maxTotalModelSends - heldForLaterTargets);
  if (reserveSeats !== undefined) {
    const total = Math.min(ceiling, comboScope.used + COMBO_TARGET_BASE_SENDS + Math.max(0, reserveSeats - 1));
    const moves = Math.max(0, reserveSeats - 1);
    return deriveSendBudgetScope(comboScope, { maxTotalModelSends: total, baseSendAllowance: total,
      finalRecoveryAllowance: 0, maxAlternateTargetSends: moves, maxTargetTransitions: moves });
  }
  return deriveSendBudgetScope(comboScope, {
    maxTotalModelSends: policy.maxTotalModelSends,
    baseSendAllowance: Math.min(ceiling, comboScope.used + COMBO_TARGET_BASE_SENDS),
    finalRecoveryAllowance: policy.finalRecoveryAllowance,
    // Within one target the account-move shape is unchanged: three same-account sends plus one
    // alternate is the recovery live traffic depends on, and a combo does not widen it.
    maxAlternateTargetSends: CODEX_TEXT_GUARDED_BUDGET_POLICY.maxAlternateTargetSends,
    maxTargetTransitions: CODEX_TEXT_GUARDED_BUDGET_POLICY.maxTargetTransitions,
  });
}

interface JevComboChoice {
  pick: ComboPick;
  candidate: JevCandidate;
}

/** Enumerate this request's eligible targets without reserving another recovery pass. */
function eligibleJevComboChoices(
  config: OcxConfig,
  comboId: string,
  eligible: (target: NonNullable<ReturnType<typeof getCombo>>["targets"][number]) => boolean,
  now: number,
  cooldownReprobeTargets?: ComboPick["cooldownReprobeTargets"],
): JevComboChoice[] {
  const combo = getCombo(config, comboId);
  if (!combo) return [];
  const excluded = new Set<string>();
  const choices: JevComboChoice[] = [];
  const reserved = cooldownReprobeTargets ? Object.entries(cooldownReprobeTargets) : undefined;
  while (excluded.size < combo.targets.length) {
    const pick = pickComboTarget(config, comboId, {
      exclude: excluded, eligible, now, allowCooldownReprobe: false, cooldownReprobeTargets: reserved, routeConcreteModel,
    });
    if (!pick) break;
    const key = targetKey(pick.target);
    excluded.add(key);
    // The TypeSafe row owns a decision credential, not an inference transport.
    if (pick.target.provider === JEV_PROVIDER_ID) continue;
    const identity = jevChoiceEfforts(config, pick.target, combo.decisionQuotaSignals === true);
    if (!identity) continue;
    choices.push({
      pick: { ...pick, attempted: [key] },
      candidate: {
        key,
        provider: pick.target.provider,
        model: pick.target.model,
        ...identity,
        modelProfile: pick.target.modelProfile,
      },
    });
  }
  // #5691: the synchronous pick above does not defer emergency-only targets, so apply the
  // same rule here — withhold them from JEV while any normal target is offered, never when
  // they are all that remains.
  if (combo.cooldownWaitPolicy === "before-last-resort" && choices.some(choice => !choice.pick.target.lastResort)) {
    return choices.filter(choice => !choice.pick.target.lastResort);
  }
  return choices;
}


/** Dispatch a Responses combo within its shared send budget and preserve terminal child failures. */
export async function executeComboResponses(
  req: Request,
  rawBody: unknown,
  comboId: string,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions & { translatorBudget: TranslatorBudget },
  requestDispatchers: ResponsesDispatchers,
): Promise<Response> {
  const clientModelLabel = options.clientModelLabel ?? clientFacingModelLabel(undefined);
  const responseModel = clientFacingModelText(clientModelLabel);
  const requestedModel = options.mainHardLockFallbackOverride?.sourceModel
    ?? (typeof (rawBody as { model?: unknown } | null)?.model === "string"
      ? (rawBody as { model: string }).model
      : `combo/${comboId}`);
  if (requestedModel !== responseModel) options = { ...options, clientResponseModelLabel: clientModelLabel };
  Object.assign(logCtx, {
    requestedModel: responseModel,
    model: responseModel,
    provider: "combo",
    comboId,
  });
  const combo = getCombo(config, comboId);
  if (!combo) {
    return formatErrorResponse(404, "invalid_request_error", "Unknown combo");
  }
  // Resolve against the original request once; every bridge candidate receives the same trusted
  // result after its provisional Authorization is removed, including an explicitly keyless result.
  const replayPrincipal = options.replayPrincipal
    ?? { clientPrincipalId: resolveContextPrincipal(req, config, options.admission) };
  // The caller's model scope, resolved once from the request options. A capability-authenticated
  // internal request carries the caller's captured scope on options.admissionScope even though
  // its own admission is the host's broad key; recomputing from options.admission would lose it.
  const admissionScope = options.admissionScope ?? resolveAdmissionModelScope(config, options.admission);
  // Present only when an opted-in ingress supplied a native source; otherwise every child
  // takes the bridge below exactly as before.
  const protocolLanes = createComboProtocolLanes({
    source: options.protocolSource,
    req,
    config,
    logCtx,
    admissionScope,
    droidDefaultEffort: options.droidDefaultEffort,
    comboId,
    targets: combo.targets,
  });
  // The ladder's own scope, derived from what this combo DECLARES. It shares the request-wide
  // counter with the holder that arrived on options -- a combo child already inherited that
  // counter, but nothing read it as a limit across targets -- while its transition and
  // alternate-target ledgers come from the target list rather than from the single-target
  // account-move profile (#4546).
  // Expand previous_response_id before image policy and child dispatch so a
  // continuation that only references prior images still fails closed when
  // imageInput is disabled (and so targets see the full replayed input).
  const inboundClientThreadId = req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  let legacyTarget: string | undefined;
  const body = expandPreviousResponseInput(rawBody, inboundClientThreadId, owner => {
    if (options.compactionRoutingOverride || options.mainHardLockFallbackOverride) return false;
    const member = combo.targets.find(target => legacyResponseOwnerMatches(owner, config, targetKey(target), req.headers));
    legacyTarget = member && targetKey(member);
    return legacyTarget !== undefined;
  });
  const localExpansion = isLegacyResponseExpansion(body);
  const replayFailure = previousResponseReplayFailure(body);
  if (replayFailure?.reason === "scope_mismatch") {
    console.warn("[opencodex] refusing continuation because the client task scope does not match replay state");
  }
  // Local replay failures require full client replay.
  if (replayFailure) {
    return formatErrorResponse(
      400,
      "previous_response_not_found",
      "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
    );
  }
  // Missing state returns the original body without a failure marker. Reject
  // that unresolved continuation for image-disabled combos so a target cannot
  // resolve prior images out of band. A successful expansion yields a new
  // object (still carrying previous_response_id) and must not be treated as
  // unresolved — text-only stored continuations remain allowed.
  const requestedPreviousId = typeof (rawBody as { previous_response_id?: unknown } | null)?.previous_response_id === "string"
    ? (rawBody as { previous_response_id: string }).previous_response_id.trim()
    : "";
  const unresolvedPrevious = requestedPreviousId.length > 0 && body === rawBody;
  if (combo.imageInput === "disabled" && unresolvedPrevious) {
    return formatErrorResponse(
      400,
      "previous_response_not_found",
      "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
    );
  }
  if (combo.imageInput === "disabled" && comboRequestHasImageInput(body)) {
    return formatErrorResponse(400, "invalid_request_error", "This combo does not accept image input");
  }
  // The combo ladder owns the whole logical request, so the catalog diagnostic is counted here for
  // combo-routed turns; children run as concrete selections and would otherwise never report it.
  // Counting after the replay expansion keeps restored history out of the tally.
  if ((options.inboundWire ?? "responses") === "responses") {
    warnEagerCodexToolCatalog(body, req.headers, {
      surface: eagerCodexToolCatalogSurface(body, options.compactionRecoveryKind),
      replayPrefixLength: previousResponseRestoredPrefixLength(body),
      logicalRequest: logCtx,
    });
  }
  const comboReplaySnapshot = {
    sourceBody: body,
    previousResponseInputExpanded: body !== rawBody
      && typeof (body as { previous_response_id?: unknown }).previous_response_id === "string",
    providerContinuation: body !== rawBody && requestedPreviousId
      ? previousResponseProviderState(requestedPreviousId)
      : undefined,
    recoveredPlaintext: false,
  };
  const promptCacheKey = isPlainObject(body) && typeof body.prompt_cache_key === "string"
    ? body.prompt_cache_key : undefined;
  const replayConversationId = !inboundClientThreadId && options.inboundWire === "anthropic"
    && options.promptCacheKeyIsSharedCohort !== true && promptCacheKey?.trim()
    ? anthropicSessionKeyFromParts({
      promptCacheKey: options.sessionScopedCacheKey ?? promptCacheKey,
      promptCacheKeyIsSharedCohort: false,
    }) ?? undefined : undefined;
  // Per actual agent: a fork shares its parent's body key but has its own transcript.
  const servingThreadId = replayConversationId
    ? anthropicSessionKeyFromParts({
      promptCacheKey: agentServingThreadKey(replayConversationId, options.claudeAgentId),
      promptCacheKeyIsSharedCohort: false,
    }) ?? undefined : undefined;
  const reasoningReplayConversationId = servingThreadId
    ? replayConversationId
    : reasoningReplayConversationIdFromResponsesRequest({
      clientThreadId: inboundClientThreadId,
      threadIdHeader: req.headers.get("thread-id"),
      sessionIdHeader: sessionIdHeaderFromRequest(req.headers),
    });
  let replayEligibilityBody = body;
  const reasoningReplayEligible = (target: (typeof combo.targets)[number]): boolean => {
    try {
      const route = routeConcreteModel(config, `${target.provider}/${target.model}`);
      const unavailable = mandatoryResponsesReasoningReplayUnavailable({
        body: replayEligibilityBody,
        clientThreadId: reasoningReplayConversationId,
        servingThreadId,
        clientPrincipalId: replayPrincipal.clientPrincipalId,
        providerName: route.providerName,
        provider: route.provider,
        adapterName: route.provider.adapter,
        modelId: route.modelId,
      });
      return !unavailable;
    } catch {
      // Routing failures are not evidence of replay incompatibility. Keep the target eligible so
      // the existing selection and dispatch path preserves its original routing failure surface.
      return true;
    }
  };
  const adoptFailedChildLog = (childLog: RequestLogContext): void => {
    // Attempts remain the complete physical history; the logical row mirrors the failed
    // target whose response is returned, including an earlier quota refusal on exhaustion.
    // The ingress finalizer cannot stamp this child once activeAttempt is cleared below.
    if (childLog.activeAttempt) {
      attributeFinalRequest({
        status: childLog.activeAttempt.status,
        terminalSource: childLog.terminalSource,
        transportPhase: childLog.transportPhase,
        causeHint: childLog.causeHint,
        outputObserved: childLog.firstOutputMs !== undefined,
        locallyAnswered: childLog.localTerminalReason !== undefined,
        attempt: childLog.activeAttempt,
      });
    }
    carryProxyErrorContext(childLog, logCtx);
    dropStaleSendIdentity(logCtx, childLog);
    Object.assign(logCtx, childLog, {
      client: logCtx.client,
      requestedModel: responseModel,
      model: responseModel,
      provider: "combo",
      comboId,
      routeDecision: logCtx.routeDecision,
      attempts: logCtx.attempts,
      activeAttempt: undefined,
      activeAttemptStartedAt: undefined,
    });
    if (requestedModel !== responseModel) {
      projectLocalModelRefusalLog(logCtx, clientModelLabel);
      logCtx.model = responseModel; logCtx.requestedModel = responseModel;
      if (options.clientModelLabel) logCtx.jevDecision = undefined;
    }
  };

  const unreadableEncryptedAgentTask = hasUnreadableEncryptedAgentTask(
    (body as { input?: unknown } | undefined)?.input,
  );
  const recovery = agentTaskRecoveryConfig(config);
  const encryptedTaskRecoveryAdmitted = (options.inboundWire ?? "responses") === "responses"
    && isThreadSpawnRequest(req.headers) && !!recovery && !options.comboAttempt;
  const canDecryptUnreadableAgentTask = (target: (typeof combo.targets)[number]): boolean => {
    const provider = config.providers[target.provider];
    if (!provider || provider.disabled === true) return false;
    try {
      const route = routeConcreteModel(config, `${target.provider}/${target.model}`);
      return isCanonicalOpenAiForwardProvider(route.provider);
    } catch {
      return false;
    }
  };
  let comboPayloadReadable = false;
  const payloadEligible = (target: (typeof combo.targets)[number]): boolean =>
    comboPayloadReadable || !unreadableEncryptedAgentTask || canDecryptUnreadableAgentTask(target);
  const meteredAllowed = admissionMayUseMeteredComboTargets(config, options.admission, combo);
  const museToolEligible = (target: (typeof combo.targets)[number]): boolean => {
    if (!hasMandatoryToolChoice(body)) return true;
    try {
      const selector = `${target.provider}/${target.model}`, { fastRow, effortRow } = parseSyntheticRowId(selector, config);
      const route = routeConcreteModel(config, fastRow?.baseId ?? effortRow?.baseId ?? selector);
      const modelId = resolveOpenAiVirtualModel(route.providerName, route.modelId)?.wireModelId ?? route.modelId;
      const inboundWire = options.inboundWire ?? "responses";
      const policy = captureRouteStaticPolicy(route.providerName, modelId, route.provider,
        route.staticPolicy.effectiveAlias, inboundWire);
      const provider = resolveWireProtocolOverride(route.providerName, modelId, route.provider, inboundWire, policy);
      // Copilot's Auto account may settle on a different wire; the child checks that result.
      if (route.providerName === "github-copilot" && provider.authMode !== "forward") return true;
      return provider.adapter === "openai-chat" ? chatCanPreserveMandatoryToolChoice(body, provider, modelId)
        : provider.adapter !== "openai-responses" || !isMetaAiResponsesDestination(buildResponsesTransport(provider, { headers: req.headers }).url);
    } catch {
      return true;
    }
  };
  const onlyMuseToolIncompatible = (): boolean => {
    const enabled = combo.targets.filter(target => config.providers[target.provider]?.disabled !== true);
    return enabled.length > 0 && enabled.every(target => !museToolEligible(target));
  };
  // Recovery can replace unreadable encrypted input, but cannot relax other admission checks.
  const recoveryEligible = (target: (typeof combo.targets)[number]): boolean =>
    (meteredAllowed || !target.metered)
    && (combo.strategy !== "jev" || target.provider !== JEV_PROVIDER_ID)
    && museToolEligible(target)
    && reasoningReplayEligible(target)
    && (protocolLanes?.pickable(target) ?? true);
  let boundTargetKey: string | undefined;
  let unavailableOrdinaryTarget: string | undefined;
  const targetEligible = (target: (typeof combo.targets)[number]): boolean =>
    (!boundTargetKey || boundTargetKey === targetKey(target)) && unavailableOrdinaryTarget !== targetKey(target)
    && payloadEligible(target) && recoveryEligible(target);
  const initialNow = Date.now();
  const comboLane = options.claudeBridgePoolSession;
  // A later turn of a known conversation stays on the target that served the previous one while that target
  // is still selectable (#7298). Override routes never record a lane target, so they never pin either.
  const comboHopAllowed = (from: (typeof combo.targets)[number], to: (typeof combo.targets)[number]): boolean => {
    try {
      const [source, destination] = [from, to].map(target => routeConcreteModel(config, `${target.provider}/${target.model}`));
      return fallbackHopAllowed(config, {
        site: "combo", route: `combo/${comboId}`, aliases: [requestedModel], trigger: "unavailable", admission: options.admission,
        from: { provider: source!.providerName, model: source!.modelId }, to: { provider: destination!.providerName, model: destination!.modelId },
      });
    } catch { return false; }
  };
  // In a failover combo a pin keeps continuity, never a detour the operator no longer allows: the remembered
  // target must still be reachable from the primary under the current fallback policy.
  const failoverOrder = (combo.strategy ?? "failover") === "failover";
  // A target's concrete route when this caller's key may reach it; an unresolvable target is unreachable.
  const scopedRoute = (target: (typeof combo.targets)[number]) => {
    try {
      const route = routeConcreteModel(config, `${target.provider}/${target.model}`);
      return routeAllowedByScope(admissionScope, route) ? route : undefined;
    } catch { return undefined; }
  };
  const handleOwner = comboTurnStateOwner(req.headers, body);
  const pinEligible = (target: (typeof combo.targets)[number]): boolean => {
    if (handleOwner) {
      const route = scopedRoute(target);
      if (route?.staticPolicy.model.adapter !== "openai-responses" || !handleOwner.permitsProvider(route.providerName)) return false;
    }
    if (!((meteredAllowed || !target.metered) && targetEligible(target))) return false;
    const primary = combo.targets[0];
    if (!failoverOrder || !primary || targetKey(primary) === targetKey(target)) return true;
    // The same resolved ends the proactive hop guard below uses, so an unresolvable (disabled) primary keeps its selector.
    return fallbackHopAllowed(config, {
      site: "combo", route: `combo/${comboId}`, aliases: [requestedModel], trigger: "unavailable", admission: options.admission,
      from: resolvedComboDestination(config, primary), to: resolvedComboDestination(config, target),
    });
  };
  const missingPrevious = () => formatErrorResponse(400, "previous_response_not_found", "Resend the full conversation without previous_response_id.");
  const unavailableOwner = (missingStore = false): Response => {
    if (options.abortSignal?.aborted || req.signal.aborted) return clientCancelledResponse();
    if (unresolvedPrevious && !handleOwner) return missingPrevious();
    const target = combo.targets.find(target => targetKey(target) === boundTargetKey);
    const now = Date.now();
    const expiry = target && !config.providers[target.provider]?.disabled && scopedRoute(target) && pinEligible(target)
      ? earliestComboCooldownExpiry(comboId, [target], now) : undefined;
    const message = handleOwner ? new CodexTurnStateOwnerUnavailableError().message
      : "The owner of this conversation state is unavailable. The request was not sent.";
    const refusal = expiry !== undefined ? comboUnavailableResponse("The conversation owner is cooling down. No request was sent.", {
      retryAfter: String(Math.max(1, Math.ceil((expiry - now) / 1000))),
    }) : missingStore ? comboUnavailableResponse("The recorded conversation store is unavailable. No request was sent.")
      : markProxyError(formatErrorResponse(409, "invalid_request_error", message));
    markResponseNonReplayable(refusal);
    return refusal;
  };
  const recorded = options.compactionRoutingOverride || options.mainHardLockFallbackOverride ? undefined
    : recallComboOwnerForLane(config, comboLane, comboId, !handleOwner && unresolvedPrevious ? requestedPreviousId : undefined);
  const recalledPick = conversationPinnedPick({ config, comboId, previous: recorded?.preference, body,
    toolLoopOnly: combo.strategy === "jev", eligible: pinEligible, now: initialNow });
  const native = nativeLunaTarget(combo, scopedRoute);
  const nativeKey = native && targetKey(native);
  const lunaCandidate = native !== undefined || combo.strategy === "failover" && combo.targets.some(target =>
    modelHasPoolReserve(target.model) && config.providers[target.provider] && isCanonicalOpenAiForwardProvider(config.providers[target.provider]!));
  // Name recall for readable compaction grants no right to send bound input to a replacement store.
  const projectStore = lunaCandidate || (recorded?.store && isPlainObject(body) && Array.isArray(body.input)
    && body.input.some(entry => isPlainObject(entry) && entry.type === "compaction_trigger"));
  let lunaReplay = handleOwner || projectStore || unresolvedPrevious ? prepareLunaReplay(body, comboReplaySnapshot.previousResponseInputExpanded && !localExpansion,
    req.headers, unreadableEncryptedAgentTask && encryptedTaskRecoveryAdmitted) : undefined;
  const ported = native && lunaReplay?.kind === "bound" && lunaReplay.reason === "encrypted-reasoning"
    ? portSpentLunaReasoning(body, comboReplaySnapshot.previousResponseInputExpanded && !localExpansion, req.headers) : undefined;
  if (ported !== undefined) replayEligibilityBody = ported;
  const lunaPair = native && !unreadableEncryptedAgentTask ? planLunaReserveLegs(combo, scopedRoute, targetEligible, comboHopAllowed, native) : undefined;
  replayEligibilityBody = body;
  let lunaLegs = lunaReplay?.kind === "portable" ? lunaPair : undefined;
  let dispatchBody = lunaReplay?.kind === "portable" ? lunaReplay.body : body;
  if (unresolvedPrevious && !handleOwner && !recorded?.idIssuer) return unavailableOwner();
  if (lunaReplay?.kind === "bound") {
    const owner = legacyTarget ? combo.targets.find(target => targetKey(target) === legacyTarget) : recorded?.target;
    if (handleOwner) {
      const match = combo.targets.find(target => owner && targetKey(target) === targetKey(owner) && pinEligible(target)) ?? combo.targets.find(pinEligible);
      boundTargetKey = match && targetKey(match);
    } else if (owner && (legacyTarget || recorded?.store)) {
      if (!pinEligible(owner)) return unavailableOwner();
      boundTargetKey = targetKey(owner);
    }
    if (!boundTargetKey) {
      if (options.abortSignal?.aborted || req.signal.aborted) return clientCancelledResponse();
      if (lunaReplay.reason === "previous-response-id") return missingPrevious();
      return unavailableOwner(!handleOwner && lunaReplay.reason !== "turn-state");
    }
  }
  if (localExpansion && legacyTarget !== undefined) {
    if (boundTargetKey && legacyTarget !== boundTargetKey) return unavailableOwner();
    boundTargetKey = legacyTarget;
  }
  // Recall identifies a provider, not an account dependency. A portable relay pin cannot skip Reserve.
  const conversationPin = recalledPick && (!boundTargetKey || boundTargetKey === targetKey(recalledPick.target))
    && (!lunaLegs || targetKey(recalledPick.target) === lunaLegs.nativeKey) ? recalledPick : undefined;
  let evaluatedStrictReserve = false;
  let lunaStage: "off" | "reserve" | "relay" | "done" = "off";
  const comboLegCount = ported !== undefined && lunaPair ? lunaPair.legCount + 1 : lunaLegs?.legCount ?? combo.targets.length;
  const onlyReplayIncompatibleTargetsRemain = (excluded: Iterable<string> = []): boolean => {
    const excludedKeys = new Set(excluded);
    const remaining = combo.targets.filter(target => {
      const provider = config.providers[target.provider];
      return provider?.disabled !== true
        && !excludedKeys.has(targetKey(target))
        && payloadEligible(target);
    });
    return remaining.length > 0 && remaining.every(target => !reasoningReplayEligible(target));
  };
  let encryptedTaskRecoveryAttempted = false;
  let recoveryFailureReason: AgentTaskRecoveryFailureReason | undefined;
  let storedPool401ReplayDispatched = false;
  const recoverUnreadableEncryptedTask = async (): Promise<boolean> => {
    if (encryptedTaskRecoveryAttempted) return false;
    encryptedTaskRecoveryAttempted = true;
    if (!encryptedTaskRecoveryAdmitted || !recovery) {
      discardEncryptedAgentTaskRecovery(
        req,
        (body as { input?: unknown } | undefined)?.input,
        config,
        { parentThreadId: inboundClientThreadId },
      );
      return false;
    }
    let recovered = false;
    try {
      const result = await recoverEncryptedAgentTaskWithResult(
        req,
        (body as { input?: unknown } | undefined)?.input,
        recovery,
        config,
        { parentThreadId: inboundClientThreadId, abortSignal: options.abortSignal },
      );
      recovered = result.recovered;
      recoveryFailureReason = result.recovered ? undefined : result.reason;
    } catch {
      recovered = false;
      recoveryFailureReason = undefined;
    }
    // Recovery has the same in-place input mutation contract as the direct routed path.
    if (
      !recovered
      || hasUnreadableEncryptedAgentTask((body as { input?: unknown } | undefined)?.input)
    ) {
      discardEncryptedAgentTaskRecovery(
        req,
        (body as { input?: unknown } | undefined)?.input,
        config,
        { parentThreadId: inboundClientThreadId },
      );
      return false;
    }
    comboPayloadReadable = true;
    comboReplaySnapshot.recoveredPlaintext = true;
    return true;
  };
  const pickWithWait = (pickOptions: {
    exclude?: Iterable<string>;
    eligible?: (target: NonNullable<typeof combo>["targets"][number]) => boolean;
    allowCooldownReprobe?: boolean;
    /** This request's own cooldown-reprobe reservation, carried through its failover hops. */
    cooldownReprobeTargets?: Iterable<readonly [string, number]>;
    now?: number;
  }) => pickComboTargetWithWait(config, comboId, {
    ...pickOptions,
    allowCooldownReprobe: boundTargetKey ? false : pickOptions.allowCooldownReprobe,
    routeConcreteModel,
    // Every pick, including the recovery picks that skip `targetEligible`, keeps metered
    // targets away from callers that may not spend on them.
    eligible: target => (!boundTargetKey || targetKey(target) === boundTargetKey) && (meteredAllowed || !target.metered) && (pickOptions.eligible?.(target) ?? true),
    waitForCooldownMs: combo.waitForCooldownMs,
    abortSignal: options.abortSignal,
  });
  let pick = conversationPin ?? await pickWithWait({
    eligible: targetEligible,
    now: initialNow,
  });
  // Opt-in JEV session pin (#7525); override routes neither read nor write it, like the lane recall.
  const jevPin = options.compactionRoutingOverride || options.mainHardLockFallbackOverride
    ? undefined
    : jevSessionPinScope({ combo, comboId, admission: options.admission, lane: comboLane });

  if (!pick && (handleOwner || boundTargetKey && !unreadableEncryptedAgentTask)) return unavailableOwner();
  if (unreadableEncryptedAgentTask && !pick) {
    pick = await pickWithWait({
      eligible: recoveryEligible,
      allowCooldownReprobe: encryptedTaskRecoveryAdmitted,
      now: initialNow,
    });
    if (!pick) {
      discardEncryptedAgentTaskRecovery(
        req,
        (body as { input?: unknown } | undefined)?.input,
        config,
        { parentThreadId: inboundClientThreadId },
      );
      if (boundTargetKey && !options.abortSignal?.aborted) return unavailableOwner();
      if (!options.abortSignal?.aborted && onlyMuseToolIncompatible()) {
        return comboUnavailableResponse("No available targets for combo; targets cannot preserve mandatory tool_choice");
      }
      return options.abortSignal?.aborted
        ? clientCancelledResponse()
        : comboUnavailable(comboId, undefined,
          comboExclusionReasons(config, comboId, recoveryEligible));
    }
    if (!(await recoverUnreadableEncryptedTask())) {
      return options.abortSignal?.aborted
        ? clientCancelledResponse()
        : unreadableEncryptedAgentTaskResponse(recoveryFailureReason);
    }
  }

  if (!pick) {
    // Every enabled candidate skipped as unrepresentable: the ingress refusal, with no send.
    const protocolRefusal = protocolLanes?.refusal();
    if (protocolRefusal) return protocolRefusal;
    if (onlyReplayIncompatibleTargetsRemain()) return targetIncompatibleResponse();
    if (!options.abortSignal?.aborted && onlyMuseToolIncompatible()) {
      return comboUnavailableResponse("No available targets for combo; targets cannot preserve mandatory tool_choice");
    }
    return options.abortSignal?.aborted
      ? clientCancelledResponse()
      : comboUnavailable(comboId, undefined, comboExclusionReasons(config, comboId, targetEligible));
  }
  // OCX-11: an ordered failover combo that starts on a later target than its first one, for any
  // reason (cooling down, provider disabled, cached quota spent, ineligible for this request),
  // makes a proactive hop, so the fallback policy decides before anything is sent. Both ends are
  // the resolved destinations, after provider aliases and blockedModelRedirects.
  const primaryTarget = combo.targets[0];
  // An allowed hop is recorded only once its dispatch is admitted below.
  let pendingHopCommit: (() => void) | undefined;
  if (!conversationPin && (combo.strategy ?? "failover") === "failover" && primaryTarget
    && targetKey(primaryTarget) !== targetKey(pick.target)) {
    const primaryCooling = isComboTargetInCooldown(comboId, primaryTarget, initialNow);
    const proactive = guardFallbackHop(config, {
      site: "combo",
      route: `combo/${comboId}`,
      aliases: [requestedModel],
      from: resolvedComboDestination(config, primaryTarget),
      to: resolvedComboDestination(config, pick.target),
      trigger: primaryCooling ? "cooldown" : comboTargetSkipTrigger(config, primaryTarget, initialNow),
      admission: options.admission,
      retryAfter: primaryCooling ? comboCooldownRetryAfterSeconds(comboId, initialNow) ?? null : null,
      now: initialNow,
    });
    if (!proactive.ok) return proactive.response;
    pendingHopCommit = proactive.commit;
  }
  let jevDecision: JevDecision | undefined;
  if (combo.strategy === "jev" && !conversationPin) {
    const choices = eligibleJevComboChoices(config, comboId, targetEligible, Date.now(), pick.cooldownReprobeTargets);
    const first = choices[0];
    if (!first) {
      return comboUnavailable(comboId, undefined, comboExclusionReasons(config, comboId, target =>
        targetEligible(target) && target.provider !== JEV_PROVIDER_ID && jevChoiceEfforts(config, target, false) !== undefined));
    }
    const fallbackFor = (choice: JevComboChoice): Pick<JevDecision, "targetKey" | "effort"> => {
      const effort = resolveEffortAtOrBelow("medium", choice.candidate.reasoningEfforts);
      return {
        targetKey: choice.candidate.key,
        effort: effort && isCodexReasoningEffort(effort) ? effort as OcxComboDefaultEffort : null,
      };
    };
    const fallback = fallbackFor(first);
    const decisionStartedAt = Date.now();
    const pinReuse = jevPin?.reuse(
      choices.map(choice => choice.candidate),
      combo.decisionQuotaSignals === true ? { config, tiers: combo.decisionQuotaTiers } : undefined,
    );
    let decision: JevDecision;
    if (pinReuse?.decision) decision = pinReuse.decision;
    else try {
      decision = await resolveJevComboDecision({
        body,
        candidates: choices.map(choice => choice.candidate),
        fallback,
        config,
        isDestinationAllowed: (providerName, modelId) => routeAllowedByScope(
          admissionScope, { providerName, modelId },
        ),
        ...(combo.decisionQuotaSignals === true ? { decisionQuotaSignals: true, decisionQuotaTiers: combo.decisionQuotaTiers } : {}),
        ...(combo.decisionProvider ? { decisionProvider: combo.decisionProvider } : {}),
        ...(combo.decisionModel
          ? {
            decisionModel: combo.decisionModel,
            invokeModel: createJevModelInvoker({
              req,
              config,
              options: { ...options, admissionScope },
              handleResponses: requestDispatchers.handleResponses,
            }),
          }
          : {}),
        ...(combo.decisionTimeoutMs !== undefined ? { timeoutMs: combo.decisionTimeoutMs } : {}),
        signal: options.abortSignal,
      });
    } catch (error) {
      if (options.abortSignal?.aborted) return clientCancelledResponse();
      decision = {
        backend: jevDecisionBackendFor(combo),
        ...fallback,
        gate: "network",
        latencyMs: Math.max(0, Date.now() - decisionStartedAt),
      };
    }
    let selected = choices.find(choice => choice.candidate.key === decision.targetKey) ?? first;
    let selectionUnavailable = false;
    if ((pick.cooldownReprobeTargets || selected.pick.poolCooldownRevision !== undefined) && !options.abortSignal?.aborted) {
      // Another request can replace a cooldown while the decision is awaited. Recheck the
      // original reservation, current availability and request eligibility without reserving again.
      const currentChoices = eligibleJevComboChoices(config, comboId, targetEligible, Date.now(), pick.cooldownReprobeTargets);
      const current = currentChoices.find(choice => choice.candidate.key === decision.targetKey
        && (decision.effort === null ? choice.candidate.reasoningEfforts.length === 0
          : choice.candidate.reasoningEfforts.includes(decision.effort)));
      const available = current ?? currentChoices[0];
      if (available) selected = available;
      else selectionUnavailable = true;
      if (!current) {
        // Keep completed decision usage even when no target remains. Old scores and quota
        // selection describe neither a fail-open replacement nor a rejected selection.
        decision = {
          backend: decision.backend,
          ...(available ? fallbackFor(available) : { targetKey: decision.targetKey, effort: decision.effort }),
          gate: decision.gate === "apply" ? "invalid" : decision.gate,
          latencyMs: decision.latencyMs,
          ...(decision.usage ? { usage: decision.usage } : {}),
        };
      }
    }
    if (pinReuse?.released) decision = { ...decision, pinReason: pinReuse.released };
    jevDecision = decision;
    pick = { ...selected.pick, attempted: [targetKey(selected.pick.target)] };
    logCtx.jevDecision = !options.clientModelLabel || requestedModel === responseModel ? normalizePersistedJevDecision({
      version: 1,
      comboId,
      selected: {
        provider: selected.pick.target.provider,
        model: selected.pick.target.model,
        effort: decision.effort,
      },
      gate: decision.gate,
      latencyMs: decision.latencyMs,
      backend: decision.backend,
      ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
      ...(decision.chosenProbability !== undefined
        ? { chosenProbability: decision.chosenProbability }
        : {}),
      ...(decision.usage ? { usage: decision.usage } : {}),
      ...(decision.quota ? { quota: decision.quota } : {}),
      ...(decision.pinned ? { pinned: true } : {}),
      ...(decision.pinReason ? { pinReason: decision.pinReason } : {}),
    }) : undefined;
    console.debug("[combo] JEV decision", {
      backend: decision.backend,
      target: comboTargetLogLabel(config, comboId, pick.target),
      effort: decision.effort,
      gate: decision.gate,
      latencyMs: decision.latencyMs,
      ...(decision.pinReason ? { pinReason: decision.pinReason } : {}),
      ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
      ...(decision.chosenProbability !== undefined
        ? { chosenProbability: decision.chosenProbability }
        : {}),
      ...(decision.usage ? { usage: decision.usage } : {}),
    });
    // A completed decision belongs to the parent log even if no model can be dispatched.
    if (selectionUnavailable) {
      return comboUnavailable(comboId, undefined, comboExclusionReasons(config, comboId, target =>
        targetEligible(target) && target.provider !== JEV_PROVIDER_ID && jevChoiceEfforts(config, target, false) !== undefined));
    }
  }
  // One immutable combo selection trace, before any child dispatch; child
  // adoption below must never replace it with a concrete child route trace.
  const decision = comboRouteDecisionTrace(config, comboId, pick, responseModel);
  const selectedReason = options.memoryModelPhase
    ? memoryModelRouteReason(options.memoryModelPhase)
    : lunaReplay?.kind === "bound" ? `luna-owner-${lunaReplay.reason}`
    : lunaLegs?.nativeKey === targetKey(pick.target) ? "luna-reserve-first"
    : conversationPin ? COMBO_CONVERSATION_PIN_REASON : jevDecision?.pinned ? JEV_SESSION_PIN_ROUTE_REASON : undefined;
  logCtx.routeDecision = selectedReason
    ? { ...decision, selected: { ...decision.selected, reason: selectedReason } }
    : decision;

  const originalReasoning = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { reasoning?: unknown }).reasoning
    : undefined;
  const originalRequestedEffortValue = originalReasoning && typeof originalReasoning === "object" && !Array.isArray(originalReasoning)
    ? (originalReasoning as { effort?: unknown }).effort
    : undefined;
  const originalRequestedEffort = typeof originalRequestedEffortValue === "string"
    && isDeclaredReasoningEffort(originalRequestedEffortValue)
    ? originalRequestedEffortValue
    : undefined;
  const restoreOriginalRequestedEffort = (childLog: RequestLogContext, forcedEffort?: string | null): void => {
    if (originalRequestedEffort === undefined) return;
    childLog.requestedEffort = comboRequestedEffortLabel(originalRequestedEffort, childLog.requestedEffort, forcedEffort);
    recordAttemptRequestedEffort(childLog);
  };

  let lastFailure: Response | null = null;
  let originalReserveRefusal: Response | undefined;
  // Dispatched targets, not attempted picks: it indexes the declared target list so the clamp
  // below can tell how many targets are still entitled to a send.
  let comboTargetsDispatched = 0;
  // The child log behind `lastFailure`. The natural end of the ladder adopts it inside the
  // no-more-targets branch; a budget refusal ends the ladder one iteration later, where that
  // iteration's own `childLog` is already out of scope.
  let lastFailedChildLog: RequestLogContext | undefined;
  // The target behind `lastFailure`, so the next dispatch can tell a hop from a same-target retry.
  let lastFailedTarget: { provider: string; model: string } | undefined;
  let lastFailedRetryAfter: string | undefined;
  // The exhausted-combo mapping below runs outside the loop, where `failure.upstreamCode`
  // is gone, so carry the loop's own classification decision instead of re-deriving a
  // weaker one from the status alone (#4149).
  let lastFailureClassifiesOverflow = false;
  let zeroOutputLimitFailure: { childLog: RequestLogContext; usage?: OcxUsage } | undefined;
  let lastFailureUpstreamCode: string | undefined;
  const wantsStream = (rawBody as { stream?: unknown } | null)?.stream === true || (body as { stream?: unknown } | null)?.stream === true;
  // Local input admission refusals (#1524), while every failed target so far was one: such a
  // target sent nothing, so an exhausted ladder must not be reported as a provider rejection.
  let localAdmissionRefusals: string[] | undefined = [];
  let toolChoiceRefusalsOnly: boolean | undefined;
  // The first quota/rate-limit refusal of the ladder. A fallback that then refuses its own
  // credential or plan (401/403, or a 400 the ladder hopped past) says nothing about why the
  // request failed: the primary target ran out. Returning that fallback refusal told clients
  // "OpenAI account pool has no usable account credential" while every Claude account was spent.
  let quotaFailure: Response | undefined;
  let quotaFailedChildLog: RequestLogContext | undefined;
  let contextFailure: { response: Response; childLog: RequestLogContext } | undefined;
  // Snapshotted before dispatch: a 401/403 inside this ladder cools its own provider, and that
  // fresh cooldown is not a reason the request found no target.
  const quotaCooldownSnapshot = snapshotComboQuotaCooldowns(config, comboId);
  const exhaustedFailure = (targetsExhausted = false): Response => {
    if (contextFailure) {
      adoptFailedChildLog(contextFailure.childLog);
      return contextFailure.response;
    }
    if (lastFailure && lastFailureUpstreamCode === "zero_output_token_limit" && zeroOutputLimitFailure) {
      adoptFailedChildLog(zeroOutputLimitFailure.childLog);
      return wantsStream
        ? streamingIncompleteResponse(responseModel, zeroOutputLimitFailure.usage, "max_output_tokens", options.translatorBudget)
        : jsonIncompleteResponse(responseModel, zeroOutputLimitFailure.usage, "max_output_tokens");
    }
    const returnsQuota = lastFailure && [400, 401, 403].includes(lastFailure.status) && quotaFailure;
    const failedChildLog = returnsQuota ? quotaFailedChildLog : lastFailedChildLog;
    if (failedChildLog) adoptFailedChildLog(failedChildLog);
    if (targetsExhausted && toolChoiceRefusalsOnly === true) return comboUnavailableResponse("No available targets for combo; attempted targets cannot preserve mandatory tool_choice");
    if (!lastFailure || ![400, 401, 403].includes(lastFailure.status)) return originalReserveRefusal ?? lastFailure!;
    if (quotaFailure) return quotaFailure;
    // The quota-refused target was cooled before this request picked, so the ladder never saw
    // its refusal. The cooldown, with its Retry-After, is still the honest answer.
    let quotaCooldownUntil: number | undefined;
    const now = Date.now();
    for (const { target, cooldownUntil } of quotaCooldownSnapshot) {
      if (cooldownUntil <= now) continue;
      try {
        if (!targetEligible(target)) continue;
      } catch {
        // An eligibility check can exhaust the translator budget; it is not quota evidence.
        continue;
      }
      quotaCooldownUntil = Math.min(quotaCooldownUntil ?? cooldownUntil, cooldownUntil);
    }
    const remainingQuotaCooldownMs = quotaCooldownUntil === undefined ? 0 : quotaCooldownUntil - Date.now();
    return remainingQuotaCooldownMs > 0
      ? comboUnavailableResponse("No available targets for combo", {
        retryAfter: String(Math.max(1, Math.ceil(remainingQuotaCooldownMs / 1000))),
      }) : lastFailure;
  };
  // The caller's output ceiling, captured once so a floor applied to one target never
  // leaks into the next. An established parent estimate wins; otherwise (combo dispatch
  // precedes request preparation) the caller's own positive cap is reserved.
  const callerBudget = isPlainObject(body) ? body.max_output_tokens : undefined;
  const callerOutputCeilingTokens = logCtx.spendOutputCeilingTokens
    ?? (typeof callerBudget === "number" && Number.isFinite(callerBudget) && callerBudget > 0
      ? Math.trunc(callerBudget) : undefined);
  let reserveWalk = isRequestExecutionBudget(options.sendBudget)
    && (lunaLegs || ported !== undefined && lunaPair)
    ? createPoolReserveWalk(config) : undefined;
  const ordinaryPoolSends = 1 + CODEX_TEXT_GUARDED_BUDGET_POLICY.maxAlternateTargetSends;
  // A previously charged ledger can still visit unreported seats, but cannot grow its send limit.
  const walkHeadroom = options.sendBudget?.used === 0 ? Math.max(0, (reserveWalk?.remaining.size ?? 0) - ordinaryPoolSends) : 0;
  const ladderPolicy = comboExecutionBudgetPolicy(comboLegCount, walkHeadroom);
  expandInferenceSendBudget(options.sendBudget, ladderPolicy.maxTotalModelSends, ladderPolicy.baseSendAllowance);
  let comboSendScope = isRequestExecutionBudget(options.sendBudget) ? deriveSendBudgetScope(options.sendBudget, ladderPolicy) : undefined;
  while (pick) {
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const firstComboTarget = comboTargetsDispatched === 0;
    const legTargetKey = targetKey(pick.target);
    if (lunaLegs && firstComboTarget) lunaStage = legTargetKey === lunaLegs.nativeKey ? "reserve" : legTargetKey === lunaLegs.relayKey ? "relay" : "off";
    if (lunaLegs && legTargetKey === lunaLegs.nativeKey && !evaluatedStrictReserve) {
      lunaStage = "reserve";
      evaluatedStrictReserve = true;
    }
    const legIntent: PoolCapacityIntent | undefined = boundTargetKey && boundTargetKey === nativeKey ? "owner-only"
      : legTargetKey !== lunaLegs?.nativeKey ? undefined
      : lunaStage === "reserve" ? "reserve-only" : lunaStage === "done" ? "ordinary-only" : undefined;
    // The physical destination after provider aliases and blockedModelRedirects: hops are
    // classified by where the request really goes, not by the selector the combo names.
    const targetRoute = routeConcreteModel(config, `${pick.target.provider}/${pick.target.model}`);
    // Selection-free hard-lock preflight grants no hop. Enforce this actual first destination
    // against the locked source, after aliases and redirects resolve.
    if (firstComboTarget && options.mainHardLockFallbackOverride) {
      const hop = guardFallbackHop(config, {
        site: "combo",
        route: `combo/${comboId}`,
        aliases: [requestedModel],
        from: { provider: OPENAI_CODEX_PROVIDER_ID, model: options.mainHardLockFallbackOverride.sourceModel },
        to: { provider: targetRoute.providerName, model: targetRoute.modelId },
        trigger: "hard_lock",
        admission: options.admission,
      });
      if (!hop.ok) return hop.response;
      const declaredCommit = pendingHopCommit;
      pendingHopCommit = declaredCommit ? () => { declaredCommit(); hop.commit(); } : hop.commit;
    }
    // OCX-11: every later dispatch after a failure is a hop when the target changed. One check
    // here covers the ordinary failover pick and the recovery picks alike.
    if (!firstComboTarget && lastFailure && lastFailedTarget) {
      const hop = guardFallbackHop(config, {
        site: "combo",
        route: `combo/${comboId}`,
        aliases: [requestedModel],
        from: lastFailedTarget,
        to: { provider: targetRoute.providerName, model: targetRoute.modelId },
        trigger: fallbackTriggerForStatus(lastFailure.status),
        admission: options.admission,
        failureStatus: lastFailure.status,
        retryAfter: lastFailedRetryAfter ?? null,
      });
      if (!hop.ok) {
        if (lastFailedChildLog) adoptFailedChildLog(lastFailedChildLog);
        return originalReserveRefusal ?? hop.response;
      }
      pendingHopCommit = hop.commit;
    }
    // The inherited spend tracker observes this parent log, before the child has its own label.
    logCtx.spendPoolId = targetRoute.providerName;
    // Combo prepays before its child normalizes the route; the parent tracker must
    // already see this target's effective cap rather than a previous target's cap.
    const spendProvider = resolveWireProtocolOverride(targetRoute.providerName, targetRoute.modelId,
      targetRoute.provider, options.inboundWire ?? "responses", targetRoute.staticPolicy);
    const responsesWire = spendProvider.adapter === "openai-responses";
    if (recorded?.idIssuer && (!responsesWire || spendProvider.authMode === "forward" || spendProvider.statelessResponses)) return missingPrevious();
    if (boundTargetKey && !localExpansion && recorded?.store && !responsesWire) return unavailableOwner();
    const outputBudget = effectiveAzureOutputBudget(spendProvider, callerBudget);
    if (outputBudget !== callerBudget && typeof outputBudget === "number" && outputBudget > 0) {
      logCtx.spendOutputCeilingTokens = Math.trunc(outputBudget);
    } else if (callerOutputCeilingTokens === undefined) {
      delete logCtx.spendOutputCeilingTokens;
    } else {
      logCtx.spendOutputCeilingTokens = callerOutputCeilingTokens;
    }
    // Derive the target's allowance before booking its initial send; the booking occupies it.
    const walkSeats = legIntent === "reserve-only" ? reserveWalk : undefined;
    const targetSendBudget = comboSendScope
      ? comboTargetSendBudget(comboSendScope, comboLegCount - 1 - comboTargetsDispatched, walkSeats?.remaining.size)
      : options.sendBudget;
    // Every target prepays one send. Only its child may consume that booking; later targets
    // remain bounded by the shared total, transition ledger and per-target holdback.
    // `countedExternally` is required: the child charges its own physical sends against this
    // booking through the exact permit, and charging here as well would halve the cap.
    const hopDecision = comboSendScope?.reserveDispatch({
      sendClass: firstComboTarget ? "initial" : "combo-failover",
      targetKey: `${pick.target.provider}/${pick.target.model}`,
      countedExternally: true,
    });
    if (hopDecision && !hopDecision.allowed && firstComboTarget) {
      // A refused initial reservation authorizes no child send and has no upstream failure to return.
      return formatErrorResponse(429, SEND_BUDGET_EXHAUSTED_CODE, "request send budget exhausted before combo dispatch");
    }
    else if (hopDecision && !hopDecision.allowed) {
      // Out of budget is not this target's failure. The established exhaustion contract is to
      // return the last real upstream answer with its status, headers and any quota body
      // intact rather than to mint a synthetic error, and a later target only exists because
      // an earlier one already recorded one.
      return exhaustedFailure();
    }
    if (originalReserveRefusal) {
      void originalReserveRefusal.body?.cancel().catch(() => undefined);
      originalReserveRefusal = undefined;
    }
    // Admitted: only now is a guarded hop to this target recorded as taken.
    pendingHopCommit?.();
    pendingHopCommit = undefined;
    const initialSend = hopDecision?.allowed ? { permit: hopDecision.permit, producerOwned: false } : undefined;
    try {
    comboTargetsDispatched += 1;
    const childLog: RequestLogContext = {
      model: pick.target.model,
      provider: pick.target.provider,
      ...(logCtx.conversationId ? { conversationId: logCtx.conversationId } : {}),
      ...(logCtx.surface ? { surface: logCtx.surface } : {}),
    };
    const targetReasoningEfforts = supportedLadderFor({
      provider: targetRoute.provider,
      modelId: targetRoute.modelId,
    });
    const initialJevDecision = firstComboTarget ? jevDecision : undefined;
    // `client` keeps the decision's target but not its tier: the caller and the target ladder
    // own the wire effort, so a provider whose effort swaps the upstream model id is never
    // re-tiered mid-session and its prompt cache survives the turn.
    const jevEffortApplies = initialJevDecision !== undefined && combo.jevEffortMode !== "client";
    // Native Responses can decide from the final credential; other wires get only the proven cross-owner copy.
    const lateReasoningProjection = responsesWire && (((projectStore || recorded?.idIssuer) && lunaReplay?.kind === "bound") || (localExpansion && recorded?.store)) ? "owner"
      : responsesWire && lunaReplay?.kind === "portable" && lunaReplay.ownerBody !== undefined ? "portable" : undefined;
    // A verified handle owns its physical send even when lane recall names another account.
    const recordedResponsesStore = handleOwner || localExpansion ? undefined : recorded?.store;
    const targetBody = lateReasoningProjection === "portable" && lunaReplay?.kind === "portable" ? lunaReplay.ownerBody : dispatchBody;
    const childInput = options.droidDefaultEffort && isPlainObject(targetBody) ? { ...targetBody } : targetBody;
    applyDroidResponsesReasoningDefault(childInput, options.droidDefaultEffort, {
      provider: targetRoute.provider,
      modelId: targetRoute.modelId,
    });
    const childBody = concreteComboRequestBody(
      childInput,
      pick.target,
      jevEffortApplies ? initialJevDecision.effort : comboDefaultEffort(config, comboId),
      jevEffortApplies && initialJevDecision.effort === null ? [] : targetReasoningEfforts,
      combo.reasoningEffortMode,
      jevEffortApplies
        ? (initialJevDecision.effort === null ? "fallback" : "force")
        : combo.defaultEffortMode,
    );
    if (initialJevDecision) {
      if (jevEffortApplies) delete childBody.service_tier;
      if (jevEffortApplies && initialJevDecision.effort !== null) {
        const childReasoning = childBody.reasoning;
        const preservedReasoning = childReasoning && typeof childReasoning === "object" && !Array.isArray(childReasoning)
          ? childReasoning as Record<string, unknown>
          : {};
        childBody.reasoning = { ...preservedReasoning, effort: initialJevDecision.effort };
        delete childBody.reasoning_effort;
        delete childBody.thinking_budget;
        delete childBody.thinking;
      }
    }
    const childHeaders = buildComboChildHeaders(req.headers);
    const childRequest = new Request(req.url, {
      method: req.method,
      headers: childHeaders,
      body: JSON.stringify(childBody),
    });
    linkRequestSessionLane(req, childRequest);
    let resolvedAuth: CodexAuthContext | undefined;
    let terminalRecorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined;
    const started = Date.now();
    const attempt = beginRequestAttempt(
      (logCtx.attempts?.length ?? 0) + 1,
      pick.target.provider,
      // The id the child wire will actually send, not the selector the combo named. A target may
      // be an alias, and `routeConcreteModel` above is where it becomes the provider's native id;
      // recording the alias here would describe a request that never left (the adapter resolves
      // the id before it reads any per-model list).
      targetRoute.modelId,
      config.providers[pick.target.provider]!.adapter,
    );
    childLog.activeAttempt = attempt;
    if (originalRequestedEffort !== undefined) {
      childLog.requestedEffort = originalRequestedEffort;
      recordAttemptRequestedEffort(childLog);
    }
    childLog.activeAttemptStartedAt = started;
    childLog.attempts = logCtx.attempts ??= [];
    childLog.attempts.push(attempt);
    let attemptRetained = false;
    const retainCancelledAttempt = (): void => {
      if (attemptRetained) return;
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
        childLog.accountLogLabel,
      );
      finishRequestAttempt(attempt, 499, Date.now() - started, childLog.usage);
      attemptRetained = true;
    };
    // The row is written from `logCtx`, which copies `childLog` only when the child commits. A
    // bridge child binds its usage later, at the terminal frame, so the binding is forwarded here
    // after that point. Left on `childLog`, the row would re-read the bridged wire instead of the
    // adapter's usage, and that wire has no providerCredits and a context-derived input count.
    // A binding that arrives before the commit waits for it, and a child that never commits
    // forwards nothing: both flags belong to this target only.
    let childCommitted = false;
    let childUsageBound = false;
    const forwardChildUsage = (): void => {
      if (!childCommitted || !childUsageBound) return;
      logCtx.usageFromBridge = true;
      if (childLog.usage) logCtx.usage = childLog.usage;
    };
    const completedTarget = { provider: pick.target.provider, model: pick.target.model };
    const { poolCooldownRevision, writerGeneration } = pick;
    let consumedChildFailure: ConsumedComboFailure | undefined;
    let preflightModelRefusal: CodexAccountModelRefusal | undefined;
    let failedInPreflight = false;
    const callbackGate = createChildPassthroughCallbackGate({
      ...options,
      onResponseComplete: (model, store, proofs, responseId) => {
        if (poolCooldownRevision !== undefined && attempt.sendCount > 0) {
          clearComboTargetCooldownIfUnchanged(comboId, completedTarget, poolCooldownRevision);
        }
        // The live config can change while the child is streaming. Never retain credentials.
        const currentCombo = getCombo(config, comboId);
        const provider = config.providers[completedTarget.provider];
        if (!options.compactionRoutingOverride && !options.mainHardLockFallbackOverride
          && Object.hasOwn(config.providers, completedTarget.provider)
          && provider && provider.disabled !== true
          && currentCombo?.targets.some(target => targetKey(target) === targetKey(completedTarget))) {
          rememberComboForLane(comboLane, comboId, completedTarget, model, writerGeneration, store, proofs, responseId);
          jevPin?.complete(targetKey(completedTarget), initialJevDecision, writerGeneration);
        }
        options.onResponseComplete?.(model, store, proofs, responseId);
      },
      onNativePassthroughTerminal: status => {
        // A committed stream can acquire terminal metadata after preflight copied
        // the child log. Publish it before the outer logger finalizes, but only
        // through the gate: discarded attempts must never affect the parent.
        // Undefined child fields must preserve metadata already inspected by WS.
        if (childLog.terminalHttpStatus !== undefined) logCtx.terminalHttpStatus = childLog.terminalHttpStatus;
        if (childLog.terminalIncompleteReason !== undefined) logCtx.terminalIncompleteReason = childLog.terminalIncompleteReason;
        if (childLog.terminalErrorCode !== undefined) logCtx.terminalErrorCode = childLog.terminalErrorCode;
        if (childLog.upstreamError !== undefined) logCtx.upstreamError = childLog.upstreamError;
        // The child's terminal parse also captured the frame's closed diagnostics, its provenance
        // and any cause it proved; without them a committed quota refusal read as `upstream-fault`
        // with `type=unknown` (infra#1230).
        if (childLog.upstreamErrorType !== undefined) logCtx.upstreamErrorType = childLog.upstreamErrorType;
        if (childLog.upstreamErrorCode !== undefined) logCtx.upstreamErrorCode = childLog.upstreamErrorCode;
        if (childLog.upstreamRequestId !== undefined) logCtx.upstreamRequestId = childLog.upstreamRequestId;
        if (childLog.transportPhase !== undefined) logCtx.transportPhase = childLog.transportPhase;
        if (childLog.terminalSource !== undefined) logCtx.terminalSource = childLog.terminalSource;
        if (childLog.causeHint !== undefined) logCtx.causeHint = childLog.causeHint;
        // A committed stream that ends failed is a target failure too; incomplete is an answer.
        if (status === "failed") jevPin?.forget();
        options.onNativePassthroughTerminal?.(status);
      },
    });
    let response: Response;
    try {
      const currentTargetProvider = pick.target.provider;
      const attempted = new Set(pick.attempted);
      const deferCodexResetDerivedCooldown = (failoverOrder || combo.strategy === "jev")
        && combo.targets.some(target =>
          target.provider === currentTargetProvider && !attempted.has(targetKey(target))
          && targetEligible(target)
          && !isComboTargetInCooldown(comboId, target),
        );
      const nativeChild = localExpansion || handleOwner || legIntent || lateReasoningProjection || dispatchBody !== body ? undefined : protocolLanes?.nativeChild(pick.target, targetRoute, targetSendBudget, initialJevDecision, jevEffortApplies);
      response = nativeChild ? await dispatchNativeComboChild({
        source: options.protocolSource!,
        plan: nativeChild,
        comboDispatchPermit: hopDecision?.allowed ? hopDecision.permit : undefined,
        logCtx,
        childLog,
        attempt,
        startedAt: started,
        ...(options.turnAdmissionLease ? { turnAdmissionLease: options.turnAdmissionLease } : {}),
        // Attempt-relative TTFT, recorded here for the same reason as the bridge child below.
        onFirstOutput: () => {
          if (attempt.firstOutputMs === undefined) {
            attempt.firstOutputMs = Math.max(0, Date.now() - started);
          }
          options.onFirstOutput?.();
        },
        callbacks: {
          onTerminal: callbackGate.onTerminal,
          onCancel: callbackGate.onCancel,
          onResponseComplete: callbackGate.onResponseComplete,
        },
      }) : await withComboTurnStateOwner(handleOwner, () => requestDispatchers.handleResponses(childRequest, config, childLog, {
        ...options,
        replayPrincipal,
        // A bridge child is a concrete route; the native source belongs to this loop only.
        ...(options.protocolSource ? { protocolSource: undefined } : {}),
        // After the spread: the child must run on THIS target's ladder, not on the holder the
        // parent arrived with.
        sendBudget: targetSendBudget,
        comboAttempt: true,
        comboInitialSend: initialSend,
        comboDispatchPermit: hopDecision?.allowed ? hopDecision.permit : undefined,
        comboReplaySnapshot: lateReasoningProjection ? { ...comboReplaySnapshot, projectForeignReasoning: lateReasoningProjection,
          recordedResponsesStore, issuedReasoningProofs: recorded?.proofs } : dispatchBody !== body
          ? { ...comboReplaySnapshot, sourceBody: dispatchBody } : comboReplaySnapshot,
        deferCodexResetDerivedCooldown,
        poolCapacityIntent: legIntent,
        reserveWalk: walkSeats,
        onBridgeUsageBound: () => {
          childUsageBound = true;
          forwardChildUsage();
        },
        // Attempt-relative TTFT is recorded HERE (not via childLog.firstOutputMs — a later
        // Object.assign(logCtx, childLog) would overwrite the request-relative value).
        onFirstOutput: () => {
          if (attempt.firstOutputMs === undefined) {
            attempt.firstOutputMs = Math.max(0, Date.now() - started);
          }
          options.onFirstOutput?.();
        },
        onCodexAuthContextResolved: value => { resolvedAuth = value; },
        setTerminalOutcomeRecorder: value => { terminalRecorder = value; },
        onConsumedComboFailure: value => { consumedChildFailure = value; },
        onStoredPool401ReplayDispatched: () => { storedPool401ReplayDispatched = true; },
        onNativePassthroughTerminal: callbackGate.onTerminal,
        onNativePassthroughCancel: callbackGate.onCancel,
        onResponseComplete: callbackGate.onResponseComplete,
      }));
      // Both lanes applied the initial choice before provider pins/caps; retain those transitions.
      restoreOriginalRequestedEffort(childLog, jevEffortApplies ? initialJevDecision?.effort : undefined);
    } catch (error) {
      callbackGate.discard();
      if (options.abortSignal?.aborted) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      jevPin?.forget();
      finishRequestAttempt(attempt, 502, Date.now() - started, childLog.usage);
      throw error;
    }

    if (options.abortSignal?.aborted) {
      callbackGate.discard();
      void response.body?.cancel(options.abortSignal.reason).catch(() => undefined);
      retainCancelledAttempt();
      return clientCancelledResponse();
    }

    if (legIntent === "reserve-only" && consumedChildFailure && response.ok) {
      // A bounded native preflight already correlated the quota terminal. Do not infer it again
      // from the sanitized stream, whose created event otherwise (correctly) counts as acceptance.
      originalReserveRefusal = response;
      response = consumedChildFailure.response;
      terminalRecorder?.("failed", response.status);
    }
    // A native Chat child reports a pre-stream failure by status before any byte, so its body
    // is never peeked; a non-OK one takes the ordinary failure path below.
    if (response.ok && !runTurnAdapterSseResponses.has(response) && clientWireOf(response) === undefined) {
      const nativePassthrough = isNativePassthroughSseResponse(response);
      const eagerRelay = isEagerRelaySseResponse(response);
      let preflight;
      try {
        preflight = await preflightComboStreamResponse(response, childLog, undefined, {
          signal: options.abortSignal,
          requiredToolPrelude: childLog.providerAdapter === "openai-responses" && requiredToolContractOf(rawBody) !== undefined,
        });
      } catch (error) {
        callbackGate.discard();
        if (options.abortSignal?.aborted) {
          retainCancelledAttempt();
          return clientCancelledResponse();
        }
        jevPin?.forget();
        finishRequestAttempt(attempt, 502, Date.now() - started, childLog.usage);
        throw error;
      }
      if (preflight.kind === "failed") {
        callbackGate.discard();
        terminalRecorder?.("failed", preflight.response.status);
        response = preflight.response;
        preflightModelRefusal = preflight.codexModelRefusal;
        failedInPreflight = true;
      } else {
        response = preflight.response;
        if (nativePassthrough) markNativePassthroughSseResponse(response);
        if (eagerRelay) markEagerRelaySseResponse(response);
      }
    }

    if (options.abortSignal?.aborted) {
      callbackGate.discard();
      await response.body?.cancel().catch(() => undefined);
      retainCancelledAttempt();
      return clientCancelledResponse();
    }

    if (response.ok) {
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
        childLog.accountLogLabel,
      );
      attemptRetained = true;
      noteComboSuccess(comboId, combo, pick.target, pick.writerGeneration);
      settleComboReprobeSuccess(pick);
      carryProxyErrorContext(childLog, logCtx);
      dropStaleSendIdentity(logCtx, childLog);
      Object.assign(logCtx, childLog, {
        client: logCtx.client,
        requestedModel: responseModel,
        model: responseModel,
        provider: "combo",
        comboId,
        routeDecision: logCtx.routeDecision,
        attempts: logCtx.attempts,
        activeAttempt: attempt,
        activeAttemptStartedAt: started,
        resolvedModel: childLog.resolvedModel ?? childLog.model,
      });
      options.onCodexAuthContextResolved?.(resolvedAuth);
      options.setTerminalOutcomeRecorder?.(terminalRecorder);
      callbackGate.commit();
      childCommitted = true;
      forwardChildUsage();
      return response;
    }

    callbackGate.discard();
    if (response.status === 499) {
      retainCancelledAttempt();
      return clientCancelledResponse();
    }
    let failure: ConsumedComboFailure;
    try {
      failure = consumedChildFailure
        ?? await consumeComboFailure(response, options.abortSignal, Date.now(), childLog);
      if (hasProxyErrorMessage(childLog, failure.upstreamMessage ?? "", { type: failure.upstreamType, code: failure.upstreamCode })) markProxyError(failure.response);
      if (preflightModelRefusal !== undefined) failure = { ...failure, codexModelRefusal: preflightModelRefusal };
    } catch (error) {
      if (options.abortSignal?.aborted) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      jevPin?.forget();
      finishRequestAttempt(attempt, 502, Date.now() - started, childLog.usage);
      throw error;
    }
    if (options.abortSignal?.aborted) {
      retainCancelledAttempt();
      return clientCancelledResponse();
    }
    // A member's local late-attribution refusal reaches the client only as the literal constant
    // envelope: swap the response, keep every classification input, and skip the overflow rewrite.
    const lateAttributionRefusal = isLateAttributionRefusal(failure);
    if (lateAttributionRefusal) failure = { ...failure, response: lateAttributionLimitResponse() };
    sealRequestAttemptIdentity(
      attempt,
      childLog.provider,
      childLog.providerAdapter ?? attempt.adapter,
      childLog.accountLogLabel,
    );
    finishRequestAttempt(
      attempt,
      failure.response.status,
      Date.now() - started,
      failure.usage ?? childLog.usage,
    );
    if (recorded?.idIssuer && attempt.sendCount === 0 && failure.upstreamCode === "previous_response_not_found") return missingPrevious();
    if (isReplayRefusalResponse(failure.response)) {
      // Numeric 429 is a client replay policy here, not an upstream quota observation.
      childLog.causeHint = "transport-ambiguous";
      childLog.terminalSource = "synthetic";
      childLog.errorCode = attempt.errorCode = UPSTREAM_RESET_REPLAY_REFUSED_CODE;
    }
    if (failure.upstreamCode === "input_admission_refused" && attempt.sendCount === 0) {
      attempt.errorCode = failure.upstreamCode;
      localAdmissionRefusals?.push(failure.upstreamMessage ?? "");
    } else {
      localAdmissionRefusals = undefined;
    }
    attemptRetained = true;
    lastFailure = failure.response;
    lastFailureUpstreamCode = failure.upstreamCode;
    toolChoiceRefusalsOnly = (toolChoiceRefusalsOnly ?? true) && isMandatoryToolChoiceRefusal(failure.response);
    // A real target failure ends the session pin; the next turn is decided afresh (#7525).
    jevPin?.forget();
    // A strict Reserve refusal is this leg's own typed answer, not the ladder's quota evidence.
    if (!quotaFailure && legIntent !== "reserve-only" && (lastFailure.status === 429 || lastFailure.status === 402)) {
      quotaFailure = lastFailure;
      quotaFailedChildLog = childLog;
    }
    lastFailedChildLog = childLog;
    // The failed child's resolved destination, so the next hop compares physical targets.
    lastFailedTarget = { provider: targetRoute.providerName, model: targetRoute.modelId };
    lastFailedRetryAfter = failure.retryAfter;
    // A replacement that answers 200 is unmarked, and its zero-output failure only exists once
    // preflight has rebuilt the stream as a fresh Response. A spent grant never hops: a status the
    // client would resend becomes the refusal, and anything else reaches the client as it is.
    const spentReplacement = !failure.nonReplayable && comboSendScope?.ambiguousResendSpent === true;
    if (spentReplacement) {
      const settled = settleOperatorReplacement(failure.response);
      if (settled !== failure.response) {
        adoptFailedChildLog(childLog);
        return settled;
      }
    }
    // A non-replayable failure (the answer to a spent ambiguous-reset replacement) may follow a
    // send that already ran the turn, so no later target may receive it, whatever its status says.
    const failureDecision = boundTargetKey !== undefined || failure.nonReplayable || spentReplacement
      ? "stop"
      : isPolicyCandidateRefusal(failure.response) ? "hop"
      : comboFailureDecision(failure.response.status, failure.classificationText, {
        code: failure.upstreamCode,
        rootCode: failure.upstreamRootCode,
        codexModelRefusal: failure.codexModelRefusal,
        verifiedPlanRefusal: failure.verifiedPlanRefusal,
        malformedResponseFormat: failure.malformedResponseFormat,
        openRouterOpaque400: failure.openRouterOpaque400,
        providerModerationRefusal: failure.providerModerationRefusal,
        // The adapter the failed leg actually resolved: a configured `kiro` provider can route a
        // model through another wire via `modelAdapters`, and an unresolved leg grants no hop.
        failedAdapter: childLog.providerAdapter,
      });
    const wantsStream = (rawBody as { stream?: unknown } | null)?.stream === true;
    // Local byte admission has its own diagnostic; do not relabel it as an upstream refusal.
    const classifyOverflow = failure.response.status === 413 && !lateAttributionRefusal
      && (wantsStream || (failure.upstreamCode !== "outbound_body_too_large"
        && failure.upstreamCode !== "translation_buffer_limit"));
    lastFailureClassifiesOverflow = classifyOverflow;
    if (storedPool401ReplayDispatched) {
      if (failureDecision === "hop" && unreadableEncryptedAgentTask && !comboPayloadReadable) {
        const recoveredTarget = await pickWithWait({
          exclude: pick.attempted,
          eligible: target => {
            if (!recoveryEligible(target)) return false;
            try {
              const route = routeConcreteModel(config, `${target.provider}/${target.model}`);
              return route.codexAccountMode === undefined
                && !isCanonicalOpenAiForwardProvider(route.provider);
            } catch {
              return false;
            }
          },
        });
        if (options.abortSignal?.aborted) return clientCancelledResponse();
        if (recoveredTarget && await recoverUnreadableEncryptedTask()) {
          pick = recoveredTarget;
          continue;
        }
        if (options.abortSignal?.aborted) return clientCancelledResponse();
      }
      // Keep the spent Pool budget sticky even after a recovered routed child:
      // no later failure may reopen ordinary combo/native account hopping.
      adoptFailedChildLog(childLog);
      if (classifyOverflow && failureDecision === "stop") {
        return wantsStream
          ? streamingContextOverflowResponse(responseModel, options.translatorBudget)
          : jsonContextOverflowResponse();
      }
      return lastFailure;
    }
    if (ported !== undefined && lunaPair && boundTargetKey && !failure.nonReplayable && !spentReplacement && native
      && (attempt.sendCount === 0 ? isIssuerCapacityRefusal(failure.response) : isOwnerCapacityRefusal(failure.response.status, failure))) {
      replayEligibilityBody = ported;
      boundTargetKey = undefined;
      const plan = planLunaReserveLegs(combo, scopedRoute, targetEligible, comboHopAllowed, native);
      const next = plan ? await pickWithWait({ eligible: target => targetKey(target) === plan.nativeKey && targetEligible(target) }) : null;
      if (options.abortSignal?.aborted || req.signal.aborted) return clientCancelledResponse();
      if (plan && next) {
        if (reserveWalk) reserveWalk = createPoolReserveWalk(config);
        dispatchBody = ported; lunaReplay = { kind: "portable", body: ported }; lunaLegs = plan;
        logCtx.routeDecision = { ...logCtx.routeDecision!, selected: { ...logCtx.routeDecision!.selected, reason: "luna-owner-spent-ported" } };
        pick = next;
        continue;
      }
      boundTargetKey = legTargetKey;
      replayEligibilityBody = body;
    }
    if (failureDecision === "stop") {
      adoptFailedChildLog(childLog);
      if (classifyOverflow) {
        return wantsStream
          ? streamingContextOverflowResponse(responseModel, options.translatorBudget)
          : jsonContextOverflowResponse();
      }
      return lastFailure;
    }
    // Retain a confirmed target context refusal when later retryable failures exhaust the ladder.
    // Hard stops above still return their own verdict, and every attempt keeps its own usage.
    if (!contextFailure && failure.response.status === 400 && isDefiniteContextOverflow(400, failure.classificationText)) {
      contextFailure = { childLog, response: formatErrorResponse(400, "invalid_request_error",
        failure.upstreamMessage ?? failure.classificationText, { code: "context_length_exceeded", classified: true }) };
    }
    if (failure.upstreamCode === "zero_output_token_limit") {
      zeroOutputLimitFailure = {
        childLog,
        usage: failure.usage ?? childLog.usage,
      };
    }
    // A bare status made a revoked credential read as a provider outage. Log the classified
    // condition (a closed member), never upstream-authored code or message text.
    const failureReason = classifyUpstreamCondition({
      status: failure.response.status, code: failure.upstreamCode, type: failure.upstreamType, message: failure.upstreamMessage,
    });
    console.warn(
      `[combo] ${comboLogLabel(config, comboId)}: ${comboTargetLogLabel(config, comboId, pick.target)} failed with ${failure.response.status}`
        + ` after ${Date.now() - started}ms${failureReason ? `: ${failureReason}` : ""}`,
    );
    const failureNow = Date.now();
    const attemptedTargets: string[] = pick.attempted;
    const classifiedScope = comboFailureCooldownScope(failure.response.status, failure.classificationText, {
      code: failure.upstreamCode,
      malformedResponseFormat: failure.malformedResponseFormat,
      openRouterOpaque400: failure.openRouterOpaque400,
      providerModerationRefusal: failure.providerModerationRefusal,
    });
    // A Reserve-window rejection is narrower than explicit provider-wide evidence.
    const reserveCapacityRefused = legIntent === "reserve-only" && (attempt.sendCount === 0
      || isReserveSeatQuotaRefusal(failure, classifiedScope));
    const relayCooldown = hasUpstreamSeatPool(targetRoute, childLog.providerAdapter)
      ? relayFailureCooldownMs(failure.response.status, failure.relayRetryAfterHeader, combo.cooldownMs, failureNow) : undefined;
    const failureCooldownScope = reserveCapacityRefused || isPolicyCandidateRefusal(failure.response) ? "none"
      : relayCooldown !== undefined && classifiedScope === "provider" ? "target" : classifiedScope;
    const failedTargetKey = targetKey(pick.target);
    let failedTargetCooldownRecorded = false;
    // The dispatch rewrote this to name the pool account that actually served the turn.
    const poolAccountLabel = poolAccountProviderLabel(childLog.provider, pick.target.provider);
    const failedAccount = failure.response.status === 402
      ? creditRefusedAnthropicAccountLabel(
        config, pick.target.provider, pick.target.model, poolAccountLabel, failure.classificationText, failure.upstreamCode,
        failure.response,
      )
      : cooledPoolAccountLabel(config, pick.target.provider, pick.target.model, poolAccountLabel)
      ?? (failure.response.status === 429 && failureCooldownScope === "target"
      ? cooledGenericOAuthAccountLabel(config, pick.target.provider, pick.target.model, childLog.accountLogLabel, failure.retryAfter)
      : undefined);
    // The target still cools on the pool's own refusal (the anti-hammer guard), but for the local
    // fallback rather than the pool's restated per-account Retry-After.
    const poolLocalRefusal = isAnthropicPoolLocalRefusal(
      config, pick.target.provider, failure.response.status, failedAccount, failureNow,
    );
    const codexLocalRefusal = isCodexAccountCooldownResponse(failure.response);
    if (lunaLegs && lunaStage === "relay" && failedTargetKey === lunaLegs.relayKey
      && !relayProvedNotStarted(childLog, attempt.sendCount) && (failedInPreflight || ![401, 402, 403, 429].includes(failure.response.status))) {
      unavailableOrdinaryTarget = lunaLegs.nativeKey;
    }
    const activeLunaLegs = lunaLegs;
    const nextPick = advanceComboAfterFailure(config, pick, {
      routeConcreteModel,
      retryAfter: poolLocalRefusal || codexLocalRefusal || relayCooldown !== undefined ? undefined : failure.retryAfter,
      resetAt: codexLocalRefusal || relayCooldown !== undefined ? undefined : failure.resetAt,
      cooldownMs: relayCooldown ?? combo.cooldownMs,
      now: failureNow,
      cooldownScope: failureCooldownScope,
      // A pin may start in the middle. Ask its planned relay before resuming configured order.
      eligible: legIntent === "reserve-only" && activeLunaLegs
        ? target => targetKey(target) === activeLunaLegs.relayKey && targetEligible(target)
        : targetEligible,
      status: failure.response.status,
      code: failure.upstreamCode,
      message: failure.classificationText,
      failedAccount,
      onCooldownRecorded: target => {
        failedTargetCooldownRecorded ||= targetKey(target) === failedTargetKey;
      },
    });
    // A sibling cooldown is not this failure's write: stale-generation removal can
    // refuse recording even for a cooldown-producing classification. Require both.
    const failedTargetCooled = failureCooldownScope !== "none"
      && failedTargetCooldownRecorded
      && isComboTargetInCooldown(comboId, pick.target, failureNow);
    // Drop exclusions for the single-target retry, but wait for normal cooldown
    // expiry: an in-flight request cannot reserve a fresh recovery pass, though the
    // reservation it already owns still applies to entries unchanged since it was made.
    const carriedReprobe: ComboPick["cooldownReprobeTargets"] = pick.cooldownReprobeTargets;
    const retryAfterCooldown = (): Promise<ComboPick | null> =>
      pickWithWait({
        allowCooldownReprobe: false,
        cooldownReprobeTargets: carriedReprobe ? Object.entries(carriedReprobe) : undefined,
        eligible: targetEligible,
        now: failureNow,
      });
    if (nextPick) {
      pick = nextPick;
    } else {
      pick = await pickWithWait({
        exclude: pick.attempted,
        eligible: targetEligible,
        cooldownReprobeTargets: carriedReprobe ? Object.entries(carriedReprobe) : undefined,
        now: failureNow,
      });
      // A single-target combo with waitForCooldownMs has no alternate target to fail over to,
      // but can recover if it waits for its brief cooldown. The initial attempt accumulated into
      // pick.attempted, so the first pickWithWait above excluded it. retryAfterCooldown below is
      // the same selector with `exclude` deliberately dropped, so the single cooled target
      // becomes eligible again once its cooldown expires.
      // Termination is double-guarded:
      // 1) comboSendScope?.reserveDispatch refuses a second failover hop via comboExecutionBudgetPolicy
      //    (maxAlternateTargetSends: 1 for a single declared target).
      // 2) comboTargetsDispatched <= 1 bounds it locally so the retry never loops or waits unnecessarily
      //    even if sendBudget scope is absent.
      if (
        !pick
        && combo.targets.length === 1
        && combo.waitForCooldownMs > 0
        && comboTargetsDispatched <= 1
        && failedTargetCooled
        && !options.abortSignal?.aborted
      ) {
        pick = await retryAfterCooldown();
      }
    }
    if (activeLunaLegs && failureDecision === "hop"
      && (lunaStage === "reserve" && failedTargetKey === activeLunaLegs.nativeKey || lunaStage === "relay" && failedTargetKey === activeLunaLegs.relayKey)) {
      // After the strict Reserve leg the relay is next; after the relay, native ordinary Luna is next only on proof the relay never got the turn.
      const afterReserve: boolean = lunaStage === "reserve";
      const ordinaryNext = afterReserve ? !pick || targetKey(pick.target) !== activeLunaLegs.relayKey
        : unavailableOrdinaryTarget !== activeLunaLegs.nativeKey;
      lunaStage = afterReserve && pick && targetKey(pick.target) === activeLunaLegs.relayKey ? "relay" : "done";
      const ordinaryPick: ComboPick | null = ordinaryNext && !options.abortSignal?.aborted ? await pickWithWait({
        exclude: attemptedTargets.filter(key => key !== activeLunaLegs.nativeKey),
        eligible: target => targetKey(target) === activeLunaLegs.nativeKey && targetEligible(target),
        now: failureNow,
      }) : null;
      if (ordinaryPick) pick = ordinaryPick;
    }
    if (!pick) {
      if (options.abortSignal?.aborted) return clientCancelledResponse();
      if (onlyReplayIncompatibleTargetsRemain(attemptedTargets)) {
        if (contextFailure) return exhaustedFailure();
        adoptFailedChildLog(childLog);
        return targetIncompatibleResponse();
      }
      if (unreadableEncryptedAgentTask && !comboPayloadReadable) {
        const recoveredTarget = await pickWithWait({
          exclude: attemptedTargets,
          eligible: recoveryEligible,
          cooldownReprobeTargets: carriedReprobe ? Object.entries(carriedReprobe) : undefined,
          now: failureNow,
        });
        if (recoveredTarget && await recoverUnreadableEncryptedTask()) {
          pick = recoveredTarget;
          continue;
        }
      }
      // Waiting or recovery may have observed cancellation after the check above.
      if (options.abortSignal?.aborted) return clientCancelledResponse();
    }
    } finally {
      // External receipts make release a no-op after real work. runTurn owns its asynchronous
      // producer; core transfers cleanup there before returning a streaming response.
      if (!initialSend?.producerOwned) initialSend?.permit.release();
      if (walkSeats && walkHeadroom && comboSendScope && lastFailure) {
        // Untried seats cannot buy extra relay retries. Keep the same physical ledger and
        // carry only extra sends that actually left the first leg into the ordinary policy.
        const expandedMoves = Math.max(0, walkSeats.movesSent - CODEX_TEXT_GUARDED_BUDGET_POLICY.maxAlternateTargetSends);
        const spentExtra = Math.min(walkHeadroom, expandedMoves);
        if (spentExtra < walkHeadroom) {
          const lastTarget = comboSendScope.lastTargetKey;
          comboSendScope = deriveSendBudgetScope(comboSendScope, comboExecutionBudgetPolicy(comboLegCount, spentExtra));
          if (lastTarget !== undefined) comboSendScope.bindPrepaidTarget?.(lastTarget);
        }
      }
    }
  }
    const failure = exhaustedFailure(true);
  if (
    failure === lastFailure && lastFailure?.status === 413
    && lastFailureClassifiesOverflow
  ) {
    if (localAdmissionRefusals?.length) logCtx.errorCode = "input_admission_refused";
    const localMessage = localAdmissionRefusals?.length
      ? `opencodex refused this turn locally; nothing was sent upstream. No target of this combo `
        + `that was tried can fit its input: ${localAdmissionRefusals.join(" ")} Compact the conversation before retrying.`
      : undefined;
    return (rawBody as { stream?: unknown } | null)?.stream === true
      ? streamingContextOverflowResponse(responseModel, options.translatorBudget, localMessage)
      : jsonContextOverflowResponse(localMessage);
  }
  return failure;
}
