import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
import { isPlainObject } from "../../src/lib/plain-data";
import { resolveResponsesApiAuth, contextPrincipalIdOf } from "../../src/server/auth-cors";
import { resolveClaudeBridgePoolSession } from "../../src/server/claude-bridge-pool-session";
import { recallComboTargetForLane } from "../../src/server/responses/combo-session-recall";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { resetTurnStateHandlesForTests } from "../../src/server/turn-state-handles";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const inspectNativeCodexOwnership = ownedServiceHomeInspection("turn-state handle e2e fixture");

/**
 * End to end: the proxy obtains a turn-state token from a (mock) ChatGPT Codex WebSocket upstream,
 * hands the client a handle, and maps the handle back when the same client sends it on its next
 * request, over HTTP and over WebSocket. Only the upstream socket is faked; the server, its
 * admission, routing and the client's own sockets are real.
 */

type Listener = (event: unknown) => void;
const sentFrames: Array<Record<string, unknown>> = [];

/** The Codex backend receives input as a message list, even when the client sends a string. */
function turnInputText(frame: Record<string, unknown>): string | undefined {
  const message: unknown = Array.isArray(frame.input) ? frame.input[0] : undefined;
  if (!isPlainObject(message) || message.type !== "message" || message.role !== "user" || !Array.isArray(message.content)) return;
  const block: unknown = message.content[0];
  if (isPlainObject(block) && block.type === "input_text" && typeof block.text === "string") return block.text;
}

class FakeCodexSocket {
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(_url: string, _options?: unknown) {
    queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); });
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }
  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>;
    sentFrames.push(frame);
    const id = `resp_${sentFrames.length}`;
    queueMicrotask(() => {
      const text = turnInputText(frame);
      this.emit("message", { data: JSON.stringify({ type: "codex.response.metadata",
        headers: text === undefined ? {} : { "x-codex-turn-state": `upstream-turn-${text}` },
      }) });
      this.emit("message", { data: JSON.stringify({ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } }) });
      this.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id, object: "response", model: frame.model, status: "completed", output: [] } }) });
    });
  }
  close() { this.readyState = 3; }
  terminate() { this.readyState = 3; }
  ref() {}
  unref() {}
}

const RealWebSocket = globalThis.WebSocket;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
const savedEnv: Record<string, string | undefined> = {};
let home = "";

const KEYS = { a: "ocx_data_turn_state_caller_a", b: "ocx_data_turn_state_caller_b" } as const;
const bearer = `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "turn-state-fixture", exp: Math.floor(Date.now() / 1000) + 3600 })}`;

beforeEach(() => {
  for (const key of [...PROXY_ENV_KEYS, "OPENCODEX_HOME"]) savedEnv[key] = process.env[key];
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), "ocx-turn-state-e2e-"));
  process.env.OPENCODEX_HOME = home;
  sentFrames.length = 0;
  resetTurnStateHandlesForTests();
  // Only the ChatGPT Codex upstream socket is faked; the test's own client sockets are real.
  globalThis.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args) {
      return String(args[0]).startsWith("wss://chatgpt.com/") ? new FakeCodexSocket(String(args[0]), args[1]) : Reflect.construct(target, args);
    },
  });
  saveFixtureConfig();
});

/** A loopback proxy admits every local caller as one session; a public bind admits each key as its own caller. */
function saveFixtureConfig(hostname?: string): void {
  saveConfig({
    port: 0, defaultProvider: "openai", websockets: true, ...(hostname ? { hostname } : {}),
    apiKeys: [
      { id: "caller-a", name: "caller a", key: KEYS.a, createdAt: "2026-11-03T00:00:00.000Z" },
      { id: "caller-b", name: "caller b", key: KEYS.b, createdAt: "2026-11-03T00:00:00.000Z" },
    ],
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
  } as unknown as OcxConfig);
}

afterEach(() => {
  globalThis.WebSocket = RealWebSocket;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(home);
});

/** One HTTP turn; returns the turn-state value the client received. */
async function httpTurn(server: { url: URL }, caller: keyof typeof KEYS, input: string, turnState?: string,
  { expectedStatus = 200, threadId, model = "gpt-5.5" }: { expectedStatus?: number; threadId?: string; model?: string } = {}): Promise<string | null> {
  const response = await fetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: {
      "content-type": "application/json", authorization: bearer, "x-opencodex-api-key": KEYS[caller],
      ...(turnState ? { "x-codex-turn-state": turnState } : {}), ...(threadId ? { "thread-id": threadId, "session-id": threadId } : {}),
    },
    body: JSON.stringify({ model, input, stream: true }),
  });
  const text = await response.text();
  expect(response.status).toBe(expectedStatus);
  if (expectedStatus === 200) expect(text).toContain("response.completed");
  return response.headers.get("x-codex-turn-state");
}

