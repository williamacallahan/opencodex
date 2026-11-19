/**
 * Combo target pinning for a continuing conversation (#7298).
 *
 * A combo picks a target per request, but a conversation is many requests over one growing
 * history. Re-picking between them hands the next turn to a target that did not produce the
 * previous one: a cold prompt cache on another account, encrypted reasoning the new account cannot
 * read, and for a tool loop a hard failure (DeepSeek's thinking mode refuses a tool continuation
 * whose call carries no reasoning it can read, and a GPT turn never leaves one).
 *
 * So a request that continues its lane's conversation keeps the target that completed the lane's
 * previous turn, as long as that target is still selectable right now: enabled, still in the
 * combo, out of cooldown and passing every per-request eligibility filter the caller supplies.
 * When it is not, normal selection (and normal failover) runs, and the strict serializers make
 * the foreign history acceptable instead: see `backfillBareToolCallTurnReasoning` and the Chat
 * adapter's reasoning placeholder. A conversation's first request, which carries no earlier
 * output, is placed by normal selection.
 *
 * A JEV combo decides per user turn by design (#7525 owns its opt-in session pin), so it keeps only
 * the tool-loop pin: a request that ends in a tool output returns to the target that issued the call.
 */
import { pickComboTarget, targetKey, type ComboPick } from "../../combos";
import type { NormalizedComboTarget } from "../../combos/types";
import type { OcxConfig } from "../../types";
import { recallComboTargetForLane } from "./combo-session-recall";
import { isCompactionItemType } from "../../responses/compaction";

export const COMBO_CONVERSATION_PIN_REASON = "combo-conversation-pin";

function itemType(item: unknown): string | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const type = (item as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

const isToolOutputItem = (item: unknown): boolean => itemType(item)?.endsWith("_output") === true;

/** An item an earlier response produced (a compacted history or a stored-item reference included), or the tool result answering one. */
function isEarlierTurnItem(item: unknown): boolean {
  const type = itemType(item);
  if (type === "reasoning" || type === "item_reference" || isCompactionItemType(type)
    || type?.endsWith("_call") === true || type?.endsWith("_output") === true) return true;
  return (item as { role?: unknown } | undefined)?.role === "assistant";
}

/**
 * Whether this request resumes an assistant turn by returning tool results: its Responses
 * `input` (or Chat `messages`) ends with a tool output.
 */
export function isToolLoopContinuation(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const { input, messages } = body as { input?: unknown; messages?: unknown };
  if (Array.isArray(input)) return input.length > 0 && isToolOutputItem(input[input.length - 1]);
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1];
    return !!last && typeof last === "object" && (last as { role?: unknown }).role === "tool";
  }
  return false;
}

/** Whether this request carries an earlier turn's output: a later turn of an existing conversation. */
export function isConversationContinuation(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const { input, messages, previous_response_id: previousResponseId } = body as {
    input?: unknown; messages?: unknown; previous_response_id?: unknown;
  };
  if (typeof previousResponseId === "string" && previousResponseId.trim()) return true;
  if (Array.isArray(input)) return input.some(isEarlierTurnItem);
  if (Array.isArray(messages)) return messages.some(message => {
    const role = (message as { role?: unknown } | undefined)?.role;
    return role === "assistant" || role === "tool";
  });
  return false;
}

/**
 * The pick that keeps a continuing conversation on its previous target, or undefined to select
 * normally. Uses a non-mutating preview so a pinned request never disturbs round-robin rotation state.
 */
export function conversationPinnedPick(args: {
  config: OcxConfig;
  comboId: string;
  lane: string | undefined;
  body: unknown;
  /** Pin only a tool-output continuation (a JEV combo re-decides each user turn). */
  toolLoopOnly: boolean;
  eligible: (target: NormalizedComboTarget) => boolean;
  now?: number;
}): ComboPick | undefined {
  if (!(args.toolLoopOnly ? isToolLoopContinuation(args.body) : isConversationContinuation(args.body))) return undefined;
  const previous = recallComboTargetForLane(args.config, args.lane, args.comboId);
  if (!previous) return undefined;
  const previousKey = targetKey(previous);
  const pick = pickComboTarget(args.config, args.comboId, {
    eligible: target => targetKey(target) === previousKey && args.eligible(target),
    now: args.now,
    preview: true,
  });
  return pick ? { ...pick, attempted: [previousKey] } : undefined;
}
