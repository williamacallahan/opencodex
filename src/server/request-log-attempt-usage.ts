import {
  classifyError,
  CYBER_POLICY_ERROR_CODE,
  isCyberPolicyCode,
  isUpstreamResetReplayRefusedMessage,
} from "../lib/errors";
import { UPSTREAM_RESET_REPLAY_REFUSED_CODE } from "../lib/upstream-retry";
import { capEstimateAtContextWindow } from "../lib/token-estimate";
import { inferCursorContextWindow } from "../adapters/cursor/discovery";
import { KIRO_MODEL_CONTEXT_WINDOWS, normalizeKiroModelId } from "../providers/kiro-models";
import { kiroObservedContextWindow } from "../providers/kiro-model-catalog";
import { DEVIN_MODEL_CONTEXT_WINDOWS } from "../adapters/devin/live-models";
import { modelRecordValue } from "../reasoning-effort";
import type { OcxUsage } from "../types";
import {
  usageForFinalLog,
  usageStatusForFinalLog,
  usageTotalTokens,
  type AttemptRecoveryKind,
  type PersistedUsageAttempt,
  type UsageStatus,
} from "../usage/log";

export interface FinalizedUsageResult {
  usage?: OcxUsage;
  status: UsageStatus;
  totalTokens?: number;
}

export function requestLogErrorCode(
  status: number,
  upstreamError?: string,
  terminalErrorCode?: string,
  replayRefusal = false,
): string | undefined {
  if (status >= 200 && status < 400) return undefined;
  // A structured terminal code is authoritative even when the provider message is localized,
  // generic, or absent. Only preserve the one narrowly recognized policy code here: broadly
  // forwarding arbitrary upstream codes would change unrelated request-log taxonomy.
  if (isCyberPolicyCode(terminalErrorCode)) return CYBER_POLICY_ERROR_CODE;
  const classifiedCode = upstreamError?.trim()
    ? classifyError(status, "upstream_error", upstreamError).code
    : undefined;
  // Defense in depth: mid-stream web-search aborts used to land as 502 with this message.
  if (status === 499 || classifiedCode === "client_closed_request") {
    return "client_closed_request";
  }
  // Keep the high-confidence message fallback for runtimes/providers that stripped the
  // structured code before emitting response.failed.
  if (classifiedCode === CYBER_POLICY_ERROR_CODE) return CYBER_POLICY_ERROR_CODE;
  if (status === 400 || status === 409) return "invalid_request_error";
  if (status === 401) return "invalid_api_key";
  if (status === 403) {
    // Prefer message-aware codes (e.g. Ollama Cloud subscription gates) over a blunt
    // invalid_api_key — 403 usually means authenticated but not allowed.
    if (upstreamError?.trim()) {
      const code = classifyError(403, "upstream_error", upstreamError).code;
      if (code) return code;
    }
    return "permission_denied";
  }
  if (status === 429) {
    // Prefer transport provenance; retain the legacy message fallback for older callers.
    if (replayRefusal || (upstreamError?.trim() && isUpstreamResetReplayRefusedMessage(upstreamError))) {
      return UPSTREAM_RESET_REPLAY_REFUSED_CODE;
    }
    return "rate_limit_exceeded";
  }
  if (status === 503) return "server_is_overloaded";
  if (status >= 500) return "upstream_server_error";
  return `http_${status}`;
}

/**
 * Context window for the routed model, used to cap the token estimate (codex-router PR #140):
 * a request the provider answered cannot have exceeded the window, so the estimate must never
 * claim it did. The family is picked by the route ADAPTER, not the model id alone, because
 * claude-family ids are shared between Kiro and Cursor with different windows. Kiro "auto" is
 * a router with no fixed window and is never guessed; unknown adapters/models stay uncapped.
 */
export function contextWindowForModel(adapter: string, modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  if (adapter === "kiro" || adapter.startsWith("kiro-")) {
    const normalized = normalizeKiroModelId(modelId);
    if (normalized === "auto") return undefined;
    return kiroObservedContextWindow(modelId)
      ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
      ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, normalized);
  }
  if (adapter === "cursor" || adapter.startsWith("cursor-")) {
    return inferCursorContextWindow(modelId);
  }
  if (adapter === "devin") {
    return modelRecordValue(DEVIN_MODEL_CONTEXT_WINDOWS, modelId);
  }
  return undefined;
}

