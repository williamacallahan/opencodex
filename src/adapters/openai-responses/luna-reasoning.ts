import { isPlainObject } from "../../lib/plain-data";
import { issuedReasoningMatcher } from "../../responses/reasoning-replay-cache";
import type { OcxParsedRequest } from "../../types";

export class LunaReasoningOwnerError extends Error {
  constructor(readonly reason: "store-mismatch" | "foreign-item" = "foreign-item") {
    super("This destination cannot replay the required reasoning item. No request was sent to it.");
  }
}

export function hasReasoningSummary(item: Record<string, unknown>): boolean {
  return Array.isArray(item.summary) && item.summary.some(part => isPlainObject(part)
    && part.type === "summary_text" && typeof part.text === "string" && part.text.trim().length > 0);
}

/** Only summarized items before a new readable user turn, with no tool call outstanding, can move. */
export function closedReasoningPrefix(input: readonly unknown[]): number {
  let boundary = 0;
  const pending = new Set<string>();
  for (const [i, item] of input.entries()) {
    if (!isPlainObject(item)) continue;
    if (item.role === "user" && (typeof item.content === "string" ? item.content.trim().length > 0
      : Array.isArray(item.content) && item.content.some(part => isPlainObject(part) && part.type === "input_text"
        && typeof part.text === "string" && part.text.trim()))) boundary = i;
    if (item.type === "function_call" || item.type === "custom_tool_call") pending.add(typeof item.call_id === "string" ? item.call_id : "");
    if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && typeof item.call_id === "string") pending.delete(item.call_id);
  }
  return pending.size ? 0 : boundary;
}

/** Run on the original input, before destination-specific transforms can erase a required item. */
export function projectLunaReasoning(parsed: OcxParsedRequest, stripsReasoning: boolean): unknown {
  const body = parsed._rawBody;
  const bound = parsed._lunaProjectForeignReasoning === "owner";
  // Owner mode without a recorded store is admitted only under a verified turn-state handle.
  const sameStore = parsed._recordedResponsesStore ? parsed._responsesStore === parsed._recordedResponsesStore : bound;
  if (bound && !sameStore) throw new LunaReasoningOwnerError("store-mismatch");
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  let issued: ReturnType<typeof issuedReasoningMatcher> | undefined;
  let boundary: number | undefined;
  // Once the active owner has issued a later reasoning item in the same history, earlier foreign
  // reasoning items from a prior seat/owner are already superseded across tool loops (#1299).
  let lastOwnIndex = -1;
  if (bound && sameStore && !stripsReasoning && !parsed._stripReasoningEncryptedContent && !parsed._dropForeignReasoningItemIds) {
    issued ??= issuedReasoningMatcher(parsed._reasoningReplayScope, parsed._issuedReasoningProofs);
    for (let idx = body.input.length - 1; idx >= 0; idx--) {
      const candidate = body.input[idx];
      if (!isPlainObject(candidate) || candidate.type !== "reasoning") continue;
      const cid = typeof candidate.id === "string" ? candidate.id : "";
      const cblob = typeof candidate.encrypted_content === "string" ? candidate.encrypted_content : "";
      if ((cid || cblob) && issued(cid, cblob) === "own") {
        lastOwnIndex = idx;
        break;
      }
    }
  }
  const dropped = Symbol();
  let input: unknown[] | undefined;
  for (const [i, item] of body.input.entries()) {
    if (!isPlainObject(item) || item.type !== "reasoning") continue;
    const id = typeof item.id === "string" ? item.id : "";
    const blob = typeof item.encrypted_content === "string" ? item.encrypted_content : "";
    if (!id && !blob) continue;
    issued ??= issuedReasoningMatcher(parsed._reasoningReplayScope, parsed._issuedReasoningProofs);
    const issuer = issued(id, blob);
    if (issuer === "own" && !stripsReasoning && !(blob && parsed._stripReasoningEncryptedContent)
      && !(id && parsed._dropForeignReasoningItemIds)) continue;
    // Other state may pin this request (a handle, for example) without making an older
    // summarized item from another issuer indispensable. Check the item, not the pin.
    boundary ??= parsed._lunaProjectForeignReasoning === "portable" ? body.input.length : closedReasoningPrefix(body.input);
    if (i >= boundary || !hasReasoningSummary(item)) {
      if ((issuer === "unknown" && bound && parsed._recordedResponsesStore)
        || (issuer === "foreign" && i < lastOwnIndex && !hasReasoningSummary(item))) {
        (input ??= body.input.slice())[i] = dropped;
        continue;
      }
      if (!(issuer === "foreign" && i < lastOwnIndex)) throw new LunaReasoningOwnerError("foreign-item");
    }
    const { id: _id, encrypted_content: _blob, ...readable } = item;
    (input ??= body.input.slice())[i] = readable;
  }
  return input ? { ...body, input: input.filter(item => item !== dropped) } : body;
}
