/**
 * A relay of the ChatGPT Codex backend (codex-lb's /backend-api/codex) is SSE-only like the
 * backend itself. Declaring `responsesStreamOnly` makes the hub stream upstream and fold the
 * terminal stream back into JSON for a non-streaming client, as it already does for chatgpt.com.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const relay: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://relay.example/backend-api/codex",
  authMode: "key",
  apiKey: "test-key",
};
const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  releaseSpendHome?.();
  releaseSpendHome = undefined;
});

function sse(text: string): Response {
  const completed = {
    id: "resp_stream_only", object: "response", status: "completed", model: "gpt-6-luna",
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  };
  const body = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...completed, status: "in_progress", output: [] } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`,
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function send(provider: OcxProviderConfig): Promise<{ response: Response; upstreamStream: unknown }> {
  let upstreamStream: unknown;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { stream?: unknown };
    upstreamStream = body.stream;
    return body.stream === true
      ? sse("ok")
      : Response.json({ error: { message: "Stream must be set to true" } }, { status: 400 });
  }) as typeof fetch;
  releaseSpendHome ??= acquireOwnedSpendHome();
  const response = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay/gpt-6-luna", input: "Reply ok", stream: false }),
    }),
    { providers: { relay: provider } } as unknown as OcxConfig,
    { model: "", provider: "" },
    { inboundWire: "responses" },
  );
  return { response, upstreamStream };
}

describe("responsesStreamOnly destinations", () => {
  test("a model routed to Chat receives and returns non-streaming JSON", async () => {
    let upstreamStream: unknown;
    let upstreamUrl = "";
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      upstreamUrl = String(url);
      upstreamStream = (JSON.parse(String(init?.body)) as { stream?: unknown }).stream;
      return Response.json({ id: "chat_1", object: "chat.completion", model: "gpt-6-luna", choices: [{ index: 0, message: { role: "assistant", content: "chat answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    }) as typeof fetch;
    releaseSpendHome ??= acquireOwnedSpendHome();
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay/gpt-6-luna", input: "hi", stream: false }),
    }), { providers: { relay: { ...relay, responsesStreamOnly: true, modelAdapters: { "gpt-6-luna": "openai-chat" } } } } as unknown as OcxConfig,
    { model: "", provider: "" }, { inboundWire: "responses" });
    const json = await response.json() as { output?: Array<{ content?: Array<{ text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number } };
    expect(upstreamUrl).toContain("/chat/completions");
    expect(upstreamStream).toBe(false);
    expect(json.output?.[0]?.content?.[0]?.text).toBe("chat answer");
    expect(json.usage?.input_tokens).toBe(3);
    expect(json.usage?.output_tokens).toBe(2);
  });
  test("a non-streaming client gets JSON folded from the upstream stream", async () => {
    const { response, upstreamStream } = await send({ ...relay, responsesStreamOnly: true });
    expect(upstreamStream).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const json = await response.json() as { status?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    expect(json.status).toBe("completed");
    expect(json.output?.[0]?.content?.[0]?.text).toBe("ok");
  });

  test("an undeclared destination keeps the client's stream:false", async () => {
    const { response, upstreamStream } = await send(relay);
    expect(upstreamStream).toBe(false);
    expect(response.status).toBe(400);
    await response.text();
  });
});
