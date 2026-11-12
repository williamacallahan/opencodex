import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyResponsesClientMetadata } from "../../src/adapters/openai-responses/transport";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses/passthrough";
import { providerForwardClientHeadersConfigError } from "../../src/config/provider-validation";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { providerManagementConfigError } from "../../src/server/auth-cors";
import type { OcxProviderConfig } from "../../src/types";

function buildHeaders(provider: OcxProviderConfig, incoming: Record<string, string>): Record<string, string> {
  const budget = createTranslatorBudget();
  try {
    const request = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "test-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: "test-model", input: "hello", stream: true },
    }, {
      headers: new Headers(incoming),
      translatorBudget: budget,
      providerName: "test",
    });
    request.releaseBodyObservation?.();
    return Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
  } finally {
    budget.dispose();
  }
}

describe("openai-responses forwardClientHeaders", () => {
  test("copies only selected caller metadata while provider headers remain authoritative", () => {
    const headers = buildHeaders({
      adapter: "openai-responses",
      baseUrl: "https://example.com/v1",
      authMode: "key",
      apiKey: "provider-key",
      headers: {
        "X-Client-Request-Id": "provider-owned",
        "User-Agent": "provider-agent",
      },
      forwardClientHeaders: [
        "originator",
        "x-client-request-id",
        "x-codex-app-version",
        "user-agent",
      ],
    }, {
      authorization: "Bearer caller-secret",
      originator: "codex_cli_rs",
      "user-agent": "caller-agent",
      "x-client-request-id": "caller-request",
      "x-codex-app-version": "0.159.3",
      "x-not-forwarded": "must-stay-local",
    });

    expect(headers.authorization).toBe("Bearer provider-key");
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers["x-client-request-id"]).toBe("provider-owned");
    expect(headers["x-codex-app-version"]).toBe("0.159.3");

    expect(headers["user-agent"]).toBe("provider-agent");
    expect(headers["x-not-forwarded"]).toBeUndefined();
  });

  test("runtime refuses credential and transport headers even if validation is bypassed", () => {
    const headers = buildHeaders({
      adapter: "openai-responses",
      baseUrl: "https://example.com/v1",
      authMode: "key",
      apiKey: "provider-key",
      forwardClientHeaders: ["authorization", "cookie", "content-type", "x-oai-attestation", "Api-Key", "originator"],
    }, {
      authorization: "Bearer caller-secret",
      cookie: "session=secret",
      "content-type": "text/plain",
      "x-oai-attestation": "attestation-secret",
      "api-key": "caller-azure-secret",
      "x-codex-app-version": "0.159.3",
      originator: "codex_cli_rs",
    });

    expect(headers.authorization).toBe("Bearer provider-key");
    expect(headers.cookie).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-oai-attestation"]).toBeUndefined();
    expect(headers["api-key"]).toBeUndefined();
    expect(headers.originator).toBe("codex_cli_rs");
  });

  test("runtime blocks mixed-case api-key in forward auth mode", () => {
    const headers = buildHeaders({
      adapter: "openai-responses",
      baseUrl: "https://example.com/v1",
      authMode: "forward",
      forwardClientHeaders: ["Api-Key", "originator", "x-codex-app-version"],
    }, {
      "api-key": "caller-azure-secret",
      "x-codex-app-version": "0.159.3",
      originator: "codex_cli_rs",
    });

    expect(headers["api-key"]).toBeUndefined();
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers["x-codex-app-version"]).toBe("0.159.3");
  });

  test("canonical OpenAI provider accepts forwardClientHeaders as an operator overlay", () => {
    const entry = getProviderRegistryEntry("openai");
    expect(entry).toBeDefined();
    const provider = providerConfigSeed(entry!);

    expect(providerManagementConfigError("openai", {
      ...provider,
      codexAccountMode: "direct",
      forwardClientHeaders: ["originator", "x-client-request-id"],
    })).toBeNull();
  });

  test("validation rejects malformed, duplicate, credential, and transport-owned names", () => {
    expect(providerForwardClientHeadersConfigError(["originator", "x-client-request-id"])).toBeNull();
    expect(providerForwardClientHeadersConfigError("originator")).toContain("array");
    expect(providerForwardClientHeadersConfigError(["bad header"])).toContain("valid HTTP header names");
    expect(providerForwardClientHeadersConfigError(["Originator", "originator"])).toContain("must not repeat");
    expect(providerForwardClientHeadersConfigError(["authorization"])).toContain("credential or transport-owned");
    expect(providerForwardClientHeadersConfigError(["Api-Key"])).toContain("credential or transport-owned");
    expect(providerForwardClientHeadersConfigError(["x-custom-client-meta"])).toContain("allowlist");
    expect(providerForwardClientHeadersConfigError(["content-length"])).toContain("credential or transport-owned");
  });
});


