/**
 * The `/vibe` pass-through lane through the real public HTTP listener against a loopback upstream.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { bindNativeHarnessConfig, VIBE_PROVIDER_ID } from "../../src/lib/native-harness";
import { captureGatherFlight } from "../../src/codex/catalog/gather-capture";
import { keyQuotaReaderForProvider } from "../../src/providers/quota/vendor-probes-key";
import { routeModel } from "../../src/router";
import { runProviderCompletionTest } from "../../src/server/management/provider-completion-test";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import { resetVibePassthroughKeyStateForTests } from "../../src/server/vibe-passthrough-keys";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { managementFetch } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Captured = { method: string; path: string; query: string; headers: Headers; bytes: Uint8Array };
type RawReply = { status: number; headers: Record<string, string | string[] | undefined>; text: string };

const hubKey = `ocx_data_${"v".repeat(40)}`;
const otherKey = `ocx_data_${"o".repeat(40)}`;
const meteredKey = "mistral-metered-key-1";
const vibePoolKeyOne = "vibe-chat-key-one";
const vibePoolKeyTwo = "vibe-chat-key-two";
const vibeUa = "mistral-client-python/Mistral-Vibe/3.1.4";
const httpxUa = "python-httpx2/0.28.1";

const sseBody = [
  'data: {"id":"cmpl-1","choices":[{"delta":{"content":"OK"}}]}\n\n',
  'data: {"id":"cmpl-1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n',
  "data: [DONE]\n\n",
].join("");

describe("vibe pass-through public HTTP lane", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedCodexHome: string | undefined;
  let savedFetch: typeof fetch;
  let release: (() => void) | undefined;
  let proxy: ReturnType<typeof import("../../src/server").startServer> | undefined;
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let calls: Captured[];
  let reply: (captured: Captured) => Response;
  let unexpected: number;

  beforeEach(async () => {
    savedHome = process.env.OPENCODEX_HOME;
    savedCodexHome = process.env.CODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-vibe-passthrough-"));
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    release = acquireOwnedSpendHome();
    calls = [];
    unexpected = 0;
    resetVibePassthroughKeyStateForTests();
    clearRequestLogsForTests();
    reply = captured => {
      if (captured.path === "/v1/chat/completions") {
        return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream", "x-vibe-upstream": "kept" } });
      }
      return new Response(JSON.stringify({ ok: true, path: captured.path, query: captured.query }), {
        status: 200,
        headers: { "content-type": "application/json", "x-vibe-upstream": "kept" },
      });
    };
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const captured = {
          method: req.method,
          path: url.pathname,
          query: url.search,
          headers: req.headers,
          bytes: new Uint8Array(await req.arrayBuffer()),
        };
        calls.push(captured);
        return reply(captured);
      },
    });
    savedFetch = globalThis.fetch;
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === upstream?.url.origin || (proxy && url.origin === `http://127.0.0.1:${proxy.port}`)) {
        return savedFetch(input, init);
      }
      unexpected++;
      throw new Error(`vibe fixture blocked unexpected network: ${url.origin}`);
    }, { preconnect() {} }) as typeof fetch;
  });

  afterEach(async () => {
    try {
      await proxy?.stop(true);
      proxy = undefined;
      await upstream?.stop(true);
      upstream = undefined;
      await drainAndRemoveFixtureRoots({ roots: [], restoreEnvironment() {} });
      expect(unexpected).toBe(0);
    } finally {
      globalThis.fetch = savedFetch;
      bindNativeHarnessConfig(null);
      resetVibePassthroughKeyStateForTests();
      clearRequestLogsForTests();
      release?.();
      release = undefined;
      if (savedHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = savedHome;
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodexHome;
      removeTreeWithRetry(home);
    }
  });

  async function launch(options: { nativeHarnessOnly?: boolean; allowedProviders?: string[] } = {}) {
    const nativeOnly = options.nativeHarnessOnly ?? true;
    const config = {
      port: 0,
      hostname: "0.0.0.0",
      defaultProvider: "mistral",
      nativeHarnessOnly: nativeOnly,
      apiKeys: [
        {
          id: "vibe-key",
          name: "fixture-vibe",
          key: hubKey,
          createdAt: "2026-01-01T00:00:00.000Z",
          ...(options.allowedProviders ? { allowedProviders: options.allowedProviders } : {}),
        },
        {
          id: "other-key",
          name: "fixture-other",
          key: otherKey,
          createdAt: "2026-01-01T00:00:00.000Z",
          allowedProviders: ["anthropic"],
        },
      ],
      providers: {
        mistral: {
          adapter: "openai-chat",
          authMode: "key",
          apiKey: meteredKey,
          baseUrl: "https://api.mistral.ai/v1",
          models: ["mistral-large-latest"],
          liveModels: false,
        },
        "mistral-custom": {
          adapter: "openai-chat",
          authMode: "key",
          apiKey: meteredKey,
          baseUrl: `${upstream!.url.origin}/v1`,
          allowPrivateNetwork: true,
          models: ["mistral-large-latest"],
          liveModels: false,
        },
        [VIBE_PROVIDER_ID]: {
          adapter: "openai-chat",
          authMode: "key",
          apiKey: vibePoolKeyOne,
          apiKeyPool: [
            { id: "vibe-1", key: vibePoolKeyOne, label: "smccd" },
            { id: "vibe-2", key: vibePoolKeyTwo, label: "aventure" },
          ],
          baseUrl: `${upstream!.url.origin}/v1`,
          allowPrivateNetwork: true,
          models: ["devstral-latest"],
          liveModels: false,
        },
      },
      clientIntegrations: { codex: false },
      checkForUpdates: false,
      syncResumeHistory: false,
    } as OcxConfig;
    saveConfig(config);
    bindNativeHarnessConfig(config);
    proxy = (await import("../../src/server")).startServer(0);
  }

  function rawRequest(
    method: "GET" | "POST" | "DELETE" | "OPTIONS",
    path: string,
    options: { body?: string; headers?: Record<string, string | undefined>; key?: string } = {},
  ): Promise<RawReply> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.key ?? hubKey}`,
        "user-agent": vibeUa,
        "x-forwarded-for": "203.0.113.10",
        "x-request-id": "envoy-vibe-test",
        "x-envoy-attempt-count": "1",
        "x-opencodex-internal": "strip-me",
        cookie: "session=strip-me",
      };
      if (method === "POST") headers["content-type"] = "application/json";
      if (options.headers) {
        for (const [k, v] of Object.entries(options.headers)) {
          if (v === undefined) delete headers[k];
          else headers[k] = v;
        }
      }
      const req = request({ host: "127.0.0.1", port: proxy!.port, path, method, headers }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      });
      req.on("error", reject);
      if (options.body !== undefined) req.write(options.body);
      req.end();
    });
  }

  test("forwards all seven allowlisted endpoints byte-for-byte with strict header handling and SSE usage logging", async () => {
    await launch();
    const rawChatBody = String.raw`{"model":"devstral-latest","messages":[{"role":"user","content":"café naïve"}],"future":{"big":9007199254740993},"stream":true}`;
    const chatRes = await rawRequest("POST", "/vibe/v1/chat/completions", {
      body: rawChatBody,
      headers: { "x-affinity": "sess-123", "x-custom-vibe": "preserved" },
    });
    expect(chatRes.status).toBe(200);
    expect(chatRes.text).toBe(sseBody);
    expect(chatRes.headers["x-vibe-upstream"]).toBe("kept");

    expect(calls).toHaveLength(1);
    const first = calls[0]!;
    expect(first.method).toBe("POST");
    expect(first.path).toBe("/v1/chat/completions");
    expect(Buffer.from(first.bytes).toString("utf8")).toBe(rawChatBody);
    expect(first.headers.get("user-agent")).toBe(vibeUa);
    expect(first.headers.get("x-affinity")).toBe("sess-123");
    expect(first.headers.get("x-custom-vibe")).toBe("preserved");
    expect(first.headers.get("x-forwarded-for")).toBeNull();
    expect(first.headers.get("x-request-id")).toBeNull();
    expect(first.headers.get("x-envoy-attempt-count")).toBeNull();
    expect(first.headers.get("x-opencodex-internal")).toBeNull();
    expect(first.headers.get("cookie")).toBeNull();
    const sentAuth = first.headers.get("authorization");
    expect([`Bearer ${vibePoolKeyOne}`, `Bearer ${vibePoolKeyTwo}`]).toContain(sentAuth);
    expect(sentAuth).not.toContain(hubKey);

    const modelsRes = await rawRequest("GET", "/vibe/v1/models");
    expect(modelsRes.status).toBe(200);
    const modelRes = await rawRequest("GET", "/vibe/v1/models/devstral-latest");
    expect(modelRes.status).toBe(200);
    const connectorsRes = await rawRequest("GET", "/vibe/v1/connectors/bootstrap?scope=code", {
      headers: { "user-agent": httpxUa },
    });
    expect(connectorsRes.status).toBe(200);
    const budgetRes = await rawRequest("GET", "/vibe/v1/billing/budget");
    expect(budgetRes.status).toBe(200);
    const meRes = await rawRequest("GET", "/vibe/v1/users/me");
    expect(meRes.status).toBe(200);
    const managedRes = await rawRequest("GET", "/vibe/chat/api/v1/code/managed-config", {
      headers: { "user-agent": httpxUa },
    });
    expect(managedRes.status).toBe(200);

    expect(calls.map(c => `${c.method} ${c.path}${c.query}`)).toEqual([
      "POST /v1/chat/completions",
      "GET /v1/models",
      "GET /v1/models/devstral-latest",
      "GET /v1/connectors/bootstrap?scope=code",
      "GET /v1/billing/budget",
      "GET /v1/users/me",
      "GET /chat/api/v1/code/managed-config",
    ]);

    const logs = getRequestLogEntries();
    const chatLog = logs.find(entry => entry.model === "devstral-latest");
    expect(chatLog).toBeDefined();
    expect(chatLog?.provider).toBe(VIBE_PROVIDER_ID);
    expect(chatLog?.status).toBe(200);
    expect(chatLog?.usage?.inputTokens).toBe(12);
    expect(chatLog?.usage?.outputTokens).toBe(3);
    expect(chatLog?.usage?.totalTokens).toBe(15);
    expect(chatLog?.accountLogLabel).toMatch(/^k[a-f0-9]{32}$/);
  });

  test("rejects unknown paths, wrong methods, path traversal, bad auth, non-Vibe UAs, and disabled nativeHarnessOnly before touching upstream", async () => {
    await launch();

    expect((await rawRequest("GET", "/vibe/v1/unknown")).status).toBe(404);
    expect((await rawRequest("GET", "/vibe/v1/models/..")).status).toBe(404);
    expect((await rawRequest("GET", "/vibe/v1/models/.")).status).toBe(404);
    expect((await rawRequest("GET", "/vibe/v1/%2f/models")).status).toBe(404);
    expect((await rawRequest("GET", "/vibe/v1/models/%00")).status).toBe(404);
    expect((await rawRequest("GET", "/vibe/v1//models")).status).toBe(404);
    expect((await rawRequest("OPTIONS", "/vibe/v1/models", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await rawRequest("OPTIONS", "/vibe/v1/models")).status).toBe(405);
    expect((await rawRequest("GET", "/vibe/v1/models/%2e%2e")).status).toBe(404);
    expect((await rawRequest("GET", "/vibe/v1/models/bad%2fmodel")).status).toBe(404);
    expect((await rawRequest("GET", "/vibe/v1/models/bad\\model")).status).toBe(404);
    expect((await rawRequest("GET", "/vibe/v1/chat/completions")).status).toBe(405);
    expect((await rawRequest("POST", "/vibe/v1/models", { body: "{}" })).status).toBe(405);

    expect((await rawRequest("GET", "/vibe/v1/models", { headers: { authorization: undefined } })).status).toBe(401);
    expect((await rawRequest("GET", "/vibe/v1/models", { key: "ocx_data_invalid" })).status).toBe(401);
    expect((await rawRequest("GET", "/vibe/v1/models", { key: otherKey })).status).toBe(403);

    expect((await rawRequest("POST", "/vibe/v1/chat/completions", {
      body: '{"model":"devstral-latest","messages":[]}',
      headers: { "user-agent": "curl/8.7.1" },
    })).status).toBe(403);
    expect((await rawRequest("POST", "/vibe/v1/chat/completions", {
      body: '{"model":"devstral-latest","messages":[]}',
      headers: { "user-agent": httpxUa },
    })).status).toBe(403);
    expect((await rawRequest("GET", "/vibe/v1/models", {
      headers: { origin: "https://evil.example" },
    })).status).toBe(403);
    expect((await rawRequest("GET", "/vibe/v1/models", {
      headers: { "sec-fetch-site": "cross-site" },
    })).status).toBe(403);
    expect(calls).toHaveLength(0);

    await proxy!.stop(true);
    await launch({ nativeHarnessOnly: false });
    expect((await rawRequest("GET", "/vibe/v1/models")).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test("refuses translated /v1/chat/completions and /v1/responses targeting mistral-vibe while keeping metered mistral active", async () => {
    await launch();
    reply = () => new Response(JSON.stringify({
      id: "chat-ok",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "metered ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const refusedChat = await rawRequest("POST", "/v1/chat/completions", {
      body: JSON.stringify({ model: "mistral-vibe/devstral-latest", messages: [{ role: "user", content: "hi" }] }),
      headers: { "user-agent": "OpenAI/JS" },
    });
    expect(refusedChat.status).toBe(400);
    expect(refusedChat.text).toContain("Mistral Vibe accounts serve only the native Vibe harness through /vibe");
    expect(calls).toHaveLength(0);

    const refusedResponses = await rawRequest("POST", "/v1/responses", {
      body: JSON.stringify({ model: "mistral-vibe/devstral-latest", input: "hi" }),
      headers: { "user-agent": "OpenAI/JS" },
    });
    expect(refusedResponses.status).toBe(400);
    expect(refusedResponses.text).toContain("Mistral Vibe accounts serve only the native Vibe harness through /vibe");
    expect(calls).toHaveLength(0);

    const meteredChat = await rawRequest("POST", "/v1/chat/completions", {
      body: JSON.stringify({ model: "mistral-custom/mistral-large-latest", messages: [{ role: "user", content: "hi" }] }),
      headers: { "user-agent": "OpenAI/JS" },
    });
    expect(meteredChat.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${meteredKey}`);

    const providersRes = await rawRequest("GET", "/api/providers", { key: undefined });
    expect(providersRes.status).toBe(401);

    const authedProvidersRes = await managementFetch(`http://127.0.0.1:${proxy!.port}/api/providers`);
    expect(authedProvidersRes.status).toBe(200);
    const providersPayload = await authedProvidersRes.json() as Array<{ name: string; nativeHarness?: string }>;
    expect(providersPayload.find(p => p.name === VIBE_PROVIDER_ID)?.nativeHarness).toBe("vibe");

    const refusedMessages = await rawRequest("POST", "/v1/messages", {
      body: JSON.stringify({ model: "mistral-vibe/devstral-latest", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      headers: { "anthropic-version": "2023-06-01", "user-agent": "Anthropic/JS" },
    });
    expect(refusedMessages.status).toBe(400);
    expect(refusedMessages.text).toContain("Mistral Vibe accounts serve only the native Vibe harness through /vibe");

    // Disabled/paused mistral-vibe keys must still yield 400 NativeHarnessRefusal rather than 403 paused.
    const pausedVibeConfig = {
      adapter: "openai-chat",
      authMode: "key",
      apiKey: vibePoolKeyOne,
      apiKeyPool: [{ id: "vibe-1", key: vibePoolKeyOne, disabled: true }],
      baseUrl: `${upstream!.url.origin}/v1`,
      allowPrivateNetwork: true,
      models: ["devstral-latest"],
      liveModels: false,
    } as const;
    await proxy!.stop(true);
    const configWithPausedPool = {
      port: 0,
      hostname: "0.0.0.0",
      defaultProvider: "mistral-custom",
      nativeHarnessOnly: true,
      apiKeys: [{ id: "vibe-key", name: "fixture-vibe", key: hubKey, createdAt: "2026-01-01T00:00:00.000Z" }],
      providers: {
        "mistral-custom": {
          adapter: "openai-chat",
          authMode: "key",
          apiKey: meteredKey,
          baseUrl: `${upstream!.url.origin}/v1`,
          allowPrivateNetwork: true,
          models: ["mistral-large-latest"],
          liveModels: false,
        },
        [VIBE_PROVIDER_ID]: pausedVibeConfig,
      },
      clientIntegrations: { codex: false },
      checkForUpdates: false,
      syncResumeHistory: false,
    } as OcxConfig;
    saveConfig(configWithPausedPool);
    bindNativeHarnessConfig(configWithPausedPool);
    proxy = (await import("../../src/server")).startServer(0);

    const refusedPausedChat = await rawRequest("POST", "/v1/chat/completions", {
      body: JSON.stringify({ model: "mistral-vibe/devstral-latest", messages: [{ role: "user", content: "hi" }] }),
      headers: { "user-agent": "OpenAI/JS" },
    });
    expect(refusedPausedChat.status).toBe(400);
    expect(refusedPausedChat.text).toContain("Mistral Vibe accounts serve only the native Vibe harness through /vibe");

    const completionTestResult = await runProviderCompletionTest({
      config: configWithPausedPool,
      name: VIBE_PROVIDER_ID,
      model: "devstral-latest",
    });
    expect(completionTestResult).toEqual({
      applicable: false,
      reason: "unsupported_transport",
      detail: "native_harness_only",
    });

    // Bare routing skips mistral-vibe while keeping metered providers selectable.
    const bareRoute = routeModel(configWithPausedPool, "devstral-latest");
    expect(bareRoute.providerName).not.toBe(VIBE_PROVIDER_ID);

    // Catalog discovery excludes mistral-vibe while keeping metered providers.
    const gather = captureGatherFlight(configWithPausedPool, () => () => ({ auth: { kind: "key", key: "ignored" } }));
    expect(gather.providers.some(entry => entry.provider === VIBE_PROVIDER_ID)).toBe(false);

    // Key quota probe skips mistral-vibe under nativeHarnessOnly while canonical metered mistral remains active.
    expect(keyQuotaReaderForProvider(VIBE_PROVIDER_ID, {
      adapter: "openai-chat",
      authMode: "key",
      apiKey: "k",
      baseUrl: "https://api.mistral.ai/v1",
    })).toBeNull();
    expect(keyQuotaReaderForProvider("mistral", {
      adapter: "openai-chat",
      authMode: "key",
      apiKey: "k",
      baseUrl: "https://api.mistral.ai/v1",
    })).not.toBeNull();
  });
});