export function finalizedUsage(
  adapter: string,
  usage: OcxUsage | undefined,
  inputTokenEstimate: number | undefined,
  contextWindow: number | undefined,
  locallyAnswered = false,
): FinalizedUsageResult {
  // The ESTIMATE itself is capped at the model's context window (codex-router PR #140). The
  // combined value below keeps its max(inputTokens, estimate) behavior — a provider-reported
  // positive count is never reduced by this cap, only the estimate that could substitute it.
  const estimate = typeof inputTokenEstimate === "number"
    && Number.isFinite(inputTokenEstimate)
    && inputTokenEstimate >= 0
    ? capEstimateAtContextWindow(inputTokenEstimate, contextWindow)
    : undefined;
  const finalUsage = usageForFinalLog(adapter, usage, locallyAnswered);
  const usageFallback = !finalUsage && estimate !== undefined
    ? { inputTokens: estimate, outputTokens: 0, estimated: true }
    : undefined;
  // The estimate is a floor under a count the adapter could only guess. A count the adapter read
  // off the upstream's own usage frame stays exact: max() against a larger local estimate would
  // replace it and mark it estimated.
  const combinedInputTokens = finalUsage && !finalUsage.upstreamReported && estimate !== undefined
    ? Math.max(finalUsage.inputTokens, estimate)
    : undefined;
  const loggedUsage = finalUsage && combinedInputTokens !== undefined
    ? {
        ...finalUsage,
        inputTokens: combinedInputTokens,
        totalTokens: combinedInputTokens + finalUsage.outputTokens,
        estimated: true,
      }
    : finalUsage
      // When the adapter alone produced an estimated count and no local estimate
      // exists, cap it at the context window — an adapter estimate above the window
      // misleads the usage dashboard.  The combined branch (above) already caps the
      // ESTIMATE via capEstimateAtContextWindow, and Math.max preserves a real
      // provider-reported count, so it needs no further reduction.
      ? (finalUsage.estimated && contextWindow !== undefined && finalUsage.inputTokens > contextWindow
          ? {
              ...finalUsage,
              inputTokens: contextWindow,
              totalTokens: contextWindow + finalUsage.outputTokens,
            }
          : finalUsage)
      : usageFallback;
  const totalTokens = usageTotalTokens(loggedUsage);
  return {
    status: usageStatusForFinalLog(loggedUsage),
    ...(loggedUsage ? { usage: loggedUsage } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export function noteAttemptSend(
  attempt: PersistedUsageAttempt | undefined,
  inputTokenEstimate: number | undefined,
  recovery?: AttemptRecoveryKind,
): void {
  if (!attempt) return;
  attempt.sendCount += 1;
  if (typeof inputTokenEstimate === "number"
    && Number.isFinite(inputTokenEstimate)
    && inputTokenEstimate >= 0) {
    // Store the ESTIMATE field already capped at the model's window (codex-router PR #140):
    // what gets persisted, and later merged into usage, never claims a count above the window.
    attempt.inputTokenEstimate = capEstimateAtContextWindow(
      inputTokenEstimate,
      contextWindowForModel(attempt.adapter, attempt.model),
    );
  }
  if (recovery && !attempt.recoveryKinds.includes(recovery)) {
    attempt.recoveryKinds.push(recovery);
  }
}

export function finishRequestAttempt(
  attempt: PersistedUsageAttempt,
  status: number,
  durationMs: number,
  usage?: OcxUsage,
): PersistedUsageAttempt {
  const finalized = finalizedUsage(
    attempt.adapter,
    usage ?? attempt.usage,
    attempt.inputTokenEstimate,
    contextWindowForModel(attempt.adapter, attempt.model),
    attempt.locallyAnswered === true,
  );
  attempt.status = status;
  attempt.durationMs = Math.max(0, durationMs);
  attempt.usageStatus = finalized.status;
  if (finalized.usage) attempt.usage = finalized.usage;
  else delete attempt.usage;
  if (finalized.totalTokens !== undefined) attempt.totalTokens = finalized.totalTokens;
  else delete attempt.totalTokens;
  const errorCode = requestLogErrorCode(status);
  if (errorCode) attempt.errorCode = errorCode;
  else delete attempt.errorCode;
  return attempt;
}

export function aggregateAttemptUsage(
  attempts: readonly PersistedUsageAttempt[],
): FinalizedUsageResult {
  // A usage-less attempt that never reached upstream spent nothing (summary.ts `spentNothing`),
  // so it cannot leave the row's usage unknown.
  const measured = attempts.filter(attempt => attempt.usage
    || (attempt.sendCount !== 0 && attempt.locallyAnswered !== true));
  const status: UsageStatus = measured.length > 0
    && measured.every(attempt => attempt.usageStatus === "unsupported")
    ? "unsupported"
    : measured.some(attempt => (
        attempt.usageStatus === "unreported" || attempt.usageStatus === "unsupported"
      ))
      ? "unreported"
      : measured.some(attempt => attempt.usageStatus === "estimated")
        ? "estimated"
        : measured.length > 0
          ? "reported"
          : "unreported";

  const usages = attempts.flatMap(attempt => attempt.usage ? [attempt.usage] : []);
  if (usages.length === 0) return { status };

  const sumOptional = (
    key: "cachedInputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens" | "cacheCreation1hInputTokens"
      | "reasoningOutputTokens" | "providerCredits",
  ): number | undefined => {
    const present = usages.flatMap(usage => (
      typeof usage[key] === "number" ? [usage[key] as number] : []
    ));
    return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
  };
  const cachedInputTokens = sumOptional("cachedInputTokens");
  // Readers take `cacheReadInputTokens ?? cachedInputTokens` (usage/cost.ts), so once any attempt
  // reports the read field, an attempt that only reports `cachedInputTokens` must count in it too.
  const cacheReadInputTokens = sumOptional("cacheReadInputTokens") === undefined ? undefined
    : usages.reduce((sum, usage) => sum + (usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0), 0);
  const cacheCreationInputTokens = sumOptional("cacheCreationInputTokens");
  const cacheCreation1hInputTokens = sumOptional("cacheCreation1hInputTokens");
  const reasoningOutputTokens = sumOptional("reasoningOutputTokens");
  const providerCredits = sumOptional("providerCredits");
  const totalTokens = usages.reduce(
    (sum, usage) => sum + (usageTotalTokens(usage) ?? 0),
    0,
  );
  const aggregate: OcxUsage = {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    totalTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheCreation1hInputTokens !== undefined ? { cacheCreation1hInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(providerCredits !== undefined ? { providerCredits } : {}),
    ...(status === "estimated" ? { estimated: true } : {}),
    ...(usages.every(usage => usage.upstreamReported) ? { upstreamReported: true as const } : {}),
  };
  return { usage: aggregate, status, totalTokens };
}
