import { createHash } from "node:crypto";
import { LOG_CONVERSATION_ID_LEN, normalizeLogConversationId } from "./request-log-conversation";

/**
 * What identifies a Claude Code Messages request's prefix, as hashes only, so a forked subagent's
 * first turn can be compared with its parent's previous turn: same system and tools bytes, same
 * first message, a message count that continues the parent's. Never a raw id or prompt text.
 *
 * Each hash field is a {@link LOG_CONVERSATION_ID_LEN}-char hex digest, or a marker saying why
 * there is none: `absent` (header or field missing), `empty` (header present, blank), `invalid`
 * (a header value the log hasher refuses: control characters or oversized).
 */
export type ClaudeRequestShapeDigest = string;

export interface ClaudeRequestShape {
  agentId: ClaudeRequestShapeDigest;
  parentAgentId: ClaudeRequestShapeDigest;
  system: ClaudeRequestShapeDigest;
  tools: ClaudeRequestShapeDigest;
  messageCount: number;
  firstMessage: ClaudeRequestShapeDigest;
}

const DIGEST = new RegExp(`^[0-9a-f]{${LOG_CONVERSATION_ID_LEN}}$`);
const MARKERS = new Set(["absent", "empty", "invalid"]);
const MAX_MESSAGE_COUNT = 1_000_000;

function headerDigest(headers: Headers, name: string): ClaudeRequestShapeDigest {
  const value = headers.get(name);
  if (value === null) return "absent";
  if (value.trim() === "") return "empty";
  // The hub's log identifier hasher: sha256, refusing control characters and oversized input.
  return normalizeLogConversationId(value) ?? "invalid";
}

function contentDigest(value: unknown): ClaudeRequestShapeDigest {
  if (value === undefined || value === null) return "absent";
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, LOG_CONVERSATION_ID_LEN);
}

export function claudeRequestShape(headers: Headers, body: Record<string, unknown>): ClaudeRequestShape {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return {
    agentId: headerDigest(headers, "x-claude-code-agent-id"),
    parentAgentId: headerDigest(headers, "x-claude-code-parent-agent-id"),
    system: contentDigest(body.system),
    tools: contentDigest(body.tools),
    messageCount: messages.length,
    firstMessage: contentDigest(messages[0]),
  };
}

/** Accepts only the exact stored shape, so a persisted row can never smuggle free text into the record. */
export function parseClaudeRequestShape(value: unknown): ClaudeRequestShape | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const digest = (field: unknown): field is string => typeof field === "string" && (DIGEST.test(field) || MARKERS.has(field));
  const { agentId, parentAgentId, system, tools, messageCount, firstMessage } = row;
  if (!digest(agentId) || !digest(parentAgentId) || !digest(system) || !digest(tools) || !digest(firstMessage)) return undefined;
  if (typeof messageCount !== "number" || !Number.isInteger(messageCount) || messageCount < 0 || messageCount > MAX_MESSAGE_COUNT) return undefined;
  return { agentId, parentAgentId, system, tools, messageCount, firstMessage };
}