test("only supported metadata can cross even when unsafe names are explicitly configured", () => {
  const unsafe = ["X-OpenCodex-Api-Key", "X-Custom-Secret", "Proxy-Authorization", "Set-Cookie", "X-Auth-Token"];
  const headers = buildHeaders({ adapter: "openai-responses", baseUrl: "https://example.com/v1",
    forwardClientHeaders: unsafe,
  }, Object.fromEntries(unsafe.map(name => [name, "private-fixture"])));
  for (const name of unsafe) {
    expect(headers[name.toLowerCase()]).toBeUndefined();
    expect(providerForwardClientHeadersConfigError([name])).not.toBeNull();
  }
});

test("additional metadata forwarding is disabled by default", () => {
  const headers = buildHeaders({ adapter: "openai-responses", baseUrl: "https://example.com/v1" },
    { originator: "codex_cli_rs", "x-codex-app-version": "0.159.3" });
  expect(headers.originator).toBeUndefined();
  expect(headers["x-codex-app-version"]).toBeUndefined();
});

describe("openai-chat forwardClientHeaders carries the session identity to a gateway", () => {
  const gateway: OcxProviderConfig = {
    adapter: "openai-chat", baseUrl: "https://gateway.example.com/v1", authMode: "key", apiKey: "gateway-key",
    forwardClientHeaders: ["x-lgw-cache-key", "x-user-id"],
  };
  function chatHeaders(provider: OcxProviderConfig, incoming: Record<string, string>): Record<string, string> {
    const budget = createTranslatorBudget();
    try {
      const request = createOpenAIChatAdapter(provider).buildRequest({
        modelId: "m", context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, stream: true, options: {},
      }, { headers: new Headers(incoming), translatorBudget: budget, providerName: "llm-gateway" });
      request.releaseBodyObservation?.();
      return Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
    } finally { budget.dispose(); }
  }
  test("forwards the per-session cache key and user id, never the caller's credential", () => {
    const headers = chatHeaders(gateway, {
      authorization: "Bearer caller-secret", "x-lgw-cache-key": "claude-av:abc", "x-user-id": "claude-av:abc", "x-other": "stay",
    });
    expect(headers["x-lgw-cache-key"]).toBe("claude-av:abc");
    expect(headers["x-user-id"]).toBe("claude-av:abc");
    expect(headers.authorization).toBe("Bearer gateway-key");
    expect(headers["x-other"]).toBeUndefined();
  });
  test("drops a gateway identity that is not a hub launcher's", () => {
    const headers = chatHeaders(gateway, { "x-lgw-cache-key": "someone-else:session", "x-user-id": "admin" });
    expect(headers["x-lgw-cache-key"]).toBeUndefined();
    expect(headers["x-user-id"]).toBeUndefined();
    expect(chatHeaders(gateway, { "x-user-id": "claude-code:codeAgent", "x-lgw-cache-key": "pi-av:019e-abc" })["x-user-id"])
      .toBe("claude-code:codeAgent");
  });
  test("the compact handoff applies the same identity rule", () => {
    const target = new Headers();
    copyResponsesClientMetadata(target, new Headers({ "x-user-id": "admin", "x-lgw-cache-key": "claude-av:abc" }), gateway);
    expect(target.get("x-user-id")).toBeNull();
    expect(target.get("x-lgw-cache-key")).toBe("claude-av:abc");
  });
  test("forwards nothing unless the provider opts in, and the provider's own header wins", () => {
    const { forwardClientHeaders: _optedIn, ...closed } = gateway;
    expect(chatHeaders(closed, { "x-lgw-cache-key": "k", "x-user-id": "u" })["x-lgw-cache-key"]).toBeUndefined();
    expect(chatHeaders({ ...gateway, headers: { "X-User-ID": "provider-owned" } }, { "x-user-id": "u" })["x-user-id"]).toBe("provider-owned");
  });
  test("validation accepts the two gateway identity headers", () => {
    expect(providerForwardClientHeadersConfigError(["x-lgw-cache-key", "x-user-id"])).toBeNull();
  });
});

