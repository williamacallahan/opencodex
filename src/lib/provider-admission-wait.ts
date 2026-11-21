import { AsyncLocalStorage } from "node:async_hooks";

// A queued child may rebuild its credentials or switch from WebSocket to HTTP before sending.
type CheckPhysicalAdmission = (removedSlot?: Error) => void;
export const physicalAdmission = new AsyncLocalStorage<CheckPhysicalAdmission>();
export function withPhysicalSendAdmission<T>(check: CheckPhysicalAdmission | undefined, dispatch: () => T): T {
  return check ? physicalAdmission.run(check, dispatch) : dispatch();
}

/** Shared by the executor and transports whose own admission queue precedes the wire. */
export const PHYSICAL_DISPATCH = Symbol.for("opencodex.physical-dispatch");
export function settlePhysicalDispatch(init?: RequestInit & { [PHYSICAL_DISPATCH]?: (body?: BodyInit | null) => void }): void {
  init?.[PHYSICAL_DISPATCH]?.(init.body);
}

/** Internal RequestInit metadata; never serialized into headers or upstream JSON. */
export const PROVIDER_HEADER_DEADLINE = Symbol("provider-header-deadline");
export type ProviderHeaderDeadline = { clientSignal: AbortSignal; pause(): void; resume(): void };

/** A local admission queue waits on client cancellation, outside the upstream header timer. */
export async function waitOutsideProviderHeaderDeadline<T>(
  init: RequestInit | undefined,
  wait: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = (init as (RequestInit & { [PROVIDER_HEADER_DEADLINE]?: ProviderHeaderDeadline }) | undefined)?.[PROVIDER_HEADER_DEADLINE];
  deadline?.pause();
  try { return await wait(deadline?.clientSignal ?? init?.signal ?? undefined); }
  finally { deadline?.resume(); }
}
