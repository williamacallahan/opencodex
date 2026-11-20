import { isClaudeRequestShapeHash, type ClaudeRequestShapeFork } from "./claude-request-shape";

/**
 * Which requests with an agent id are forked subagents, from hashes only. A fork replays its parent's
 * conversation, so it carries the parent's first message and tools; a fresh subagent starts its own.
 * Per Claude Code session (bound to its admission scope) this remembers the (first message, tools)
 * pair of the last few requests that carried no agent header at all, and calls an agent-id request a
 * fork on first placement when its pair matches one of them.
 * A transcript retains its first cache-group choice independently of its parent's hints.
 */
export const MAX_CLAUDE_FORK_SESSIONS = 4096;
/** Distinct agentless (first message, tools) pairs kept per session: a side request does not displace the main loop's. */
export const MAX_CLAUDE_FORK_PAIRS = 4;

// A burst of unserved first-message hints must not evict a successfully served transcript.
const remembered = new Map<string, string[]>();
interface ServedCacheGroup { cacheKey: string; sessionId: string; fork: ClaudeRequestShapeFork }
const transcripts = new Map<string, ServedCacheGroup>();

export function servedClaudeCacheGroup(transcript: string | undefined): ServedCacheGroup | undefined {
  return transcript ? transcripts.get(transcript) : undefined;
}

export function rememberServedClaudeCacheGroup(transcript: string, group: ServedCacheGroup): void {
  const first = transcripts.get(transcript) ?? group;
  remember(transcripts, transcript, first);
}

/** The agent header's state: `absent` (no header), `agent` (a valid id), `ignored` (empty, oversized, repeated). */
export type ClaudeForkRequestKind = "absent" | "agent" | "ignored";

function remember<T>(store: Map<string, T>, sessionKey: string, entry: T): void {
  store.delete(sessionKey);
  store.set(sessionKey, entry);
  while (store.size > MAX_CLAUDE_FORK_SESSIONS) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
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
  if (sessionKey === undefined) return kind === "absent" ? "absent" : "false";
  const pair = isClaudeRequestShapeHash(firstMessageDigest) && isClaudeRequestShapeHash(toolsDigest)
    ? `${firstMessageDigest}:${toolsDigest}` : undefined;
  const pairs = remembered.get(sessionKey) ?? [];
  if (kind === "absent") {
    if (pair) remember(remembered, sessionKey, [...pairs.filter(known => known !== pair), pair].slice(-MAX_CLAUDE_FORK_PAIRS));
    return "absent";
  }
  const fork = pair !== undefined && pairs.includes(pair);
  if (fork) remember(remembered, sessionKey, pairs);
  return fork ? "true" : "false";
}

export function claudeForkSessionCountForTests(): number { return remembered.size; }
export function clearClaudeForkSessionsForTests(): void { remembered.clear(); transcripts.clear(); }
