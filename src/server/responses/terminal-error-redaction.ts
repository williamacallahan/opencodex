import { OPENAI_ERROR_CODES, OPENAI_ERROR_TYPES } from "../../lib/client-error-body";
import { truncationReasonFor } from "../../responses/truncated-stop-reason";
import { REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecretString } from "../../lib/redact";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";

import { createOutboundCredentialMask } from "../../lib/outbound-credential-registry";
export { createOutboundCredentialMask };

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
    if (carrier && typeof field === "string" && (
      (key === "code" && (OPENAI_ERROR_CODES.has(field) || OPENAI_ERROR_TYPES.has(field))) ||
      (key === "type" && (OPENAI_ERROR_TYPES.has(field) || field === "usage_limit_reached" || (this === parsed && terminalType(field))))
    )) return field;
    if (role === "envelope" && key === "status" && (field === "failed" || field === "incomplete" || field === "completed")) return field;
    if (SENSITIVE_KEY_PATTERN.test(key)) return REDACTED_SECRET;
    if (typeof field === "string") return mask(redactSecretString(field));
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
    name === "event" || name === "data" || name === "retry" ? line : `${name}:${maskCredential(text)}`);
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
