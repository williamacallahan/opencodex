import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import * as proxyEnv from "../../src/lib/proxy-env";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { startServer } from "../../src/server";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const SESSION = "6f1c2a4e-0b3d-4c5e-8f70-1a2b3c4d5e6f";
const GATEWAY_NAMES = ["x-user-id", "x-lgw-cache-key", "x-lgw-client-host", "x-lgw-client-address"];
const admissionHeaders = { authorization: "Bearer local-admission-fixture", "content-type": "application/json" };
// Each caller also forges its address three ways. The test client connects directly from loopback,
// which is not a configured proxy, so the hub records its own observation (127.0.0.1) instead.
const forgedAddress = { "x-forwarded-for": "198.51.100.4", "x-real-ip": "198.51.100.5", "x-lgw-client-address": "198.51.100.6" };
const declared = {
  "user-agent": "claude-cli/2.1.0 (external, cli)",
  "x-user-id": "claude-oc:session-1", "x-lgw-cache-key": "claude-oc:conversation-1", "x-lgw-client-host": "laptop-1",
  ...forgedAddress,
};
const undeclaredClaudeCode = {
  "user-agent": "claude-cli/2.1.0 (external, cli)", "x-claude-code-session-id": SESSION,
  "x-lgw-client-host": "laptop-1", ...forgedAddress,
};

