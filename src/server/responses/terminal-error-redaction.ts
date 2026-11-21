import { OPENAI_ERROR_CODES, OPENAI_ERROR_TYPES } from "../../lib/client-error-body";
import { truncationReasonFor } from "../../responses/truncated-stop-reason";
import { REDACTED_SECRET, SENSITIVE_KEY_PATTERN, redactSecretString } from "../../lib/redact";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";

/** Mask the selected outbound credential even when upstream echoes only its raw value. */
export function createOutboundCredentialMask(outboundHeaders: Record<string, string>): (text: string) => string {
  const knownSecrets = Object.entries(outboundHeaders)
    .filter(([name]) => SENSITIVE_KEY_PATTERN.test(name))
    .flatMap(([name, value]) => {
      const credential = /^(?:authorization|proxy-authorization)$/i.test(name)
        ? value.replace(/^\S+\s+/, "")
        : value;
      return credential ? [credential] : [];
    })
    .sort((a, b) => b.length - a.length);
  return (text) => knownSecrets.reduce((safe, secret) => safe.replaceAll(secret, REDACTED_SECRET), text);
}

const terminalType = (type: unknown) => type === "error" || type === "response.failed" || type === "response.incomplete";

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
    if (role === "output") {
      if (SENSITIVE_KEY_PATTERN.test(key)) return REDACTED_SECRET;
      return typeof field === "string" && !/^(?:id|type|status|role)$/.test(key) ? mask(redactSecretString(field)) : field;
    }
    if (role === "envelope" && /^(?:id|response_id|model)$/.test(key) && typeof field === "string") return field;
    if (role === "envelope" && /^(?:created_at|completed_at)$/.test(key) && (typeof field === "number" || field === null)) return field;
    if (counter && typeof field === "number") return field;
    if (carrier && key === "retryable" && typeof field === "boolean") return field;
    if (role === "envelope" && ((key === "end_turn" && typeof field === "boolean") || (key === "sequence_number" && typeof field === "number"))) return field;
    if (this === parsed && this.type === "error" && (key === "status" || key === "status_code")
      && typeof field === "number" && Number.isInteger(field) && field >= 100 && field <= 599) return field;
    if (role === "error" && key === "resets_at" && typeof field === "number" && Number.isSafeInteger(field) && field >= 0) return field;
    if (role === "incomplete" && key === "reason" && typeof field === "string" && truncationReasonFor(field) === field) return field;
    const protocol = childRole || counter || (carrier && /^(?:type|code|message|param|retryable)$/.test(key))
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
  maskCredential = createOutboundCredentialMask(outboundHeaders),
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
