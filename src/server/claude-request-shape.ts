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
  /**
   * System block structure, so where a fork's system differs from its parent's shows: 0 blocks when
   * system is absent, 1 for a plain string. The fields below are absent on rows stored before they existed.
   */
  systemBlockCount?: number;
  /** Hashes of the first {@link MAX_SYSTEM_BLOCKS} blocks' text, in order. */
  systemBlocks?: ClaudeRequestShapeDigest[];
  /** Hash of the last block when there are more than {@link MAX_SYSTEM_BLOCKS}, else `absent`. */
  systemLastBlock?: ClaudeRequestShapeDigest;
  /** Hashes of the first {@link MESSAGES_PREFIX} messages' content, in order. */
  messagesPrefix?: ClaudeRequestShapeDigest[];
}

const DIGEST = new RegExp(`^[0-9a-f]{${LOG_CONVERSATION_ID_LEN}}$`);
const MARKERS = new Set(["absent", "empty", "invalid"]);
const MAX_MESSAGE_COUNT = 1_000_000;
const MAX_SYSTEM_BLOCKS = 12;
const MESSAGES_PREFIX = 3;

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

function textDigest(text: string): ClaudeRequestShapeDigest {
  return createHash("sha256").update(text).digest("hex").slice(0, LOG_CONVERSATION_ID_LEN);
}

/** A system block's text only; a block with no text hashes as its whole JSON, so it still differs by content. */
function systemBlockDigest(block: unknown): ClaudeRequestShapeDigest {
  if (typeof block === "string") return textDigest(block);
  if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
    return textDigest((block as { text: string }).text);
  }
  return contentDigest(block);
}

export function claudeRequestShape(headers: Headers, body: Record<string, unknown>): ClaudeRequestShape {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = body.system;
  const blocks: unknown[] = Array.isArray(system) ? system : typeof system === "string" ? [system] : [];
  return {
    agentId: headerDigest(headers, "x-claude-code-agent-id"),
    parentAgentId: headerDigest(headers, "x-claude-code-parent-agent-id"),
    system: contentDigest(body.system),
    tools: contentDigest(body.tools),
    messageCount: messages.length,
    firstMessage: contentDigest(messages[0]),
    systemBlockCount: blocks.length,
    systemBlocks: blocks.slice(0, MAX_SYSTEM_BLOCKS).map(systemBlockDigest),
    systemLastBlock: blocks.length > MAX_SYSTEM_BLOCKS ? systemBlockDigest(blocks[blocks.length - 1]) : "absent",
    messagesPrefix: messages.slice(0, MESSAGES_PREFIX).map(message =>
      contentDigest(message && typeof message === "object" ? (message as { content?: unknown }).content : undefined)),
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
  const base = { agentId, parentAgentId, system, tools, messageCount, firstMessage };
  const { systemBlockCount, systemBlocks, systemLastBlock, messagesPrefix } = row;
  // A row stored before the block fields existed carries none of them.
  if (systemBlockCount === undefined && systemBlocks === undefined && systemLastBlock === undefined && messagesPrefix === undefined) return base;
  const digests = (field: unknown, max: number): field is string[] =>
    Array.isArray(field) && field.length <= max && field.every(digest);
  if (typeof systemBlockCount !== "number" || !Number.isInteger(systemBlockCount) || systemBlockCount < 0 || systemBlockCount > MAX_MESSAGE_COUNT) return undefined;
  if (!digests(systemBlocks, MAX_SYSTEM_BLOCKS) || !digest(systemLastBlock) || !digests(messagesPrefix, MESSAGES_PREFIX)) return undefined;
  return { ...base, systemBlockCount, systemBlocks, systemLastBlock, messagesPrefix };
}