interface Sent { path: string; headers: Headers; body: string }
let previousHome: string | undefined;
let home: string;
let codex: IsolatedCodexHome;
let proxy: ReturnType<typeof startServer> | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let configuredFetch: ReturnType<typeof spyOn> | undefined;
let sent: Sent[];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-gateway-attribution-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("ocx-gateway-attribution-codex-");
  sent = [];
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    sent.push({ path, headers: new Headers(req.headers), body: await req.text() });
    if (path.endsWith("/messages")) {
      const events = [
        { type: "message_start", message: { id: "msg-fixture", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/chat/completions")) {
      return Response.json({ id: "chatcmpl-fixture", object: "chat.completion", created: 1, model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
      id: "resp-fixture", object: "response", status: "completed", model: "m",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== upstream!.url.origin) throw new Error("Unexpected non-fixture transport");
    return originalFetch(input, { ...init, proxy: false });
  });
  const row = (adapter: "openai-responses" | "openai-chat" | "anthropic", gateway: boolean): OcxProviderConfig => ({
    adapter, authMode: "key", apiKey: "provider-key-fixture", baseUrl: new URL(adapter === "anthropic" ? "/" : "/v1", upstream!.url).href,
    allowPrivateNetwork: true, liveModels: false, models: ["m"],
    ...(gateway ? { forwardClientHeaders: ["x-user-id", "x-lgw-cache-key"] } : {}),
  });
  saveConfig({ port: 0, hostname: "127.0.0.1", codexAutoStart: false, clientIntegrations: { codex: false },
    apiKeys: [{ id: "gateway-fixture", name: "gateway fixture", key: "local-admission-fixture", createdAt: "2026-11-08T00:00:00.000Z" }],
    defaultProvider: "gateway-responses",
    providers: {
      "gateway-responses": row("openai-responses", true), "gateway-chat": row("openai-chat", true),
      "vendor-responses": row("openai-responses", false), "vendor-chat": row("openai-chat", false),
      "metadata-responses": { ...row("openai-responses", false), forwardClientHeaders: ["user-agent", "originator"] },
      "metadata-chat": { ...row("openai-chat", false), forwardClientHeaders: ["user-agent", "originator"] },
      "gateway-anthropic": row("anthropic", true), "vendor-anthropic": row("anthropic", false),
      "metadata-anthropic": { ...row("anthropic", false), forwardClientHeaders: ["user-agent", "originator"] },
    },
  } as OcxConfig);
  proxy = startServer(0);
});

afterEach(async () => {
  await proxy?.stop(true);
  await upstream?.stop(true);
  await flushNativeMainStartupReleases();
  await flushConfigDirHardeningForTests();
  await flushWindowsSecretAclReapsBeforeRemoval(home);
  await flushWindowsSecretAclReapsBeforeRemoval(codex.path);
  configuredFetch?.mockRestore();
  codex.restore();
  removeTreeWithRetry(home);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  proxy = undefined; upstream = undefined;
});

/**
 * The lanes a row can be reached by: Responses pass-through, Responses translated to Chat or to Anthropic, and native Chat.
 * Only the Responses row carries the caller's `prompt_cache_key`; the Chat rows here do not send one at all.
 */
const lanes = [
  { name: "responses pass-through", path: "/v1/responses", provider: "responses", cacheKeyOnWire: true },
  { name: "responses translated to chat", path: "/v1/responses", provider: "chat", cacheKeyOnWire: false },
  { name: "native chat", path: "/v1/chat/completions", provider: "chat", cacheKeyOnWire: false },
  { name: "responses translated to anthropic", path: "/v1/responses", provider: "anthropic", cacheKeyOnWire: false },
] as const;

async function send(lane: typeof lanes[number], kind: "gateway" | "vendor" | "metadata", caller: Record<string, string>): Promise<Sent> {
  const model = `${kind}-${lane.provider}/m`;
  const body = lane.path === "/v1/responses"
    ? { model, input: "attribution fixture", stream: true, prompt_cache_key: "caller-cache-key" }
    : { model, messages: [{ role: "user", content: "attribution fixture" }], prompt_cache_key: "caller-cache-key" };
  const before = sent.length;
  const response = await originalFetch(new URL(lane.path, proxy!.url), {
    method: "POST", proxy: false, headers: { ...admissionHeaders, ...caller }, body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  await response.text();
  expect(sent).toHaveLength(before + 1);
  return sent.at(-1)!;
}

function gatewayHeaders(request: Sent): Record<string, string> {
  return Object.fromEntries(GATEWAY_NAMES.filter(name => request.headers.has(name)).map(name => [name, request.headers.get(name)!]));
}

describe("caller attribution on LLM gateway provider rows", () => {
  for (const lane of lanes) {
    test(`${lane.name}: a declared caller's workload, conversation, machine and address reach the gateway row`, async () => {
      expect(gatewayHeaders(await send(lane, "gateway", declared))).toEqual({
        "x-user-id": "claude-oc:session-1", "x-lgw-cache-key": "claude-oc:conversation-1",
        "x-lgw-client-host": "laptop-1", "x-lgw-client-address": "127.0.0.1",
      });
    });

    test(`${lane.name}: an undeclared Claude Code caller reaches the gateway row as its session`, async () => {
      // No conversation key is invented: a gateway may route prompt caching on X-LGW-Cache-Key.
      expect(gatewayHeaders(await send(lane, "gateway", undeclaredClaudeCode))).toEqual({
        "x-user-id": `claude-code:${SESSION}`, "x-lgw-client-host": "laptop-1", "x-lgw-client-address": "127.0.0.1",
      });
    });

    for (const kind of ["vendor", "metadata"] as const) {
      test(`${lane.name}: a ${kind === "vendor" ? "vendor row" : "row opted in to only user-agent and originator"} receives no caller identity`, async () => {
        for (const caller of [declared, undeclaredClaudeCode]) {
          const request = await send(lane, kind, caller);
          expect(gatewayHeaders(request)).toEqual({});
          expect([...request.headers.keys()].filter(name => name.startsWith("x-lgw-"))).toEqual([]);
          // Not under any name: no outbound header value carries the harness session or a forged address.
          for (const [, headerValue] of request.headers) {
            for (const secret of [SESSION, "claude-oc:session-1", "laptop-1", "198.51.100.4", "198.51.100.5", "198.51.100.6"]) {
              expect(headerValue).not.toContain(secret);
            }
          }
        }
      });
    }

    test(`${lane.name}: the outgoing body, prompt_cache_key included, is byte-identical with and without attribution`, async () => {
      const plain = await send(lane, "gateway", { "user-agent": declared["user-agent"] });
      const attributed = await send(lane, "gateway", declared);
      expect(attributed.body).toBe(plain.body);
      expect(attributed.body.includes("caller-cache-key")).toBe(lane.cacheKeyOnWire);
    });
  }
});
