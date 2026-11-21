import type {
  ResponsesRequestContext,
  ResponsesAdmissionState,
  PassthroughAdmissionState,
} from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesSidecarAuth } from "./request-sidecar-auth";
import type { ResponsesEffects } from "./response-effects";
import type { ResponsesSendBudget } from "./request-send-budget";
import { preparePassthroughExchange, type PassthroughAdapterHandoff } from "./passthrough-dispatch";
import { deliverPassthroughResponse } from "./passthrough-delivery";
import { carryCodexWsPreludeVerdict } from "./codex-ws-wire";
import { guardDirectPassthroughBodyInactivity } from "../../lib/response-body-inactivity";
import { resolveStallTimeoutMs } from "../../stall-timeout";
import { releaseUpstreamHostAdmission } from "../../codex/upstream-host-health";
import { releaseCodexAuthContextProbeLease } from "../../codex/auth-context";
import { attachResponseToolOwnership } from "./response-tool-ownership";
import { finalizeAccountLease } from "./core-lifetime";

/** A streamed native or bridged compaction result owns its discovery lease until its body settles. */
export function retainReserveTrial(response: Response, context: ResponsesAdmissionState["authCtx"], signal: AbortSignal): Response | undefined {
  if (response.status >= 400 || context.kind !== "pool" || !context.poolReserve || !context.probeLeaseId) return;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", release);
    releaseCodexAuthContextProbeLease(context);
  };
  signal.addEventListener("abort", release, { once: true });
  if (signal.aborted) release();
  return finalizeAccountLease(response, release);
}

/** Owns the native host lease across dispatch, recovery, and response construction. */
export async function executePassthroughResponse(
  requestContext: ResponsesRequestContext,
  admissionState: ResponsesAdmissionState,
  requestState: PreparedResponsesRequest,
  transportState: ResponsesTransport,
  sidecarState: ResponsesSidecarAuth,
  responseEffects: ResponsesEffects,
  sendBudgetState: ResponsesSendBudget,
): Promise<Response | PassthroughAdapterHandoff> {
  const nativeHostState: PassthroughAdmissionState = { lease: admissionState.pendingHostAdmissionLease };
  admissionState.pendingHostAdmissionLease = null;
  let reserveTrialAttached = false;
  try {
    const nativeExchange = await preparePassthroughExchange(
      requestContext,
      admissionState,
      nativeHostState,
      requestState,
      transportState,
      responseEffects,
      sendBudgetState,
    );
    if (nativeExchange instanceof Response || nativeExchange.kind === "adapter-handoff") return nativeExchange;
    const response = await deliverPassthroughResponse(
      requestContext,
      admissionState,
      requestState,
      transportState,
      sidecarState,
      responseEffects,
      nativeExchange,
      sendBudgetState.dispatchSidecarSend,
    );
    // Delivery has already classified SSE (including a missing upstream content type)
    // and consumed bounded JSON/errors. Guard only its remaining direct body, outside
    // the relay/lifetime wrappers so their prefetch cannot arm our inactivity clock.
    const guarded = attachResponseToolOwnership(guardDirectPassthroughBodyInactivity(
      response,
      nativeExchange.upstream.signal,
      resolveStallTimeoutMs(requestContext.config.stallTimeoutSec, { localUpstream: nativeExchange.localUpstream }),
    ), nativeExchange.providerExecutedCallTypes);
    const wrapped = retainReserveTrial(guarded, admissionState.authCtx, requestContext.options.abortSignal ?? requestContext.req.signal);
    reserveTrialAttached = wrapped !== undefined;
    return carryCodexWsPreludeVerdict(nativeExchange.upstreamResponse, wrapped ?? guarded);
  } finally {
    if (nativeHostState.lease) releaseUpstreamHostAdmission(nativeHostState.lease);
    if (!reserveTrialAttached && (nativeHostState.lease || (admissionState.authCtx.kind === "pool" && admissionState.authCtx.poolReserve))) {
      releaseCodexAuthContextProbeLease(admissionState.authCtx);
    }
  }
}
