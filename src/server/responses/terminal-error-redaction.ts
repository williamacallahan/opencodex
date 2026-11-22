import { redactSecrets } from "../../lib/redact";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "../sse-payload-rewrite";

import { createOutboundCredentialMask } from "../../lib/outbound-credential-registry";
export { createOutboundCredentialMask };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Diagnostic fields are redacted by pattern and by the physical credential. Generated `output` is
 * the user's content: an example `Authorization: Bearer ...` in an answer survives, and only the
 * exact credential this process sent is removed from it.
 */
export function redactTerminalDiagnostics(value: unknown, maskCredential: (text: string) => string): unknown {
  const maskKnown = (entry: unknown): unknown => {
    if (typeof entry === "string") return maskCredential(entry);
    if (Array.isArray(entry)) return entry.map(maskKnown);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, maskKnown(item)]));
    }
    return entry;
  };
  const redactCarrier = (carrier: Record<string, unknown>): Record<string, unknown> => {
    const { output, ...diagnostics } = carrier;
    const safe = maskKnown(redactSecrets(diagnostics)) as Record<string, unknown>;
    return "output" in carrier ? { ...safe, output: maskKnown(output) } : safe;
  };
  if (!isRecord(value)) return maskKnown(redactSecrets(value));
  if (!isRecord(value.response)) return redactCarrier(value);
  const { response, ...envelope } = value;
  return { ...(maskKnown(redactSecrets(envelope)) as Record<string, unknown>), response: redactCarrier(response as Record<string, unknown>) };
}

/** A buffered terminal response (`failed` or `incomplete`) leaves with the same masking an SSE terminal gets. */
export function maskTerminalResponseJson(json: string, maskCredential: (text: string) => string): string {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed) || (parsed.status !== "failed" && parsed.status !== "incomplete")) return json;
    return JSON.stringify(redactTerminalDiagnostics(parsed, maskCredential));
  } catch {
    return json;
  }
}

/** Mask upstream diagnostics before either SSE delivery or buffered JSON reconstruction. */
export function createTerminalErrorRedactionBlockRewrite(
  outboundHeaders: Record<string, string>,
  maskCredential: (text: string) => string = createOutboundCredentialMask(outboundHeaders),
): SseBlockRewrite {
  const redactDiagnostic = (value: unknown): unknown => redactTerminalDiagnostics(value, maskCredential);
  return (block) => {
    const terminalFrame = /^event:[ \t]*response\.(?:failed|incomplete)[ \t]*\r?$/m.test(block);
    const payload = sseDataPayload(block);
    if (payload === null) return [terminalFrame ? maskCredential(block) : block];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return [terminalFrame ? maskCredential(block) : block];
    }
    if (event?.type !== "response.failed" && event?.type !== "response.incomplete") {
      return [terminalFrame ? maskCredential(block) : block];
    }
    const safeEvent = redactDiagnostic(event);
    const rewritten = JSON.stringify(safeEvent);
    // SSE comments and extension fields can also carry upstream text.
    return [maskCredential(rewritten === payload ? block : replaceSseDataPayload(block, rewritten))];
  };
}
