import { permitsPoolWireModel, POOL_RESERVE_UNAVAILABLE_MESSAGE } from "../../codex/pool-reserve";
import { CodexReserveUnavailableError } from "../../codex/auth-context";
import { isRequestExecutionBudget } from "../../lib/request-execution-budget";
import { DEFAULT_CONNECT_TIMEOUT_MS } from "../../stall-timeout";
import type { AdapterRequest } from "../../adapters/base";
import type { AttemptRecoveryKind } from "../../usage/log";
import { noteProviderAttemptSend } from "../request-log";
import type { ResponsesRequestContext, ResponsesAdmissionState } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import { poolPreOutputRefusalHold, PoolPreOutputRefusals, usesCodexForwardPoolAuth } from "./core-codex-account";
import { classifyPoolRecoveryDispatch } from "../../routing/probe-lease";
import { settlePoolResponse } from "./pool-response-alternate";

/** Compaction still uses the adapter's summary request and compaction encoder. Only the
 * pre-output Responses exchange is shared with native Reserve placement. */
export function reserveCompactionPlacement({ options, req, config, logCtx }: ResponsesRequestContext, admission: ResponsesAdmissionState,
  state: Pick<PreparedResponsesRequest, "route" | "parsed" | "callerAuthHeaders" | "selectedForwardHeaders" | "subagentFallbackAccountId">,
  transport: Pick<ResponsesTransport, "sameTargetRequest">, upstream: AbortController, connectMs: number, workflowRootId?: string) {
  const ctx = admission.authCtx, { route, parsed } = state, walk = options.reserveWalk;
  if (options.poolCapacityIntent !== "reserve-only" || !parsed._compactionRequest || !walk || !usesCodexForwardPoolAuth(ctx, route.provider)) return;
  const hold = poolPreOutputRefusalHold(ctx, route.provider, connectMs, options.comboAttempt, parsed, req.headers, "reserve-only");
  const deadline = Date.now() + (connectMs || DEFAULT_CONNECT_TIMEOUT_MS);
  return {
    hold,
    assertWire(request: AdapterRequest) {
      if (!permitsPoolWireModel("reserve-only", request.outboundModelId)) throw new CodexReserveUnavailableError(POOL_RESERVE_UNAVAILABLE_MESSAGE);
    },
    noteInitial(request: AdapterRequest, recovery?: AttemptRecoveryKind) {
      if (recovery) walk.transientRetries++; else classifyPoolRecoveryDispatch("initial");
      noteProviderAttemptSend(logCtx, route.providerName, route.provider, request.usageLog?.inputTokens, recovery, { wireModel: request.outboundModelId });
    },
    async settle(response: Response) {
      const settled = await settlePoolResponse({ config, route, parsed, logCtx, options: { ...options, workflowRootId }, callerAuthHeaders: state.callerAuthHeaders,
        firstAuthCtx: ctx, firstResponse: response, firstPlacement: true, reserveWalk: walk, reserveDeadline: deadline,
        ambiguousResendSpent: isRequestExecutionBudget(options.sendBudget) && options.sendBudget.ambiguousResendSpent === true,
        refusals: new PoolPreOutputRefusals(), upstream, connectMs, stream: true, preOutputRefusalHold: hold,
        onMove(move) {
          admission.authCtx = move.authCtx;
          state.selectedForwardHeaders = move.selectedForwardHeaders;
          state.subagentFallbackAccountId = move.authCtx.accountId;
          transport.sameTargetRequest = move.request;
        },
      });
      if (settled.kind === "transport") { admission.authCtx = settled.authCtx; throw settled.error; }
      return settled.response;
    },
  };
}
