import type { CodexAccountModelRefusal } from "../../combos/failover";
import { attachComboFailureEvidence, comboFailureEvidence } from "../../lib/client-error-body";
import type { RequestLogContext } from "../request-log";
import {
  BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS,
  type BufferedResponsesReadOptions,
  type BufferedResponsesSseFailure,
} from "./buffered-sse-json";
import { preflightComboStreamResponse } from "./combo-stream-preflight";

export type BufferedComboPreflight =
  /** The turn is committed or terminal; `body` replays the inspected prefix, then the same reader. */
  | { kind: "accepted"; body: ReadableStream<Uint8Array> }
  /** A retryable terminal arrived before any output, shaped exactly like a failed streaming preflight. */
  | { kind: "failed"; response: Response; codexModelRefusal?: CodexAccountModelRefusal }
  | { kind: "failure"; failure: BufferedResponsesSseFailure };

/**
 * Judge a combo child's SSE with the streaming failover rules before it is folded into JSON.
 *
 * The folded JSON reaches the combo parent as a bare HTTP 200, so a zero-output `response.failed`
 * would otherwise be recorded as the leg's win even though the same frames fail over on a
 * streaming turn. This reuses `preflightComboStreamResponse` on the one upstream reader and keeps
 * the fold's silence and total deadlines, which the preflight's own reads do not enforce.
 */
export async function preflightBufferedComboChild(
  source: ReadableStream<Uint8Array>,
  headers: Headers,
  logCtx: RequestLogContext,
  options: {
    signal: AbortSignal;
    read: BufferedResponsesReadOptions;
    maskCredential: (text: string) => string;
  },
): Promise<BufferedComboPreflight> {
  const { signal, read, maskCredential } = options;
  const preflightAbort = new AbortController();
  const abortPreflight = (): void => preflightAbort.abort(signal.reason);
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  const armSilence = (silenceMs: number): void => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(
      () => preflightAbort.abort(new Error("buffered Responses SSE preflight timeout")),
      Math.max(0, Math.min(silenceMs, read.deadlineAt - Date.now())),
    );
  };
  if (signal.aborted) abortPreflight();
  else signal.addEventListener("abort", abortPreflight, { once: true });
  armSilence(read.firstByteTimeoutMs ?? BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS);
  const sseHeaders = new Headers(headers);
  sseHeaders.set("content-type", "text/event-stream");
  try {
    const preflight = await preflightComboStreamResponse(
      new Response(source, { status: 200, headers: sseHeaders }),
      logCtx,
      undefined,
      {
        signal: preflightAbort.signal,
        onUpstreamActivity: () => armSilence(read.inactivityTimeoutMs ?? BUFFERED_RESPONSES_TOTAL_TIMEOUT_MS),
      },
    );
    if (preflight.kind !== "failed") return { kind: "accepted", body: preflight.response.body! };
    let failed = preflight.response;
    const failedText = await failed.clone().text();
    const maskedText = maskCredential(failedText);
    if (maskedText !== failedText) {
      // The rebuilt envelope is what the combo parent classifies and may return to the client.
      const evidence = comboFailureEvidence(failed);
      failed = new Response(maskedText, { status: failed.status, headers: failed.headers });
      if (evidence !== undefined) attachComboFailureEvidence(failed, maskCredential(evidence));
    }
    return {
      kind: "failed",
      response: failed,
      ...(preflight.codexModelRefusal === undefined ? {} : { codexModelRefusal: preflight.codexModelRefusal }),
    };
  } catch (error) {
    return {
      kind: "failure",
      failure: {
        ok: false,
        error,
        kind: signal.aborted ? "aborted" : preflightAbort.signal.aborted ? "timeout" : "read_error",
      },
    };
  } finally {
    clearTimeout(silenceTimer);
    signal.removeEventListener("abort", abortPreflight);
  }
}
