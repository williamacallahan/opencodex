import { claudeSessionCacheKey } from "../claude/inbound";

/**
 * Which requests with an agent id are forked subagents, from hashes only. A fork replays its
 * parent's conversation, so its first message equals the main loop's; a fresh subagent starts its own.
 * Per Claude Code session this remembers the main loop's first-message hash (updated on every request
 * without an agent id) and calls an agent-id request a fork exactly when its first message matches.
 * One in-memory map, least recently used out first; a restart only makes the first fork after it
 * read as fresh once.
 */
export const MAX_CLAUDE_FORK_SESSIONS = 4096;

export type ClaudeForkDecision = "true" | "false" | "absent";

const mainLoopFirstMessage = new Map<string, string>();
const HEX_DIGEST = /^[0-9a-f]{32}$/;

function touch(sessionKey: string, digest: string): void {
  mainLoopFirstMessage.delete(sessionKey);
  mainLoopFirstMessage.set(sessionKey, digest);
  while (mainLoopFirstMessage.size > MAX_CLAUDE_FORK_SESSIONS) {
    const oldest = mainLoopFirstMessage.keys().next();
    if (oldest.done) break;
    mainLoopFirstMessage.delete(oldest.value);
  }
}

/** The session's key from `metadata.user_id`, or undefined when the request carries none. */
export function claudeForkSessionKey(body: Record<string, unknown>): string | undefined {
  const metadata = body.metadata;
  const userId = metadata && typeof metadata === "object" ? (metadata as { user_id?: unknown }).user_id : undefined;
  return typeof userId === "string" ? claudeSessionCacheKey(userId) : undefined;
}

/**
 * Record or judge one request. `firstMessageDigest` is the request-shape record's `messagesPrefix[0]`;
 * a marker (absent, invalid) is never remembered and never matches.
 */
export function resolveClaudeFork(input: {
  sessionKey: string | undefined;
  hasAgentId: boolean;
  firstMessageDigest: string | undefined;
}): ClaudeForkDecision {
  const { sessionKey, hasAgentId, firstMessageDigest } = input;
  const usable = sessionKey !== undefined && firstMessageDigest !== undefined && HEX_DIGEST.test(firstMessageDigest);
  if (!hasAgentId) {
    if (usable) touch(sessionKey, firstMessageDigest);
    return "absent";
  }
  if (usable && mainLoopFirstMessage.get(sessionKey) === firstMessageDigest) {
    touch(sessionKey, firstMessageDigest);
    return "true";
  }
  return "false";
}

export function claudeForkSessionCountForTests(): number { return mainLoopFirstMessage.size; }
export function clearClaudeForkSessionsForTests(): void { mainLoopFirstMessage.clear(); }
