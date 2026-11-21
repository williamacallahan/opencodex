import type { PoolReserveWalk } from "../../codex/pool-reserve";
import type { RequestExecutionBudget, SingleUseDispatchPermit } from "../../lib/request-execution-budget";
import { inspectReserveRefusal } from "./reserve-refusal-body";
import { RequestPacingQueueOverloadError, RequestPacingProviderRemovedError } from "../../providers/request-pacing";
import { cancelResponseBodyBestEffort, fetchWithTransientRetry, TRANSIENT_RETRY_MAX_ATTEMPTS, UpstreamRetryEvidenceError } from "../../lib/upstream-retry";

/** No bytes left on this candidate. Only this disposition permits selection of the next seat. */
export class StaleReserveSeat extends Error {
  constructor(readonly accountId: string) { super("Reserve seat is no longer selectable"); }
}

/** The first send uses the account-move booking. Later transient sends consume ordinary slots
 * on that same ledger and share one transient ladder with all the earlier seats. */
export async function sendReserveSeat(walk: PoolReserveWalk, budget: RequestExecutionBudget,
  move: SingleUseDispatchPermit, signal: AbortSignal,
  send: (permit: SingleUseDispatchPermit, transient: boolean, onAdmitted: () => void) => Promise<Response | undefined>,
  callerSignal: AbortSignal = signal,
): Promise<Response | undefined> {
  const withheld = new Error("Reserve dispatch withheld");
  const remaining = budget.remainingBaseSends(Math.max(0, TRANSIENT_RETRY_MAX_ATTEMPTS - 1 - walk.transientRetries));
  let retained: Response | undefined;
  const discardRetained = () => {
    if (retained) cancelResponseBodyBestEffort(retained);
    retained = undefined;
  };
  try {
    const result = await fetchWithTransientRetry(async recovery => {
      const transient = recovery === "transient-5xx";
      const booking = transient && budget.lastTargetKey !== undefined
        ? budget.reserveDispatch({ sendClass: "transient", targetKey: budget.lastTargetKey }) : undefined;
      if (transient && !booking?.allowed) throw withheld;
      const permit = booking?.allowed ? booking.permit : move;
      try {
        const response = await send(permit, transient, discardRetained);
        if (!response) throw withheld;
        return response;
      } finally { if (transient) permit.release(); }
    }, { attempts: 1 + remaining, abortSignal: signal, async retainBeforeTransientRetry(response, inspectionMs) {
      const inspected = await inspectReserveRefusal(response, inspectionMs, signal);
      if (inspected.bytes) retained = inspected.response;
      return inspected;
    } });
    if (result === retained) retained = undefined;
    if (callerSignal.aborted) { cancelResponseBodyBestEffort(result); throw callerSignal.reason; }
    return result;
  } catch (error) {
    if (callerSignal.aborted) throw callerSignal.reason;
    const cause = error instanceof UpstreamRetryEvidenceError ? error.cause : error;
    if (cause === withheld || (retained && (signal.aborted || cause instanceof RequestPacingQueueOverloadError
      || cause instanceof RequestPacingProviderRemovedError))) {
      const refusal = retained; retained = undefined;
      return refusal;
    }
    throw error;
  } finally { discardRetained(); }
}
