import { truncationReasonFor } from "../../responses/truncated-stop-reason";
import { REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecretString } from "../../lib/redact";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";

import { createOutboundCredentialMask } from "../../lib/outbound-credential-registry";
export { createOutboundCredentialMask };

/** An event name this proxy relays as protocol; any other upstream-chosen name is untrusted text. */
const PROTOCOL_EVENT_NAME = /^[ \t]*(?:error|response\.[a-z_.]+)[ \t]*$/;

const terminalType = (type: unknown) => type === "error" || type === "response.failed" || type === "response.incomplete" || type === "response.steer.failed" || type === "response.inject.failed";

/** Serialize the inspected values, never raw bytes discarded by JSON parsing. */
export function maskDiagnosticJson(parsed: unknown, mask: (text: string) => string): string {
  const roles = new WeakMap<object, "envelope" | "error" | "incomplete" | "usage" | "tokenDetails" | "output">();
  if (parsed && typeof parsed === "object") roles.set(parsed, "envelope");
  return JSON.stringify(parsed, function (key, field: unknown) {
    const role = roles.get(this);
    const childRole = role === "output" || (role === "envelope" && key === "output") ? "output"
      : role === "envelope" && key === "response" ? "envelope"
      : role === "envelope" && (key === "error" || key === "last_error") ? "error"
      : role === "envelope" && key === "incomplete_details" ? "incomplete"
      : role === "envelope" && key === "usage" ? "usage"
      : role === "usage" && /^(?:input|output|prompt|completion)_tokens_details$/.test(key) ? "tokenDetails" : undefined;
    if (childRole && field && typeof field === "object") roles.set(field, childRole);
    const counter = role === "usage" ? /^(?:input|output|total|prompt|completion)_tokens$/.test(key)
      : role === "tokenDetails" && /^(?:cached|reasoning|cache_write|cache_write_1h|audio|accepted_prediction|rejected_prediction)_tokens$/.test(key);
    const carrier = role === "envelope" || role === "error" || role === "incomplete";
    const outputField = role === "output" && /^(?:id|type|status|role|content|text|annotations|call_id|name|arguments|summary|encrypted_content)$/.test(key);
    if (outputField && typeof field === "string" && (
      (key === "role" && /^(?:assistant|user|system|developer)$/.test(field)) ||
      (key === "status" && /^(?:in_progress|completed|incomplete|failed|queued|cancelled)$/.test(field)) ||
      (key === "type" && /^(?:message|output_text|refusal|reasoning|reasoning_text|summary_text|function_call|custom_tool_call|web_search_call|file_search_call|computer_call|image_generation_call|code_interpreter_call|mcp_call)$/.test(field))
    )) return field;
    if (role === "envelope" && /^(?:created_at|completed_at)$/.test(key) && (typeof field === "number" || field === null)) return field;
    if (counter && typeof field === "number") return field;
    if (carrier && key === "retryable" && typeof field === "boolean") return field;
    if (role === "envelope" && ((key === "end_turn" && typeof field === "boolean") || (key === "sequence_number" && typeof field === "number"))) return field;
    if (this === parsed && this.type === "error" && (key === "status" || key === "status_code")
      && typeof field === "number" && Number.isInteger(field) && field >= 100 && field <= 599) return field;
    if (role === "incomplete" && key === "reason" && typeof field === "string" && truncationReasonFor(field) === field) return field;
    const protocol = (childRole && role !== "output") || outputField || counter || (role === "error" && key === "resets_at") || (carrier && /^(?:type|code|message|param|retryable)$/.test(key))
      || (role === "envelope" && /^(?:id|model|status|sequence_number|response_id|output)$/.test(key));
    if (!protocol && key && !Array.isArray(this) && mask(key) !== key) return undefined;
    if (role === "envelope" && key === "status" && (field === "failed" || field === "incomplete" || field === "completed")) return field;
    if (SENSITIVE_KEY_PATTERN.test(key)) return REDACTED_SECRET;
    // Generated answer text is the user's content: only the exact physical credential is removed from it.
    if (typeof field === "string") return role === "output" ? mask(field) : mask(redactSecretString(field));
    if (field === null || typeof field !== "object") {
      const scalar = String(field);
      if (mask(scalar) !== scalar) return REDACTED_SECRET;
    }
    return field;
  });
}

/** Mask upstream diagnostics before either SSE delivery or buffered JSON reconstruction. */
export function createTerminalErrorRedactionBlockRewrite(
  outboundHeaders: Record<string, string>,
  maskCredential: (text: string) => string = createOutboundCredentialMask(outboundHeaders),
): SseBlockRewrite {
  const maskFields = (block: string) => block.replace(/^([^:\r\n]*):([^\r\n]*)/gm, (line, name, text) =>
    name === "data" || name === "retry" || (name === "event" && PROTOCOL_EVENT_NAME.test(text)) ? line : `${name}:${maskCredential(text)}`);
  return (block) => {
    const payload = sseDataPayload(block);
    if (payload === null) return [maskFields(block)];
    const namedTerminal = /^event:[ \t]*(?:error|response\.(?:failed|incomplete))[ \t]*\r?$/m.test(block);
    let event: unknown;
    try { event = JSON.parse(payload); }
    catch {
      return [namedTerminal ? maskFields(replaceSseDataPayload(block, maskCredential(redactSecretString(payload)))) : block];
    }
    if (!namedTerminal && !(event && typeof event === "object" && "type" in event && terminalType(event.type))) return [block];
    const safe = maskDiagnosticJson(event, maskCredential);
    return [maskFields(safe === payload ? block : replaceSseDataPayload(block, safe))];
  };
}

/** A buffered terminal response (`failed` or `incomplete`) leaves with the same masking an SSE terminal gets. */
export function maskTerminalResponseJson(json: string, maskCredential: (text: string) => string): string {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json;
    const status = (parsed as { status?: unknown }).status;
    return status === "failed" || status === "incomplete" ? maskDiagnosticJson(parsed, maskCredential) : json;
  } catch {
    return json;
  }
}