/** One WebSocket turn per frame on a single connection; returns the handle each metadata frame carried. */
async function wsTurns(server: { url: URL }, caller: keyof typeof KEYS, turns: Array<{ input: string; turnState?: string }>): Promise<Array<string | undefined>> {
  const ws = new WebSocket(new URL("/v1/responses", server.url).href.replace(/^http/, "ws"), {
    headers: { authorization: bearer, "x-opencodex-api-key": KEYS[caller] },
  } as unknown as string[]);
  const handles: Array<string | undefined> = [];
  let resolveTurn: (() => void) | undefined;
  let current: string | undefined;
  ws.onmessage = event => {
    const frame = JSON.parse(String(event.data)) as { type?: string; headers?: Record<string, string> };
    if (frame.type === "codex.response.metadata") current = frame.headers?.["x-codex-turn-state"];
    if (frame.type === "response.completed") { handles.push(current); current = undefined; resolveTurn?.(); }
  };
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("websocket error")); });
  for (const turn of turns) {
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no terminal frame")), 10_000);
      resolveTurn = () => { clearTimeout(timer); resolve(); };
    });
    ws.send(JSON.stringify({ type: "response.create", model: "gpt-5.5", input: turn.input,
      ...(turn.turnState ? { client_metadata: { "x-codex-turn-state": turn.turnState } } : {}) }));
    await done;
  }
  ws.close();
  return handles;
}

const forwardedTurnState = (index: number) => (sentFrames[index]?.client_metadata as Record<string, unknown> | undefined)?.["x-codex-turn-state"];

