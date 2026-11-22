import { describe, expect, test } from "bun:test";
import { formatUsageLimitReachedResponse } from "../../src/bridge/errors";
import { upstreamErrorTailFrame } from "../../src/server/relay";
import { formatPassthroughUpstreamError } from "../../src/server/responses/passthrough-error";
import { createOutboundCredentialMask, createTerminalErrorRedactionBlockRewrite } from "../../src/server/responses/terminal-error-redaction";
import { sseDataPayload } from "../../src/server/sse-payload-rewrite";

function payload(block: string): unknown {
  const json = sseDataPayload(block);
  if (json === null) throw new Error("Expected an SSE data payload");
  return JSON.parse(json);
}

describe("terminal retry metadata", () => {
  test("media type and retry controls survive short credential collisions", () => {
    const headers = new Headers({ "content-type": "application/json", "x-should-retry": "false", "retry-after": "3", "x-note": "false" });
    const maskCredential = createOutboundCredentialMask({ authorization: "Bearer json", "x-api-key": "false", "x-goog-api-key": "3" });
    const response = formatPassthroughUpstreamError(503, "busy", { headers, maskCredential });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("x-note")).toBeNull();
  });

  test("a key matching a protocol field name does not rewrite a clean HTTP error", async () => {
    const body = '{\n  "error": { "type": "invalid_request_error", "message": "bad input" }\n}\n';
    const headers = new Headers({ "content-length": String(Buffer.byteLength(body)) });
    const response = formatPassthroughUpstreamError(400, body, { headers, maskCredential: createOutboundCredentialMask({ "x-api-key": "type" }) });
    expect(await response.text()).toBe(body);
    expect(response.headers.get("content-length")).toBe(headers.get("content-length"));
  });

  test("incomplete metadata stays typed without exempting matching diagnostic fields", () => {
    const rewrite = createTerminalErrorRedactionBlockRewrite({
      authorization: "Bearer false", "x-api-key": "retry", "x-goog-api-key": "tokens",
    });
    const usage = { output_tokens: 3, output_tokens_details: { reasoning_tokens: 2 } };
    const response = { status: "incomplete", end_turn: false, usage, incomplete_details: {
      reason: "max_output_tokens", retryable: false, diagnostics: {
        retryable: false, "extra-tokens": 2, samples: [false, "retry", 3],
      },
    } };
    const event = { type: "response.incomplete", response };
    const [block] = rewrite(`event: response.incomplete\ndata: ${JSON.stringify(event)}`);
    expect(payload(block!)).toEqual({ ...event, response: { ...response, incomplete_details: {
      reason: "max_output_tokens", retryable: false, diagnostics: { samples: ["[REDACTED]", "[REDACTED]", 3] },
    } } });
  });

  test("terminal diagnostics cannot rename output fields or change response timestamps", () => {
    const rewrite = createTerminalErrorRedactionBlockRewrite({ "x-api-key": "id", authorization: "Bearer 314", "x-goog-api-key": "ess" });
    const response = { id: "resp_314", response_id: "314", model: "model_314", status: "failed", created_at: 314,
      output: [{ id: "msg_314", type: "message", role: "assistant", status: "completed", content: [
        { type: "unexpected_314", role: "314", status: "314", id: "314", text: "314", extra_314: 1 },
      ] }], error: { message: "id 314" } };
    const event = { type: "response.failed", response };
    const [block] = rewrite(`event: response.failed\ndata: ${JSON.stringify(event)}`);
    expect(payload(block!)).toEqual({ ...event, response: { ...response, id: "resp_[REDACTED]", response_id: "[REDACTED]", model: "model_[REDACTED]",
      output: [{ id: "msg_[REDACTED]", type: "message", role: "assistant", status: "completed", content: [
        { type: "unexpected_[REDACTED]", role: "[REDACTED]", status: "[REDACTED]", id: "[REDACTED]", text: "[REDACTED]" },
      ] }], error: { message: "[REDACTED] [REDACTED]" } } });
  });

  test.each(["status", "status_code"])("wrapped %s and error.retryable keep their wire types", statusField => {
    const rewrite = createTerminalErrorRedactionBlockRewrite({
      authorization: "Bearer 503", "x-api-key": "true", "x-goog-api-key": "status",
    });
    const event = { type: "error", [statusField]: 503, error: {
      type: "server_error", code: "server_is_overloaded", retryable: true,
      details: { status: 503, reading: 503, flag: true, count: 7 },
    } };
    const [block] = rewrite(`event: error\ndata: ${JSON.stringify(event)}`);
    expect(payload(block!)).toEqual({ ...event, error: { ...event.error,
      details: { reading: "[REDACTED]", flag: "[REDACTED]", count: 7 },
    } });
  });

  test("a matching quota reset is masked without changing the quota verdict or retry header", async () => {
    const quota = formatUsageLimitReachedResponse("fixture 314", 2_000_000_314_000, 314);
    const maskCredential = createOutboundCredentialMask({ authorization: "Bearer 314", "x-api-key": "usage" });
    const outgoing = formatPassthroughUpstreamError(quota.status, await quota.text(), { headers: quota.headers, maskCredential });
    expect(outgoing.status).toBe(429);
    expect(outgoing.headers.get("retry-after")).toBe("314");
    expect(await outgoing.json()).toEqual({ error: {
      type: "usage_limit_reached", code: "usage_limit_reached", resets_at: "[REDACTED]", message: "fixture [REDACTED]",
    } });
  });

  test("resets_at survives a field-name collision without trusting unknown error tags", async () => {
    const maskCredential = createOutboundCredentialMask({ "x-api-key": "reset" });
    const error = { resets_at: 2_000_000_314, type: "reset", code: "reset", message: "fixture reset",
      details: { resets_at: 2_000_000_314, keep: 7 } };
    const outgoing = formatPassthroughUpstreamError(429, JSON.stringify({ error }), { maskCredential });
    expect(await outgoing.json()).toEqual({ error: {
      resets_at: 2_000_000_314, type: "[REDACTED]", code: "[REDACTED]", message: "fixture [REDACTED]",
      details: { keep: 7 },
    } });
  });

  test("a synthetic failed tail masks refusal wording without rewriting its fatal code", () => {
    const mask = createOutboundCredentialMask({ "x-api-key": "prompt" });
    const frame = upstreamErrorTailFrame(new TextEncoder(), "fixture prompt", "invalid_prompt", mask);
    const error = { type: "invalid_request_error", code: "invalid_prompt", message: "fixture [REDACTED]" };
    expect(payload(new TextDecoder().decode(frame).trimEnd())).toEqual({ type: "response.failed",
      response: { status: "failed", retryable: false, error, last_error: error },
    });
  });
});
