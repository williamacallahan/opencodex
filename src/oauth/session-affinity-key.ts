import { createHash } from "node:crypto";

/**
 * Route-continuity identity of one Claude Code agent transcript: the session key for the main
 * loop, and a hash of session key plus the real `x-claude-code-agent-id` for a subagent. A fork
 * shares its parent's body `prompt_cache_key` but not its transcript, so it keys by its own id.
 */
export function agentServingThreadKey(sessionKey: string, agentId?: string): string {
  return agentId === undefined
    ? sessionKey
    : createHash("sha256").update(`${sessionKey}:serving-agent:${agentId}`).digest("hex").slice(0, 32);
}

/** Shared conversation identity precedence; Desktop cohort cache keys never bind sessions. */
export function oauthSessionKeyFromParts(input: {
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  promptCacheKey?: string | null;
  clientThreadId?: string | null;
  /** When true, prompt_cache_key is a shared Desktop cohort — ignore it for affinity. */
  promptCacheKeyIsSharedCohort?: boolean;
}): string | null {
  const preferred = input.clientThreadId?.trim()
    || input.sessionIdHeader?.trim()
    || input.threadIdHeader?.trim()
    || "";
  if (preferred) {
    return preferred.length <= 128 ? preferred : createHash("sha256").update(preferred).digest("hex");
  }
  if (input.promptCacheKeyIsSharedCohort) return null;
  const cacheKey = input.promptCacheKey?.trim() ?? "";
  if (!cacheKey) return null;
  return cacheKey.length <= 128 ? cacheKey : createHash("sha256").update(cacheKey).digest("hex");
}