describe("a turn-state handle obtained from an upstream response is redeemed on the next request", () => {
  test("HTTP: the handle in the response header maps back to the upstream token", async () => {
    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      const handle = await httpTurn(server, "a", "first");
      // Non-vacuous: the upstream answered and the client received a handle, not the token.
      expect(sentFrames).toHaveLength(1);
      expect(handle).toMatch(/^ocx-ts-[0-9a-f]{32}$/);
      expect(handle).not.toContain("upstream-turn");
      await httpTurn(server, "a", "second", handle!);
      expect(sentFrames).toHaveLength(2);
      expect(forwardedTurnState(1)).toBe("upstream-turn-first");
    } finally { await server.stop(true); }
  });

  test.each([true, false])("reopening affinity keeps the serving identity and its handles (store available at startup: %s)", async durable => {
    saveFixtureConfig("0.0.0.0");
    const config = loadConfig();
    config.combos = { pair: { targets: [{ provider: "openai", model: "gpt-5.5" }] } };
    saveConfig(config);
    const path = join(home, "codex-affinity.sqlite");
    if (!durable) mkdirSync(path);
    const server = startServer(0, { inspectNativeCodexOwnership });
    const threadId = "fixture-thread";
    const headers = new Headers({ "x-opencodex-api-key": KEYS.a, "thread-id": threadId, "session-id": threadId });
    const req = new Request(new URL("/v1/responses", server.url), { headers });
    const identity = () => {
      const admission = resolveResponsesApiAuth(req, config)!;
      const principal = contextPrincipalIdOf(admission);
      const transcript = resolveClaudeBridgePoolSession({ ingress: headers, replay: headers, admission });
      expect(!!principal && !!transcript).toBe(true);
      return { principal, transcript };
    };
    try {
      const before = identity();
      await httpTurn(server, "a", "pin", undefined, { threadId, model: "combo/pair" });
      if (!durable) rmdirSync(path);
      const missingHome = spyOn(realpathSync, "native").mockImplementation(() => { throw new Error("fixture home unavailable"); });
      try { codexPoolAffinityKey(headers); } finally { missingHome.mockRestore(); }
      const gap = identity();
      // Admission happens before this turn's affinity lookup reopens the store.
      const handle = await httpTurn(server, "a", "gap", undefined, { threadId });
      expect(handle).toMatch(/^ocx-ts-[0-9a-f]{32}$/);
      await httpTurn(server, "a", "redeem", handle!, { threadId });
      expect(forwardedTurnState(2)).toBe("upstream-turn-gap");
      const reopened = identity();
      expect(gap.principal === before.principal && reopened.principal === before.principal).toBe(true);
      expect(gap.transcript === before.transcript && reopened.transcript === before.transcript).toBe(true);
      expect(recallComboTargetForLane(config, reopened.transcript, "pair")).toEqual({ provider: "openai", model: "gpt-5.5" });
    } finally { await server.stop(true); }
    const native = new Database(path, { readonly: true });
    try { expect(native.query("SELECT value FROM meta WHERE name='clean'").get()).toEqual({ value: 1 }); }
    finally { native.close(); }
    expect(existsSync(join(home, "codex-combo-affinity.sqlite"))).toBe(durable);
  });

  test("a native-issued handle reaches neither carrier on a keyed relay send", async () => {
    const config = loadConfig();
    const baseUrl = "https://relay.example.test/backend-api/codex";
    config.providers.relay = { adapter: "openai-responses", authMode: "key", baseUrl, apiKey: "fixture-relay-key", models: ["m"], liveModels: false };
    saveConfig(config);
    const originalFetch = globalThis.fetch;
    const sends: { stateHeader: string | null; stateInBody: boolean; session: string | null; thread: string | null }[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input) !== `${baseUrl}/v1/responses`) return originalFetch(input, init);
      const request = new Request(input, init);
      const body: { client_metadata?: { [name: string]: string } } = await request.json();
      sends.push({ stateHeader: request.headers.get("x-codex-turn-state"), stateInBody: Object.hasOwn(body.client_metadata ?? {}, "x-codex-turn-state"),
        session: request.headers.get("session_id"), thread: request.headers.get("thread-id") });
      return Response.json({ id: "resp_relay", object: "response", model: "m", status: "completed", output: [] });
    }, { preconnect() {} });
    try {
      const server = startServer(0, { inspectNativeCodexOwnership });
      try {
        const handle = await httpTurn(server, "a", "native");
        expect(handle).toMatch(/^ocx-ts-[0-9a-f]{32}$/);
        const response = await fetch(new URL("/v1/responses", server.url), { method: "POST",
          headers: { "content-type": "application/json", "x-opencodex-api-key": KEYS.a, "session-id": "session-a", "thread-id": "thread-a", "x-codex-turn-state": handle! },
          body: JSON.stringify({ model: "relay/m", input: "next", stream: false, client_metadata: { "x-codex-turn-state": handle } }),
        });
        expect(response.status, await response.text()).toBe(200);
        expect(sends).toEqual([{ stateHeader: null, stateInBody: false, session: "session-a", thread: "thread-a" }]);
      } finally { await server.stop(true); }
    } finally { globalThis.fetch = originalFetch; }
  });

  test("WebSocket: the handle in the relayed metadata frame maps back to the upstream token", async () => {
    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      const [first] = await wsTurns(server, "a", [{ input: "first" }]);
      expect(sentFrames).toHaveLength(1);
      expect(first).toMatch(/^ocx-ts-[0-9a-f]{32}$/);
      await wsTurns(server, "a", [{ input: "second", turnState: first }]);
      expect(sentFrames).toHaveLength(2);
      expect(forwardedTurnState(1)).toBe("upstream-turn-first");
    } finally { await server.stop(true); }
  });

  test.each(["separate keys", "same key id", "same key id in direct mode"])("two principals redeem only their own handles: %s", async setup => {
    // API keys admit as distinct callers only where admission is required, which a public bind makes it.
    saveFixtureConfig("0.0.0.0");
    const direct = setup === "same key id in direct mode";
    if (setup !== "separate keys") {
      const config = loadConfig();
      if (direct) config.providers.openai!.codexAccountMode = "direct";
      const current = config.apiKeys![0]!;
      config.apiKeys = [{ ...current, pendingRotation: { id: "fixture-pending", key: KEYS.b,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } }];
      saveConfig(config);
    }
    const server = startServer(0, { inspectNativeCodexOwnership });

    try {
      const [handleA, handleB] = await Promise.all([httpTurn(server, "a", "turn-a"), httpTurn(server, "b", "turn-b")]);
      expect(sentFrames).toHaveLength(2);
      expect(handleA).toMatch(/^ocx-ts-[0-9a-f]{32}$/);
      expect(handleB).toMatch(/^ocx-ts-[0-9a-f]{32}$/);
      expect(handleA).not.toBe(handleB);
      // Concurrently: each caller redeems its own handle, and caller b presents caller a's handle too.
      await Promise.all([
        httpTurn(server, "a", "next-a", handleA!),
        httpTurn(server, "b", "next-b", handleB!),
        httpTurn(server, "b", "foreign-handle", handleA!, { expectedStatus: direct ? 200 : 409 }),
      ]);
      expect(sentFrames).toHaveLength(direct ? 5 : 4);
      const byInput = new Map(sentFrames.map(frame => [turnInputText(frame), (frame.client_metadata as Record<string, unknown> | undefined)?.["x-codex-turn-state"]]));
      expect(byInput.get("next-a")).toBe("upstream-turn-turn-a");
      expect(byInput.get("next-b")).toBe("upstream-turn-turn-b");
      expect(byInput.has("foreign-handle")).toBe(direct);
      expect(byInput.get("foreign-handle")).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });
});