describe("every route into an openai-chat gateway provider carries the session identity", () => {
  const { handleChatCompletions } = require("../../src/server/chat-completions") as typeof import("../../src/server/chat-completions");
  const { handleResponses } = require("../../src/server/responses") as typeof import("../../src/server/responses");
  const { handleClaudeMessages } = require("../../src/server/claude-messages") as typeof import("../../src/server/claude-messages");
  const { acquireOwnedSpendHome } = require("../helpers/owned-spend-home") as typeof import("../helpers/owned-spend-home");
  const originalFetch = globalThis.fetch;
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const { removeTreeWithRetry } = require("../helpers/remove-tree") as typeof import("../helpers/remove-tree");
  let home: string; let previousHome: string | undefined; let release: (() => void) | undefined;
  const config = { defaultProvider: "gw", providers: { gw: {
    adapter: "openai-chat", authMode: "key", apiKey: "gateway-key", baseUrl: "https://gw.example.com/v1", models: ["m"],
    forwardClientHeaders: ["x-lgw-cache-key", "x-user-id"] } } } as unknown as OcxConfig;
  let seen: Headers[];
  const reply = () => Response.json({ id: "c1", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME; home = mkdtempSync(join(tmpdir(), "ocx-chat-fwd-"));
    process.env.OPENCODEX_HOME = home; release = acquireOwnedSpendHome(); seen = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { seen.push(new Headers(init?.headers)); return reply(); }) as typeof fetch;
  });
  afterEach(() => {
    release?.(); globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });
  const identity = { "x-lgw-cache-key": "claude-av:probe-1", "x-user-id": "claude-av:probe-1" };
  function request(path: string, body: unknown, extra: Record<string, string> = identity): Request {
    return new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...extra } });
  }
  function expectForwarded(): void {
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get("x-lgw-cache-key")).toBe("claude-av:probe-1");
    expect(seen[0]!.get("x-user-id")).toBe("claude-av:probe-1");
  }
  const routes: Array<[string, (extra?: Record<string, string>) => Promise<Response>]> = [
    ["native chat passthrough", extra => handleChatCompletions(request("/v1/chat/completions",
      { model: "gw/m", messages: [{ role: "user", content: "hi" }], stream: false }, extra), config, { model: "", provider: "" })],
    ["responses translated to chat", extra => handleResponses(request("/v1/responses",
      { model: "gw/m", input: "hi", stream: false }, extra), config, { model: "", provider: "" })],
    ["messages bridged to chat", extra => handleClaudeMessages(request("/v1/messages",
      { model: "gw/m", max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream: false }, extra), config, { model: "", provider: "" })],
    ["hybrid routed ocx-claude id", extra => handleClaudeMessages(request("/hybrid/v1/messages",
      { model: "ocx-claude-gw--m", max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream: false }, extra),
      config, { model: "", provider: "" }, undefined, config, { hybridMessages: true })],
  ];
  for (const [name, send] of routes) {
    test(`${name} forwards the launcher identity and drops a foreign one`, async () => {
      await (await send()).text();
      expectForwarded();
      seen = [];
      await (await send({ "x-user-id": "admin", "x-lgw-cache-key": "someone:else" })).text();
      expect(seen[0]!.get("x-user-id")).toBeNull();
    });
  }
});
