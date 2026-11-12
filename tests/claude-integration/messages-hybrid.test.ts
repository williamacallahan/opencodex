/** Hybrid Messages against the same real HTTP and synthetic OAuth boundaries as strict. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum } from "../../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential, setActiveAccount, setAccountPaused } from "../../src/oauth/store";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { MAX_ACTIVE_SESSION_LANES, tryAdmitTurn, type ActiveTurnLease } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Captured = { path: string; query: string; headers: Headers; bytes: Uint8Array };
const encode = (text: string) => new TextEncoder().encode(text);
const nativeModel = "claude-sonnet-4-5";
const routedModel = "ocx-claude-gpt-pool--gpt-fixture";
const hubKey = `ocx_data_${"h".repeat(40)}`;
const poolToken = "synthetic-hybrid-pool-access-1";
const bridgePoolKey = "bridge-pool-key";
const callerBearer = "Bearer sk-ant-hybrid-caller";
const query = "?beta=true&future=a%2Fb&future=a+b";
const raw = String.raw`{
 "model":"claude-sonnet-4-5", "max_tokens":64, "stream":false,
 "messages":[{"role":"user","content":"café and escaped \u0061"}],
 "future":{"n":9007199254740993,"exp":1e+02,"negativeZero":-0,"dup":1,"dup":2}
}`;
const nativeReply = '{ "id":"msg_hybrid", "type":"message", "role":"assistant", "model":"claude-sonnet-4-5", "content":[{"type":"text","text":"native reply"}], "stop_reason":"end_turn", "usage":{"input_tokens":9,"output_tokens":4} }';

describe("hybrid Messages public HTTP transport", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedClaudeHome: string | undefined;
  let savedCodexHome: string | undefined;
  let savedFetch: typeof fetch;
  let releaseSpendHome: (() => void) | undefined;
  let proxy: ReturnType<typeof import("../../src/server").startServer> | undefined;
  let anthropic: ReturnType<typeof Bun.serve> | undefined;
  let bridge: ReturnType<typeof Bun.serve> | undefined;
  let nativeCalls: Captured[];
  let bridgeCalls: Captured[];
  let unexpectedFetches: number;

  beforeEach(async () => {
    savedHome = process.env.OPENCODEX_HOME;
    savedClaudeHome = process.env.CLAUDE_CONFIG_DIR;
    savedCodexHome = process.env.CODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-messages-hybrid-"));
    process.env.OPENCODEX_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    process.env.CODEX_HOME = join(home, "codex");
    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: "synthetic-unused-cli-access", refreshToken: "synthetic-unused-cli-refresh", expiresAt: Date.now() + 3_600_000,
    } }));
    nativeCalls = []; bridgeCalls = []; unexpectedFetches = 0;
    clearAnthropicAccountPoolState();
    forgetAnthropicFailoverQuorum();
    releaseSpendHome = acquireOwnedSpendHome();
    for (let index = 0; index < 2; index++) await saveCredential("anthropic", {
      access: `synthetic-hybrid-pool-access-${index}`, refresh: `synthetic-hybrid-pool-refresh-${index}`,
      expires: Date.now() + 3_600_000, accountId: `synthetic-hybrid-account-${index}`, source: "oauth",
    });
    const accounts = getAccountSet("anthropic")!.accounts;
    await setActiveAccount("anthropic", accounts[1]!.id);
    await setAccountPaused("anthropic", accounts[0]!.id, true);
    forgetAnthropicFailoverQuorum();
    savedFetch = globalThis.fetch;
    const permitted = (url: URL) => url.origin === anthropic?.url.origin || url.origin === bridge?.url.origin
      || (proxy && url.origin === `http://127.0.0.1:${proxy.port}`);
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (permitted(url)) return savedFetch(input, init);
      if (anthropic && url.origin === "https://api.anthropic.com"
        && ["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)) {
        return savedFetch(new URL(url.pathname + url.search, anthropic.url), init);
      }
      unexpectedFetches++;
      throw new Error("hybrid fixture blocked unexpected network");
    }, { preconnect(input: Parameters<typeof fetch.preconnect>[0]) {
      const url = new URL(String(input));
      if (permitted(url) || url.origin === "https://api.anthropic.com") return;
      unexpectedFetches++;
      throw new Error("hybrid fixture blocked unexpected preconnect");
    } }) as typeof fetch;
  });

  afterEach(async () => {
    try {
      await proxy?.stop(true); proxy = undefined;
      await anthropic?.stop(true); anthropic = undefined;
      await bridge?.stop(true); bridge = undefined;
      await drainAndRemoveFixtureRoots({ roots: [], restoreEnvironment() {} });
      expect(unexpectedFetches).toBe(0);
    } finally {
      globalThis.fetch = savedFetch;
      clearAnthropicAccountPoolState();
      forgetAnthropicFailoverQuorum();
      releaseSpendHome?.(); releaseSpendHome = undefined;
      if (savedHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = savedHome;
      if (savedClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedClaudeHome;
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodexHome;
      removeTreeWithRetry(home);
    }
  });

  async function launch(strictPassthrough = false, configure?: (config: OcxConfig) => void) {
    const capture = async (req: Request): Promise<Captured> => ({
      path: new URL(req.url).pathname, query: new URL(req.url).search,
      headers: req.headers, bytes: new Uint8Array(await req.arrayBuffer()),
    });
    anthropic = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const captured = await capture(req);
      nativeCalls.push(captured);
      return new Response(captured.path.endsWith("count_tokens") ? '{ "input_tokens":731, "future":-0 }' : nativeReply,
        { headers: { "content-type": "application/json", "request-id": "req_hybrid_native" } });
    } });
    bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      bridgeCalls.push(await capture(req));
      const frames = [
        `data: ${JSON.stringify({ id: "chatcmpl_fixture", model: "gpt-fixture", choices: [{ index: 0, delta: { role: "assistant", content: "bridge reply" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    const config: OcxConfig = {
      port: 0, hostname: "0.0.0.0", defaultProvider: "anthropic", anthropicAccountPool: { enabled: true },
      apiKeys: [{ id: "hybrid", name: "fixture-hybrid", key: hubKey, createdAt: "2026-01-01T00:00:00.000Z" }],
      providers: {
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", models: [nativeModel], liveModels: false },
        "gpt-pool": { adapter: "openai-chat", baseUrl: `${bridge.url.origin}/v1`, authMode: "key", apiKey: bridgePoolKey,
          allowPrivateNetwork: true, models: ["gpt-fixture", "vendor/gpt-fixture"], liveModels: false },
      },
      protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } },
      clientIntegrations: { codex: false }, checkForUpdates: false, syncResumeHistory: false,
      claudeCode: { strictPassthrough, intercept: { enabled: false } },
    };
    configure?.(config);
    saveConfig(config);
    proxy = (await import("../../src/server")).startServer(0);
  }

  function post(path = "/hybrid/v1/messages", bytes = encode(raw), headers: Record<string, string> = {}) {
    return fetch(new URL(path + query, `http://127.0.0.1:${proxy!.port}`), { method: "POST", body: bytes, decompress: false,
      headers: { "content-type": "application/json", "x-opencodex-api-key": hubKey, authorization: callerBearer,
        "anthropic-version": "2099-01-01", "anthropic-beta": "future-beta-2099", "x-session-id": "hybrid-fixture-session",
        "x-future-client": "opaque", ...headers } });
  }

  for (const gzip of [false, true]) test(`native bytes, forwarded headers and pool auth match strict (gzip=${gzip})`, async () => {
    await launch();
    const bytes = gzip ? Bun.gzipSync(encode(raw)) : encode(raw);
    const headers = gzip ? { "content-encoding": "gzip" } : {};
    for (const prefix of ["/strict", "/hybrid"]) {
      const response = await post(`${prefix}/v1/messages`, bytes, headers);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(nativeReply);
      expect(response.headers.get("request-id")).toBe("req_hybrid_native");
      expect(response.headers.has("x-opencodex-request-id")).toBe(false);
    }
    expect(nativeCalls).toHaveLength(2);
    expect(bridgeCalls).toHaveLength(0);
    for (const captured of nativeCalls) {
      expect(captured.bytes).toEqual(bytes);
      expect(captured.path).toBe("/v1/messages");
      expect(captured.query).toBe(query);
      expect(captured.headers.get("authorization")).toBe(`Bearer ${poolToken}`);
      expect(captured.headers.has("session_id")).toBe(false);
      expect(captured.headers.has("x-opencodex-api-key")).toBe(false);
    }
    expect([...nativeCalls[1]!.headers]).toEqual([...nativeCalls[0]!.headers]);
  });

  test("root path still serves a routed id", async () => {
    await launch();
    const bytes = encode(raw.replace(nativeModel, routedModel));
    const root = await post("/v1/messages", bytes);
    expect(root.status).toBe(200);
    expect(await root.json()).toMatchObject({ content: [{ type: "text", text: "bridge reply" }] });
    expect(bridgeCalls).toHaveLength(1);
    expect(nativeCalls).toHaveLength(0);
  });

  for (const alias of [routedModel, "ocx-claude2-gpt-pool--vendor~sgpt-fixture"]) {
    test(`routed alias uses translation and excludes caller bearer: ${alias}`, async () => {
      await launch(true);
      const response = await post("/hybrid/v1/messages", encode(raw.replace(nativeModel, alias)));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "bridge reply" }] });
      expect(response.headers.get("request-id")).not.toBe("req_hybrid_native");
      expect(bridgeCalls).toHaveLength(1);
      expect(nativeCalls).toHaveLength(0);
      const captured = bridgeCalls[0]!;
      const translated = JSON.parse(new TextDecoder().decode(captured.bytes));
      expect(captured.path).toBe("/v1/chat/completions");
      expect(translated.stream).toBe(true);
      expect(translated.model).toBe(alias === routedModel ? "gpt-fixture" : "vendor/gpt-fixture");
      expect(translated.messages.some((message: { role: string; content: string }) => message.role === "user" && message.content.includes("café"))).toBe(true);
      expect(captured.headers.get("authorization")).toBe(`Bearer ${bridgePoolKey}`);
      expect(JSON.stringify({ path: captured.path, query: captured.query, headers: [...captured.headers], translated })).not.toContain(callerBearer);
      expect(response.headers.get("x-opencodex-request-id")).toBeTruthy();
    });
  }

  test("bridge upstream headers match the same request on the root path", async () => {
    await launch();
    const bytes = encode(raw.replace(nativeModel, routedModel));
    for (const prefix of ["", "/hybrid"]) {
      const response = await post(`${prefix}/v1/messages`, bytes);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-opencodex-request-id")).toBeTruthy();
      await response.arrayBuffer();
    }
    expect(bridgeCalls).toHaveLength(2);
    expect([...bridgeCalls[1]!.headers]).toEqual([...bridgeCalls[0]!.headers]);
    expect(nativeCalls).toHaveLength(0);
  });

  test("an sk-ant caller bearer cannot select caller-credential passthrough for a native id", async () => {
    await launch();
    const response = await post();
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(nativeCalls).toHaveLength(1);
    expect(nativeCalls[0]!.headers.get("authorization")).toBe(`Bearer ${poolToken}`);
    expect(nativeCalls[0]!.bytes).toEqual(encode(raw));
    expect(bridgeCalls).toHaveLength(0);
  });

  for (const model of ["ocx-claude-anthropic--claude-sonnet-4-5", "bare-unknown-model"]) {
    for (const endpoint of ["messages", "messages/count_tokens"]) test(`${endpoint} refuses ${model} before any upstream call`, async () => {
      await launch();
      const response = await post(`/hybrid/v1/${endpoint}`, encode(raw.replace(nativeModel, model)));
      expect(response.status).toBe(400);
      const refusal = await response.json();
      expect(refusal).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
      expect(refusal.error.message).toContain(model);
      expect(refusal.error.message).toContain("native Claude ids");
      expect(refusal.error.message).toContain("ocx-claude-");
      expect(nativeCalls).toHaveLength(0);
      expect(bridgeCalls).toHaveLength(0);
    });
  }

  test("a routed selector stays authoritative over an embedded Anthropic route directive", async () => {
    await launch();
    const body = { model: routedModel, max_tokens: 64, stream: false,
      system: "<!-- ocx-route: anthropic/claude-sonnet-4-5 -->", messages: [{ role: "user", content: "hello" }] };
    const response = await post("/hybrid/v1/messages", encode(JSON.stringify(body)));
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(nativeCalls).toHaveLength(0);
    expect(bridgeCalls).toHaveLength(1);
  });

  test("bridge admission honors session capacity while native transport keeps strict admission", async () => {
    await launch();
    const leases: ActiveTurnLease[] = [];
    try {
      for (let index = 0; index < MAX_ACTIVE_SESSION_LANES; index++) {
        const lease = tryAdmitTurn(`hybrid-capacity-${index}`);
        expect(lease).not.toBeNull();
        leases.push(lease!);
      }
      for (const prefix of ["/strict", "/hybrid"]) {
        const native = await post(`${prefix}/v1/messages`);
        expect(native.status).toBe(200);
        await native.arrayBuffer();
      }
      const bytes = encode(raw.replace(nativeModel, routedModel));
      for (const prefix of ["", "/hybrid"]) {
        const blocked = await post(`${prefix}/v1/messages`, bytes);
        expect(blocked.status).toBe(503);
        await blocked.arrayBuffer();
      }
      expect(bridgeCalls).toHaveLength(0);
      leases.pop()!.release();
      const admitted = await post("/hybrid/v1/messages", bytes);
      expect(admitted.status).toBe(200);
      await admitted.arrayBuffer();
      expect(bridgeCalls).toHaveLength(1);
    } finally { for (const lease of leases) lease.release(); }
  });

  test("bridge admission promotes a parent-only marker before claiming its lane", async () => {
    await launch();
    const bytes = encode(raw.replace(nativeModel, routedModel));
    const response = await post("/hybrid/v1/messages", bytes, { "x-codex-parent-thread-id": "hybrid-parent" });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(bridgeCalls).toHaveLength(1);
    expect(nativeCalls).toHaveLength(0);
  });

  test("cancelling the hybrid body read returns 499", async () => {
    await launch();
    const controller = new AbortController();
    const request = new Request(`http://127.0.0.1:${proxy!.port}/hybrid/v1/messages`, {
      method: "POST", signal: controller.signal,
      body: new ReadableStream<Uint8Array>({ pull() { controller.abort(new Error("fixture caller cancelled")); } }),
    });
    const response = await handleClaudeMessages(request, loadConfig(), { model: "unknown", provider: "unknown" },
      undefined, undefined, { hybridMessages: true });
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error: { message: "Client cancelled request" } });
    expect(nativeCalls).toHaveLength(0);
    expect(bridgeCalls).toHaveLength(0);
  });

  test("hybrid previews do not advance a round-robin combo", async () => {
    await launch(false, config => { config.combos = { hybrid: { strategy: "round-robin", targets: [
      { provider: "gpt-pool", model: "gpt-fixture" }, { provider: "gpt-pool", model: "vendor/gpt-fixture" },
    ] } }; });
    for (let index = 0; index < 2; index++) {
      const response = await post("/hybrid/v1/messages", encode(raw.replace(nativeModel, "ocx-claude-combo--hybrid")));
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    expect(bridgeCalls.map(call => JSON.parse(new TextDecoder().decode(call.bytes)).model)).toEqual(["gpt-fixture", "vendor/gpt-fixture"]);
    expect(nativeCalls).toHaveLength(0);
  });

  test("hybrid refuses a combo that could later choose an Anthropic subscription", async () => {
    await launch(false, config => { config.combos = { hybrid: { strategy: "round-robin", targets: [
      { provider: "gpt-pool", model: "gpt-fixture" }, { provider: "anthropic", model: nativeModel },
    ] } }; });
    const response = await post("/hybrid/v1/messages", encode(raw.replace(nativeModel, "ocx-claude-combo--hybrid")));
    expect(response.status).toBe(400);
    await response.arrayBuffer();
    expect(nativeCalls).toHaveLength(0);
    expect(bridgeCalls).toHaveLength(0);
  });

  test("native count_tokens forwards exact bytes and query", async () => {
    await launch();
    const bytes = Bun.gzipSync(encode(raw));
    const response = await post("/hybrid/v1/messages/count_tokens", bytes, { "content-encoding": "gzip" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{ "input_tokens":731, "future":-0 }');
    expect(nativeCalls).toHaveLength(1);
    expect(nativeCalls[0]!.path).toBe("/v1/messages/count_tokens");
    expect(nativeCalls[0]!.query).toBe(query);
    expect(nativeCalls[0]!.bytes).toEqual(bytes);
    expect(nativeCalls[0]!.headers.get("authorization")).toBe(`Bearer ${poolToken}`);
    expect(bridgeCalls).toHaveLength(0);
  });

  test("routed count_tokens matches the root estimate without any upstream call", async () => {
    await launch();
    const bytes = encode(raw.replace(nativeModel, routedModel));
    const hybrid = await post("/hybrid/v1/messages/count_tokens", bytes);
    const root = await post("/v1/messages/count_tokens", bytes);
    expect(hybrid.status).toBe(200);
    expect(root.status).toBe(200);
    const estimate = await hybrid.json();
    expect(estimate.input_tokens).toBeGreaterThan(0);
    expect(estimate).toEqual(await root.json());
    expect(nativeCalls).toHaveLength(0);
    expect(bridgeCalls).toHaveLength(0);
  });
});
