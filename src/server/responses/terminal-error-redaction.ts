import { OPENAI_ERROR_CODES, OPENAI_ERROR_TYPES } from "../../lib/client-error-body";
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
  return JSON.stringify(parsed, function (key, field: unknown) {
    if (typeof field === "string" && (
      (key === "code" && (OPENAI_ERROR_CODES.has(field) || OPENAI_ERROR_TYPES.has(field))) ||
      (key === "type" && (OPENAI_ERROR_TYPES.has(field) || (this === parsed && terminalType(field))))
    )) return field;
    if (key === "status" && (field === "failed" || field === "incomplete" || field === "completed")) return field;
    return SENSITIVE_KEY_PATTERN.test(key) ? REDACTED_SECRET
      : typeof field === "string" ? mask(redactSecretString(field)) : field;
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
