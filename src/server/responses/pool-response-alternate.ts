import type { CodexAuthContext } from "../../codex/auth-context";
import { clearCodexModelDenialEvidence, recordCodexModelDenialEvidence } from "../../codex/model-entitlements";
import { wasAccountAutoPaused } from "../../oauth/account-auto-pause";
import { preflightReserveFirstResponse } from "./combo-stream-preflight";
import { finishReserveWalkInspection } from "./reserve-refusal-body";
import { reserveQuotaPermitsMove } from "./combo-luna-legs";
import { codexPoolAccountModel400Denial, PoolPreOutputRefusals, retryCodexPoolOnAlternateAccount,
  shouldRetryCodexPoolAccountQuota, shouldRetryCodexPoolAccountTransient, usesCodexForwardPoolAuth,
  type CodexPoolAccountRetryArgs, type CodexPoolAccountRetryResult } from "./core-codex-account";

type Moved = Extract<CodexPoolAccountRetryResult, { kind: "retried" }>;

/** Inspect only uncommitted Responses. Both native passthrough and portable compaction
 * use this account walk; the caller still owns the wire-specific delivery of its result. */
export async function settlePoolResponse(args: Omit<CodexPoolAccountRetryArgs, "outcomeStatus"> & {
  firstPlacement: boolean; ambiguousResendSpent: boolean; refusals: PoolPreOutputRefusals;
  onMove: (move: Moved) => void;
}): Promise<{ kind: "response"; response: Response } | Extract<CodexPoolAccountRetryResult, { kind: "transport" }>> {
  let ctx: CodexAuthContext = args.firstAuthCtx;
  let response = args.firstResponse;
  const { options, route, parsed, reserveWalk: walk, upstream, preOutputRefusalHold: hold } = args;
  while (usesCodexForwardPoolAuth(ctx, route.provider)) {
    const preflight = preflightReserveFirstResponse(response, args.firstPlacement || !!walk?.movesSent, hold, args.logCtx, upstream.signal, args.stream);
    if (preflight) response = (await preflight).response;
    const generation = ctx.kind === "pool" ? ctx.generation : undefined;
    if (response.ok) {
      clearCodexModelDenialEvidence(ctx.accountId, route.modelId, generation);
      clearCodexModelDenialEvidence(ctx.accountId, parsed.modelId, generation);
      break;
    }
    if (walk && response.status >= 500 && !ctx.fixedAccount) {
      response = await finishReserveWalkInspection(response, upstream.signal);
    }
    const denial = await codexPoolAccountModel400Denial(response, route.modelId, options.abortSignal, parsed.modelId);
    const paused = wasAccountAutoPaused(response);
    let outcome: number;
    if (paused) outcome = response.status;
    else if (denial !== undefined) {
      recordCodexModelDenialEvidence(ctx.accountId, denial, generation);
      outcome = 400;
    } else if (!ctx.fixedAccount && await shouldRetryCodexPoolAccountQuota(response, options.abortSignal)) {
      outcome = response.status >= 500 ? 429 : response.status;
    } else if (!ctx.fixedAccount && shouldRetryCodexPoolAccountTransient(response)) outcome = response.status;
    else break;

    const sameAccountOnly = args.sameAccountOnly && !paused;
    const strict = options.poolCapacityIntent === "reserve-only";
    if (strict) {
      if (!walk || ctx.kind !== "pool" || !ctx.poolReserve || (outcome !== 429 && outcome !== 402)) break;
      args.refusals.recordReserveQuota(args.config, ctx, route.provider, response, route.modelId, outcome);
      if (!walk.remaining.delete(ctx.accountId) || !walk.remaining.size || sameAccountOnly || args.ambiguousResendSpent
        || (args.reserveDeadline !== undefined && Date.now() >= args.reserveDeadline) || !await reserveQuotaPermitsMove(response, upstream.signal)) break;
    }
    const retry: CodexPoolAccountRetryResult = await retryCodexPoolOnAlternateAccount({ ...args, firstAuthCtx: ctx, firstResponse: response,
      outcomeStatus: outcome, sameAccountOnly, preOutputRefusalHold: strict ? hold : hold && { ...hold, reserveFirstPlacement: false } });
    if (retry.kind === "transport") return retry;
    if (retry.kind === "no-alternate") break;
    args.onMove(retry);
    ctx = retry.authCtx;
    response = retry.upstreamResponse;
    if (!strict) break;
  }
  return { kind: "response", response };
}
