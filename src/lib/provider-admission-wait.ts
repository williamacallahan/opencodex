import { AsyncLocalStorage } from "node:async_hooks";

// A queued child may rebuild its credentials or switch from WebSocket to HTTP before sending.
type CheckPhysicalAdmission = (removedSlot?: Error) => void;
export const physicalAdmission = new AsyncLocalStorage<CheckPhysicalAdmission>();
export function withPhysicalSendAdmission<T>(check: CheckPhysicalAdmission | undefined, dispatch: () => T): T {
  return check ? physicalAdmission.run(check, dispatch) : dispatch();
}

/** Shared by the executor and transports whose own admission queue precedes the wire. */
const dispatchReceiptOwners = new WeakSet<object>();
export function markDispatchReceiptOwner(executor: typeof fetch): void {
  dispatchReceiptOwners.add(executor);
}
export function ownsDispatchReceipt(provider?: object): boolean {
  return !!provider && "fetch" in provider && typeof provider.fetch === "function" && dispatchReceiptOwners.has(provider.fetch);
}

export const PHYSICAL_DISPATCH = Symbol.for("opencodex.physical-dispatch");
/** Effects a pre-dispatch guard defers until the physical send is admitted. */
export const BEFORE_DISPATCH_COMMIT = Symbol.for("opencodex.before-dispatch-commit");
let activeBeforeDispatchCommits: Array<() => void> | undefined;
/**
 * Run a synchronous pre-dispatch guard and return the effects it deferred. The effects must run only
 * after `onPhysicalDispatch` admits the send; a veto there means no bytes leave and nothing commits.
 */
export function captureBeforeDispatchCommits(run: () => void): (() => void) | undefined {
  const commits: Array<() => void> = [];
  const previous = activeBeforeDispatchCommits;
  activeBeforeDispatchCommits = commits;
  try { run(); } finally { activeBeforeDispatchCommits = previous; }
  return commits.length === 0 ? undefined : () => { for (const commit of commits.splice(0)) commit(); };
}
/** Defer an effect while a guard is being captured; otherwise run it at once. */
export function deferBeforeDispatchCommit(commit: () => void): void {
  if (activeBeforeDispatchCommits) activeBeforeDispatchCommits.push(commit);
  else commit();
}
export function settlePhysicalDispatch(init?: RequestInit & {
  [PHYSICAL_DISPATCH]?: (body?: BodyInit | null) => void;
  [BEFORE_DISPATCH_COMMIT]?: () => void;
}): void {
  init?.[PHYSICAL_DISPATCH]?.(init.body);
  init?.[BEFORE_DISPATCH_COMMIT]?.();
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
