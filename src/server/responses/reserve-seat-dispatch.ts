import type { PoolReserveWalk } from "../../codex/pool-reserve";
import type { RequestExecutionBudget, SingleUseDispatchPermit } from "../../lib/request-execution-budget";
import { fetchWithTransientRetry, TRANSIENT_RETRY_MAX_ATTEMPTS } from "../../lib/upstream-retry";

/** No bytes left on this candidate. Only this disposition permits selection of the next seat. */
export class StaleReserveSeat extends Error {
  constructor(readonly accountId: string) { super("Reserve seat is no longer selectable"); }
}

/** The first send uses the account-move booking. Later transient sends consume ordinary slots
 * on that same ledger and share one transient ladder with all the earlier seats. */
export async function sendReserveSeat(walk: PoolReserveWalk, budget: RequestExecutionBudget,
  move: SingleUseDispatchPermit, signal: AbortSignal,
  send: (permit: SingleUseDispatchPermit, transient: boolean) => Promise<Response | undefined>,
): Promise<Response | undefined> {
  const withheld = new Error("Reserve dispatch withheld");
  const remaining = budget.remainingBaseSends(Math.max(0, TRANSIENT_RETRY_MAX_ATTEMPTS - 1 - walk.transientRetries));
  try {
    return await fetchWithTransientRetry(async recovery => {
      const transient = recovery === "transient-5xx";
      const booking = transient && budget.lastTargetKey !== undefined
        ? budget.reserveDispatch({ sendClass: "transient", targetKey: budget.lastTargetKey }) : undefined;
      if (transient && !booking?.allowed) throw withheld;
      const permit = booking?.allowed ? booking.permit : move;
      try {
        const response = await send(permit, transient);
        if (!response) throw withheld;
        return response;
      } finally { if (transient) permit.release(); }
    }, { attempts: 1 + remaining, abortSignal: signal });
  } catch (error) {
    if (error === withheld) return undefined;
    throw error;
  }
}
