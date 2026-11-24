import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { JEV_MODEL_INSTRUCTIONS } from "../../src/combos/jev-model-backend";
import * as proxyEnv from "../../src/lib/proxy-env";
import { markDashboardProxyPeer, resolveResponsesApiAuth } from "../../src/server/auth-cors";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { handleResponses } from "../../src/server/responses";
import { createJevModelInvoker } from "../../src/server/responses/jev-model-invoke";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const originalFetch = globalThis.fetch;
const SESSION = "6f1c2a4e-0b3d-4c5e-8f70-1a2b3c4d5e6f";
let home: TempHome;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let configuredFetch: ReturnType<typeof spyOn> | undefined;
let received: Headers[];

beforeEach(() => {
  home = createTempHome("ocx-decision-attribution-");
  resetLifecycleDrainStateForTests();
  received = [];
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    received.push(new Headers(req.headers));
    const body = await req.json() as { stream?: boolean };
    const choice = { index: 0, message: { role: "assistant", content: '{"choice":"gw/m:low"}' }, finish_reason: "stop" };
    if (!body.stream) {
      return Response.json({ id: "chatcmpl-fixture", object: "chat.completion", created: 1, model: "judge", choices: [choice],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    const frames = [
      { id: "chatcmpl-fixture", model: "judge", choices: [{ index: 0, delta: { role: "assistant", content: choice.message.content } }] },
      { id: "chatcmpl-fixture", model: "judge", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    return new Response(`${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== upstream!.url.origin) throw new Error("Unexpected non-fixture transport");
    return originalFetch(input, { ...init, proxy: false });
  });
});

afterEach(async () => {
  configuredFetch?.mockRestore();
  await upstream?.stop(true);
  upstream = undefined;
  home.remove();
});

test("a decision call made under an admitted caller reaches a gateway row as the hub's own call", async () => {
  const config: OcxConfig = { port: 0, hostname: "127.0.0.1", defaultProvider: "gw", providers: { gw: {
    adapter: "openai-chat", baseUrl: new URL("/v1", upstream!.url).href, apiKey: "provider-key-fixture",
    allowPrivateNetwork: true, liveModels: false, models: ["judge", "m"], forwardClientHeaders: ["x-user-id", "x-lgw-cache-key"],
  } } };
  const parent = new Request("http://127.0.0.1:10100/v1/responses", { method: "POST", headers: {
    "user-agent": "claude-cli/2.1.0 (external, cli)", "x-claude-code-session-id": SESSION,
    "x-lgw-cache-key": "claude-oc:conversation-1", "x-lgw-client-host": "laptop-1",
  } });
  markDashboardProxyPeer(parent, "192.0.2.10");
  const admission = resolveResponsesApiAuth(parent, config);
  if (!admission?.attribution) throw new Error("expected an attributed parent admission");
  expect(admission.attribution).toMatchObject({ workload: `claude-code:${SESSION}`, clientHost: "laptop-1" });

  const invoke = createJevModelInvoker({ req: parent, config, options: { admission }, handleResponses });
  await invoke({ model: "gw/judge", instructions: JEV_MODEL_INSTRUCTIONS, input: "fixture decision", signal: new AbortController().signal });

  expect(received).toHaveLength(1);
  const headers = received[0]!;
  expect(headers.get("x-user-id")).toBe("opencodex:hub-internal");
  for (const name of ["x-lgw-cache-key", "x-lgw-client-host", "x-lgw-client-address"]) expect(headers.has(name)).toBe(false);
  for (const [, headerValue] of headers) expect(headerValue).not.toContain(SESSION);
});
