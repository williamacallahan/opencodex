import { claudeSessionCacheKey } from "../claude/inbound";
import { claudeAdmissionScope } from "./claude-bridge-pool-session";
import { isClaudeRequestShapeHash, type ClaudeRequestShapeFork } from "./claude-request-shape";
import type { DataPlaneAdmission } from "./auth-cors";

/**
 * Which requests with an agent id are forked subagents, from hashes only. A fork replays its parent's
 * conversation, so it carries the parent's first message and tools; a fresh subagent starts its own.
 * Per Claude Code session (bound to its admission scope) this remembers the (first message, tools)
 * pair of the last few requests that carried no agent header at all, and calls an agent-id request a
 * fork exactly when its pair matches one of them. One in-memory map, least recently used out first.
 * After a restart or an eviction a fork gets its own key until its parent's next request.
 */
export const MAX_CLAUDE_FORK_SESSIONS = 4096;
/** Distinct agentless (first message, tools) pairs kept per session: a side request does not displace the main loop's. */
export const MAX_CLAUDE_FORK_PAIRS = 4;

const remembered = new Map<string, string[]>();

/** The agent header's state: `absent` (no header), `agent` (a valid id), `ignored` (empty, oversized, repeated). */
export type ClaudeForkRequestKind = "absent" | "agent" | "ignored";

/** The map key: the session's key bound to the caller's admission scope, or undefined when either is missing. */
export function claudeForkSessionKey(body: Record<string, unknown>, admission: DataPlaneAdmission | undefined): string | undefined {
  const metadata = body.metadata;
  const userId = metadata && typeof metadata === "object" ? (metadata as { user_id?: unknown }).user_id : undefined;
  if (typeof userId !== "string" || !admission) return undefined;
  const scope = claudeAdmissionScope(admission);
  return scope === undefined ? undefined : JSON.stringify([scope, claudeSessionCacheKey(userId)]);
}

function remember(sessionKey: string, pair: string): void {
  const pairs = (remembered.get(sessionKey) ?? []).filter(known => known !== pair);
  pairs.push(pair);
  if (pairs.length > MAX_CLAUDE_FORK_PAIRS) pairs.shift();
  remembered.delete(sessionKey);
  remembered.set(sessionKey, pairs);
  while (remembered.size > MAX_CLAUDE_FORK_SESSIONS) {
    const oldest = remembered.keys().next();
    if (oldest.done) break;
    remembered.delete(oldest.value);
  }
}

/**
 * Record or judge one request. The digests are the request-shape record's `messagesPrefix[0]` and
 * `tools`; a marker (absent, invalid) is never remembered and never matches.
 */
export function resolveClaudeFork(input: {
  sessionKey: string | undefined;
  kind: ClaudeForkRequestKind;
  firstMessageDigest: string | undefined;
  toolsDigest: string | undefined;
}): ClaudeRequestShapeFork {
  const { sessionKey, kind, firstMessageDigest, toolsDigest } = input;
  if (kind === "ignored") return "absent";
  const usable = sessionKey !== undefined && isClaudeRequestShapeHash(firstMessageDigest) && isClaudeRequestShapeHash(toolsDigest);
  const pair = usable ? `${firstMessageDigest}:${toolsDigest}` : undefined;
  if (kind === "absent") {
    if (usable) remember(sessionKey, pair!);
    return "absent";
  }
  if (usable && remembered.get(sessionKey)?.includes(pair!)) {
    remember(sessionKey, pair!);
    return "true";
  }
  return "false";
}

export function claudeForkSessionCountForTests(): number { return remembered.size; }
export function clearClaudeForkSessionsForTests(): void { remembered.clear(); }
