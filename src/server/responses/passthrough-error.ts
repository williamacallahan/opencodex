import { formatErrorResponse } from "../../bridge";
import { isUnsafeJsonDocument } from "../../codex/quota-rejection";
import { isCyberPolicyMessage, terminalPolicyError } from "../../lib/errors";
import {
  applyReplayRefusalClientHeaders,
  isReplayRefusalCode,
  retainReplayRefusal,
  UPSTREAM_RESET_REPLAY_REFUSED_CODE,
} from "../../lib/upstream-retry";
import {
  formatClientRetryAfter,
  resolveClientRetryAfter,
} from "../../lib/retry-after";
import { isMetaMusePlanFailure, META_MUSE_PLAN_REFUSAL_MESSAGE } from "../../providers/meta-muse-plan-refusal";
import { maskDiagnosticJson } from "./terminal-error-redaction";

function maskErrorBody(body: string, mask: (text: string) => string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { return mask(body); }
  const safe = maskDiagnosticJson(parsed, mask);
  if (safe === body.trim()) return body;
  // A protocol tag may match the key. Ignore only JSON whitespace, never characters inside a string.
  const compact = body.replace(/"(?:\\.|[^"\\])*"|[ \t\r\n]+/g, token => token[0] === '"' ? token : "");
  if (safe === compact) return body;
  // Noncanonical escapes and numbers need an extra check: JSON.parse can also discard duplicate fields.
  return safe === JSON.stringify(parsed) && mask(body) === body && !isUnsafeJsonDocument(body) ? body : safe;
}

function isPolicyRefusalBody(body: string): boolean {
  try { return terminalPolicyError(JSON.parse(body)) !== undefined; }
  catch { return isCyberPolicyMessage(body); }
}

/**
 * True for a body this proxy wrote to refuse replaying an ambiguous pre-header reset.
 *
 * It is read off the body rather than a marker because this formatter is handed bytes, not
 * the response they came from, and the refusal reaches it after the original body was read.
 * The code is this proxy's own, so an upstream echoing it is not a case worth widening for.
 */
function isReplayRefusalBody(body: string): boolean {
  if (!body.includes(UPSTREAM_RESET_REPLAY_REFUSED_CODE)) return false;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
      ? parsed.error as Record<string, unknown>
      : undefined;
    return isReplayRefusalCode(error?.code) || isReplayRefusalCode(parsed.code);
  } catch {
    return false;
  }
}

/**
 * Passthrough adapters historically relayed upstream non-2xx bodies verbatim.
 * Codex maps an *empty* body to the literal client string "Unknown error"
 * (UnexpectedResponseError) — issue #452. Only empty bodies need wrapping.
 *
 * Non-empty bodies retain their upstream shape, including `{detail: ...}` account-model
 * errors. Public delivery masks credentials after retry policy reads the original diagnostic.
 *
 * Retry-After is validated independently of the body path:
 * - valid upstream values are preserved
 * - missing/malformed values are replaced when resolveClientRetryAfter yields a value
 * - malformed/expired values are removed when the resolver returns undefined
 *   (e.g. quota-exhausted 429s must not keep junk headers or get the synthetic "2")
 * - a replay refusal this proxy wrote gets none and keeps none: the whole point of the
 *   refusal is that the turn may already be running, and the synthetic default for a
 *   retryable 429 is a direct instruction to the client to send it a second time
 *
 * A refusal also leaves with the shared no-retry header and the in-process marker, so the
 * verdict survives this re-wrap as a property of the response rather than as a status a later
 * reader would have to guess from.
 */
