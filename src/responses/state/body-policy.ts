/**
 * Request bodies that must never enter the continuation cache.
 *
 * The cache is persisted to `responses-state.json`, so anything recorded here reaches disk.
 * Encrypted-agent-task recovery decrypts task text into the request body and promises
 * in-memory, TTL-bounded retention; recording that body would put the plaintext on disk with
 * no TTL and break the promise.
 *
 * A WeakSet rather than a body field on purpose: `_rawBody` is serialized verbatim by the
 * native passthrough, so any marker written into the body itself would be sent upstream.
 * Marking is enforced once here rather than at each call site, because every recording path
 * (streaming, non-streaming, passthrough, forced) funnels through `rememberResponseState` —
 * a new call site cannot reintroduce the leak by forgetting a guard.
 */
const nonPersistableBodies = new WeakSet<object>();

/** Bar this exact request body from the continuation cache, and therefore from disk. */
export function markBodyNonPersistable(body: unknown): void {
  if (body && typeof body === "object") nonPersistableBodies.add(body as object);
}

/** Test the body's in-memory persistence restriction without adding a wire marker. */
export function isBodyNonPersistable(body: unknown): boolean {
  return !!body && typeof body === "object" && nonPersistableBodies.has(body);
}

// Replay provenance must stay proxy-private: a WeakMap distinguishes replayed history from the
// newly appended input suffix without adding an unknown field that native passthrough could send
// upstream. The parser uses this boundary to acknowledge historical compaction markers exactly
// once. It records the boundary whether the proxy prepended the history or the client already
// carried it — the boundary is the same either way, and only its provenance differs.
const upstreamHistoryBodies = new WeakSet<object>();
const replayedInputPrefixLengths = new WeakMap<object, number>();
const clientCarriedReplays = new WeakSet<object>(); // overlap skip: the client resent the window itself

export function noteUpstreamHistory(body: object): void { upstreamHistoryBodies.add(body); }
export function recordExpandedHistory(body: object, prefix: number, clientCarried = false): void {
  replayedInputPrefixLengths.set(body, prefix);
  if (clientCarried) clientCarriedReplays.add(body);
}
export function isCompleteResponseTranscript(request: Record<string, unknown>): boolean {
  return !upstreamHistoryBodies.has(request) && request.conversation == null && request.prompt == null
    && (request.previous_response_id == null || replayedInputPrefixLengths.has(request));
}

/** Number of leading input items restored from previous_response_id state for this exact body. */
export function previousResponseReplayPrefixLength(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  return replayedInputPrefixLengths.get(body) ?? 0;
}

/** Leading items the PROXY prepended; 0 when the client resent the stored window itself (overlap skip). */
export function previousResponseRestoredPrefixLength(body: unknown): number {
  return body && typeof body === "object" && clientCarriedReplays.has(body) ? 0 : previousResponseReplayPrefixLength(body);
}

/** Copy proxy-private replay provenance to an internal clone with the same materialized input. */
export function copyPreviousResponseReplayProvenance(source: unknown, target: unknown): void {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  if (!target || typeof target !== "object" || Array.isArray(target)) return;
  if (upstreamHistoryBodies.has(source)) upstreamHistoryBodies.add(target);
  const prefixLength = replayedInputPrefixLengths.get(source);
  if (prefixLength === undefined) return;
  const input = (target as { input?: unknown }).input;
  if (!Array.isArray(input) || prefixLength > input.length) return;
  replayedInputPrefixLengths.set(target, prefixLength);
  if (clientCarriedReplays.has(source)) clientCarriedReplays.add(target);
}
