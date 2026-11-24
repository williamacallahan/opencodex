import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { bindSharedCodexWireIdentity } from "../../src/adapters/openai-responses/transport";
import { markDashboardProxyPeer, resolveResponsesApiAuth, type DataPlaneAdmission } from "../../src/server/auth-cors";
import { parseRequest } from "../../src/responses/parser";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
beforeEach(() => { delete process.env.OPENCODEX_API_AUTH_TOKEN; });
afterEach(() => {
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
});

const hubConfig: OcxConfig = {
  port: 0, hostname: "0.0.0.0", defaultProvider: "relay", providers: {},
  apiKeys: [{ id: "launcher-key", name: "launcher", key: "ocx_data_launchersecret", createdAt: "2026-11-24T00:00:00.000Z" }],
};
const codexLb: OcxProviderConfig = {
  adapter: "openai-responses", baseUrl: "https://lb.example/backend-api/codex", apiKey: "relay-key",
  headers: { "x-lgw-client-address": "192.0.2.200" },
};
const chatgptPool: OcxProviderConfig = { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" };

const callerHeaders = {
  "x-opencodex-api-key": "ocx_data_launchersecret",
  "user-agent": "claude-cli/2.1.0 (external, cli)",
  "x-user-id": "claude-oc:session-1",
  "x-lgw-cache-key": "claude-oc:conversation-1",
  "x-lgw-client-host": "laptop-1",
  "x-lgw-client-address": "192.0.2.66",
  "x-forwarded-for": "198.51.100.4",
  "session-id": "caller-session",
  "thread-id": "caller-thread",
  "x-codex-parent-thread-id": "caller-parent",
};

function admitted(): { req: Request; admission: DataPlaneAdmission } {
  const req = new Request("https://hub.example/v1/responses", { method: "POST", headers: callerHeaders });
  markDashboardProxyPeer(req, "127.0.0.1");
  const admission = resolveResponsesApiAuth(req, hubConfig);
  if (!admission?.attribution) throw new Error("expected an attributed admission");
  return { req, admission };
}

async function outbound(provider: OcxProviderConfig, admission: DataPlaneAdmission, req: Request) {
  const adapter = createResponsesPassthroughAdapter(provider);
  bindSharedCodexWireIdentity(adapter, provider, req.headers, admission, "pool");
  const parsed = parseRequest({ model: "m", input: "hi", prompt_cache_key: "caller-cache-key" });
  const budget = createTestTranslatorBudget();
  const request = await adapter.buildRequest(parsed, { headers: new Headers(req.headers), translatorBudget: budget });
  try { return { headers: new Headers(request.headers), body: JSON.parse(request.body) as { prompt_cache_key?: string } }; }
  finally { request.releaseBodyObservation?.(); budget.dispose(); }
}

const ATTRIBUTION_HEADERS = ["x-user-id", "x-lgw-cache-key", "x-lgw-client-host", "x-lgw-client-address"];
const CONTINUITY_HEADERS = ["session_id", "session-id", "thread-id", "x-codex-parent-thread-id"];

describe("caller attribution on the codex-lb relay", () => {
  test("the relay request names the caller, and the hub's observed address replaces any other", async () => {
    const { req, admission } = admitted();
    const { headers } = await outbound(codexLb, admission, req);
    expect(headers.get("user-agent")).toBe("claude-cli/2.1.0 (external, cli)");
    expect(headers.get("x-user-id")).toBe("claude-oc:session-1");
    expect(headers.get("x-lgw-cache-key")).toBe("claude-oc:conversation-1");
    expect(headers.get("x-lgw-client-host")).toBe("laptop-1");
    // Neither the caller's 192.0.2.66 nor the configured 192.0.2.200 survives.
    expect(headers.get("x-lgw-client-address")).toBe("198.51.100.4");
  });

  test("session, thread, and prompt-cache identity are byte-identical with and without attribution", async () => {
    const { req, admission } = admitted();
    const { attribution: _attribution, ...unattributed } = admission;
    const withAttribution = await outbound(codexLb, admission, req);
    const without = await outbound(codexLb, unattributed, req);
    for (const name of CONTINUITY_HEADERS) {
      expect(without.headers.get(name)).toBeTruthy();
      expect(withAttribution.headers.get(name)).toBe(without.headers.get(name));
    }
    expect(withAttribution.body.prompt_cache_key).toBeTruthy();
    expect(withAttribution.body.prompt_cache_key).toBe(without.body.prompt_cache_key);
    // Without attribution the relay request carries only what the provider configures.
    for (const name of ATTRIBUTION_HEADERS.slice(0, 3)) expect(without.headers.has(name)).toBe(false);
    expect(without.headers.get("x-lgw-client-address")).toBe("192.0.2.200");
  });

  test("the hub's own ChatGPT pool receives none of the attribution headers", async () => {
    const { req, admission } = admitted();
    const { headers } = await outbound(chatgptPool, admission, req);
    for (const name of ATTRIBUTION_HEADERS) expect(headers.has(name)).toBe(false);
  });
});