export function formatPassthroughUpstreamError(
  status: number,
  bodyText: string,
  options?: {
    statusText?: string;
    headers?: Headers;
    now?: number;
    maskCredential?: (text: string) => string;
    /** Caller holds an authoritative fatal verdict; neither inherited nor inferred waits apply. */
    suppressRetryAfter?: boolean;
    /**
     * Provenance from the caller that still holds the response: this body is a refusal this
     * proxy synthesized. The body check below is the fallback for a re-wrapped body, and it
     * cannot answer at all when the bounded read returned nothing display-safe -- which is
     * precisely when the empty-body branch would invent the retryable-429 default.
     */
    replayRefusal?: boolean;
  },
): Response {
  const trimmed = bodyText.trim();
  const now = options?.now ?? Date.now();
  // Meta's Muse Code subscription refusal is relayed as this proxy's own explanation (#8352):
  // the upstream body names the restriction but not the supported path, and a verbatim relay
  // reads as a rejected credential. The shared classifier keeps the subscription class.
  if (isMetaMusePlanFailure(status, trimmed)) {
    const refusal = formatErrorResponse(status, "permission_error", META_MUSE_PLAN_REFUSAL_MESSAGE);
    if (!options?.headers) {
      return options?.statusText
        ? new Response(refusal.body, { status: refusal.status, statusText: options.statusText, headers: refusal.headers })
        : refusal;
    }
    // The body is this proxy's own, but the relayed headers the caller already sanitized (the
    // upstream request id among them) stay; a plan restriction names no wait.
    const headers = new Headers(options.headers);
    for (const name of ["content-length", "content-encoding", "retry-after"]) headers.delete(name);
    refusal.headers.forEach((value, name) => headers.set(name, value));
    return new Response(refusal.body, {
      status: refusal.status,
      ...(options.statusText ? { statusText: options.statusText } : {}),
      headers,
    });
  }
  const upstreamRetryAfter = options?.headers?.get("retry-after")?.trim() || undefined;
  const policyFailure = isPolicyRefusalBody(trimmed);
  const replayRefusal = options?.replayRefusal === true || isReplayRefusalBody(trimmed);
  // Two different reasons to answer with no wait at all, handled the same way: a hard policy
  // block will not become servable, and a refusal we made was never a rate limit.
  const suppressRetryAfter = options?.suppressRetryAfter === true || policyFailure || replayRefusal;
  const resolved = suppressRetryAfter
    ? undefined
    : resolveClientRetryAfter({
      status,
      message: trimmed || `Provider error ${status}: (empty body)`,
      upstreamRetryAfter,
      now,
    });

  // The header leaves in this proxy's own format: an integer of seconds, never the upstream bytes.
  const formatted = resolved === undefined ? undefined : formatClientRetryAfter(resolved, now);

  if (trimmed) {
    const mask = options?.maskCredential;
    const publicBody = mask ? maskErrorBody(bodyText, mask) : bodyText;
    const headers = new Headers(options?.headers ?? { "Content-Type": "application/json" });
    if (publicBody !== bodyText) {
      headers.delete("content-length");
      headers.delete("content-encoding");
    }
    if (formatted !== undefined) headers.set("Retry-After", formatted);
    else headers.delete("Retry-After");
    if (replayRefusal) applyReplayRefusalClientHeaders(headers);
    const rewritten = new Response(publicBody, {
      status,
      ...(options?.statusText ? { statusText: options.statusText } : {}),
      headers,
    });
    return replayRefusal ? retainReplayRefusal(rewritten) : rewritten;
  }

  const response = formatErrorResponse(
    status,
    "upstream_error",
    `Provider error ${status}: (empty body)`,
    // Provenance is all that is left when the bounded read returned nothing display-safe, and
    // it is enough: the formatter allowlists this code, restates the refusal status and marks
    // the response, so an unreadable refusal reaches the client as the same refusal.
    replayRefusal
      ? { code: UPSTREAM_RESET_REPLAY_REFUSED_CODE }
      : resolved !== undefined ? { retryAfter: resolved } : undefined,
  );
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json");
  if (formatted !== undefined) headers.set("Retry-After", formatted);
  else headers.delete("Retry-After");
  if (replayRefusal) applyReplayRefusalClientHeaders(headers);
  const wrapped = new Response(response.body, { status: response.status, headers });
  return replayRefusal ? retainReplayRefusal(wrapped) : wrapped;
}
