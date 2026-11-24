/**
 * Resilience, LRU affinity eviction, 429 cooldowns, persistent next-month-UTC 402 parks,
 * and bounded single pre-output retry on /vibe.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { saveConfig } from "../../src/config";
import { bindNativeHarnessConfig, VIBE_PROVIDER_ID } from "../../src/lib/native-harness";
import { clearKeyCooldowns } from "../../src/providers/api-key-cooldowns";
import { clearRequestLogsForTests } from "../../src/server/request-log";
import {
  chooseVibeKey,
  flushVibeKeyCooldownWritesForTests,
  isVibeBudgetExhausted402,
  nextMonthUtcTimestamp,
  parkVibeKeyUntilNextMonthUtc,
  recordVibe429Cooldown,
  rememberVibeAffinity,
  resetVibePassthroughKeyStateForTests,
} from "../../src/server/vibe-passthrough-keys";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const hubKey = `ocx_data_${"r".repeat(40)}`;
const vibeUa = "mistral-client-python/Mistral-Vibe/3.1.4";

describe("vibe pass-through key pool resilience", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedCodexHome: string | undefined;
  let savedFetch: typeof fetch;
  let release: (() => void) | undefined;
  let proxy: ReturnType<typeof import("../../src/server").startServer> | undefined;
  let upstream: ReturnType<typeof Bun.serve> | undefined;

  beforeEach(() => {
    savedHome = process.env.OPENCODEX_HOME;
    savedCodexHome = process.env.CODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-vibe-resilience-"));
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    release = acquireOwnedSpendHome();
    resetVibePassthroughKeyStateForTests();
    clearRequestLogsForTests();
    savedFetch = globalThis.fetch;
  });

  afterEach(async () => {
    try {
      await proxy?.stop(true);
      proxy = undefined;
      await upstream?.stop(true);
      upstream = undefined;
      await drainAndRemoveFixtureRoots({ roots: [], restoreEnvironment() {} });
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

  test("enforces bounded O(1) LRU affinity eviction above 2048 entries", () => {
    resetVibePassthroughKeyStateForTests();
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      authMode: "key",
      baseUrl: "https://api.mistral.ai/v1",
      apiKeyPool: [
        { id: "k1", key: "secret-1" },
        { id: "k2", key: "secret-2" },
      ],
    };
    const now = Date.UTC(2026, 10, 23, 12, 0, 0);
    rememberVibeAffinity("hot-session", "k2", now);
    rememberVibeAffinity("evicted-session", "k2", now + 1);
    for (let i = 0; i < 2046; i++) {
      rememberVibeAffinity(`session-${i}`, "k1", now + 2 + i);
    }
    // Promote hot-session via lookup right before adding 10 more sessions to overflow 2048.
    const hit = chooseVibeKey(provider, "hot-session", undefined, now + 3000);
    expect(hit.kind === "key" && hit.key.id).toBe("k2");

    for (let i = 0; i < 10; i++) {
      rememberVibeAffinity(`overflow-${i}`, "k1", now + 4000 + i);
    }
    // hot-session was promoted and stays pinned to k2; evicted-session was evicted and falls back to round-robin (k1).
    const stillPinned = chooseVibeKey(provider, "hot-session", undefined, now + 5000);
    expect(stillPinned.kind === "key" && stillPinned.key.id).toBe("k2");
    const evictedFallback = chooseVibeKey(provider, "evicted-session", undefined, now + 5001);
    expect(evictedFallback.kind === "key" && evictedFallback.key.id).toBe("k1");
    const nextRoundRobin = chooseVibeKey(provider, "evicted-session", undefined, now + 5002);
    expect(nextRoundRobin.kind === "key" && nextRoundRobin.key.id).toBe("k2");
  });

  test("computes next-month UTC boundary, persists 402 parks across resets, and clears on manual cooldown clear", async () => {
    const midMonth = Date.UTC(2026, 1, 14, 18, 30, 0); // Feb 14, 2026
    expect(nextMonthUtcTimestamp(midMonth)).toBe(Date.UTC(2026, 2, 1, 0, 0, 0));

    expect(isVibeBudgetExhausted402(402, new TextEncoder().encode(JSON.stringify({
      error: { message: "Vibe budget exhausted", code: "billing_vibe_budget_exhausted" },
    })))).toBe(true);
    expect(isVibeBudgetExhausted402(402, new TextEncoder().encode(JSON.stringify({ code: 2304 })))).toBe(true);
    expect(isVibeBudgetExhausted402(402, new TextEncoder().encode(JSON.stringify({ code: "card_declined" })))).toBe(false);

    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      authMode: "key",
      baseUrl: "https://api.mistral.ai/v1",
      apiKeyPool: [
        { id: "k1", key: "secret-1" },
        { id: "k2", key: "secret-2" },
      ],
    };

    const futureParkNow = Date.now();
    parkVibeKeyUntilNextMonthUtc("k1", futureParkNow);
    await flushVibeKeyCooldownWritesForTests();

    const diskPath = join(home, "vibe-key-cooldowns.json");
    expect(existsSync(diskPath)).toBe(true);
    const saved = JSON.parse(readFileSync(diskPath, "utf8")) as { version: number; parks: Record<string, number> };
    expect(saved.version).toBe(1);
    expect(saved.parks.k1).toBe(nextMonthUtcTimestamp(futureParkNow));

    // Simulate process restart by resetting in-memory caches while keeping disk file intact.
    resetVibePassthroughKeyStateForTests();

    for (let i = 0; i < 4; i++) {
      const choice = chooseVibeKey(provider, null, undefined, futureParkNow + 1000);
      expect(choice.kind === "key" && choice.key.id).toBe("k2");
    }

    // Production key management clear removes persisted park from both memory and disk.
    clearKeyCooldowns(VIBE_PROVIDER_ID);
    await flushVibeKeyCooldownWritesForTests();
    const clearedSaved = JSON.parse(readFileSync(diskPath, "utf8")) as { version: number; parks: Record<string, number> };
    expect(clearedSaved.parks).toEqual({});
    const pickedIds = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const choice = chooseVibeKey(provider, null, undefined, futureParkNow + 2000);
      if (choice.kind === "key") pickedIds.add(choice.key.id);
    }
    expect(pickedIds.has("k1")).toBe(true);
  });

  test("clamps 429 cooldowns between 5s and 3600s and fails over once before output on 402/429 without mutating request bytes", async () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      authMode: "key",
      baseUrl: "https://api.mistral.ai/v1",
      apiKeyPool: [{ id: "k1", key: "secret-1" }],
    };
    const t0 = Date.UTC(2026, 10, 23, 12, 0, 0);
    expect(recordVibe429Cooldown("k1", new Headers({ "retry-after": "2" }), t0)).toBe(t0 + 5_000);
    expect(recordVibe429Cooldown("k1", new Headers({ "retry-after": "999999" }), t0)).toBe(t0 + 3_600_000);
    expect(recordVibe429Cooldown("k1", new Headers(), t0)).toBe(t0 + 60_000);

    resetVibePassthroughKeyStateForTests();
    const sentBodies: string[] = [];
    const sentBearers: string[] = [];
    let mode: "fail-first-402" | "all-429" = "fail-first-402";
    let attemptIndex = 0;
    let callsInStorm = 0;
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (mode === "all-429") {
          callsInStorm++;
          await req.arrayBuffer();
          return new Response(JSON.stringify({ error: "rate limit" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "30" },
          });
        }
        attemptIndex++;
        sentBodies.push(await req.text());
        sentBearers.push(req.headers.get("authorization") ?? "");
        if (attemptIndex === 1) {
          return new Response(JSON.stringify({ code: "billing_vibe_budget_exhausted", message: "monthly limit hit" }), {
            status: 402,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ id: "ok", choices: [{ message: { role: "assistant", content: "healthy sibling" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => savedFetch(input, init), {
      preconnect() {},
    }) as typeof fetch;

    const config = {
      port: 0,
      hostname: "0.0.0.0",
      defaultProvider: VIBE_PROVIDER_ID,
      nativeHarnessOnly: true,
      apiKeys: [{ id: "vibe", name: "vibe", key: hubKey, createdAt: "2026-01-01T00:00:00.000Z" }],
      providers: {
        [VIBE_PROVIDER_ID]: {
          adapter: "openai-chat",
          authMode: "key",
          apiKey: "vibe-k1",
          apiKeyPool: [
            { id: "vibe-k1", key: "vibe-k1" },
            { id: "vibe-k2", key: "vibe-k2" },
            { id: "vibe-k3", key: "vibe-k3" },
          ],
          baseUrl: `${upstream.url.origin}/v1`,
          allowPrivateNetwork: true,
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

    const exactPayload = '{"model":"devstral-latest","messages":[{"role":"user","content":"exact bytes"}],"stream":false}';
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: proxy!.port,
        path: "/vibe/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: `Bearer ${hubKey}`,
          "user-agent": vibeUa,
          "content-type": "application/json",
          "x-affinity": "retry-session",
        },
      }, message => {
        let text = "";
        message.setEncoding("utf8");
        message.on("data", chunk => { text += chunk; });
        message.on("end", () => resolve({ status: message.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end(exactPayload);
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).choices[0].message.content).toBe("healthy sibling");
    expect(sentBodies).toEqual([exactPayload, exactPayload]);
    expect(new Set(sentBearers).size).toBe(2);

    // Bounded to at most 1 retry even when multiple sibling keys return 429.
    mode = "all-429";
    callsInStorm = 0;
    const stormRes = await new Promise<{ status: number }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: proxy!.port,
        path: "/vibe/v1/chat/completions",
        method: "POST",
        headers: { authorization: `Bearer ${hubKey}`, "user-agent": vibeUa, "content-type": "application/json" },
      }, message => {
        message.resume();
        message.on("end", () => resolve({ status: message.statusCode ?? 0 }));
      });
      req.on("error", reject);
      req.end(exactPayload);
    });
    expect(stormRes.status).toBe(429);
    expect(callsInStorm).toBe(2);

    // All keys now in cooldown (vibe-k1 parked for month, k2 & k3 cooled down) -> local 429 before any upstream call.
    callsInStorm = 0;
    const exhaustedRes = await new Promise<{ status: number; retryAfter: string | string[] | undefined }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: proxy!.port,
        path: "/vibe/v1/chat/completions",
        method: "POST",
        headers: { authorization: `Bearer ${hubKey}`, "user-agent": vibeUa, "content-type": "application/json" },
      }, message => {
        message.resume();
        message.on("end", () => resolve({ status: message.statusCode ?? 0, retryAfter: message.headers["retry-after"] }));
      });
      req.on("error", reject);
      req.end(exactPayload);
    });
    expect(exhaustedRes.status).toBe(429);
    expect(Number(exhaustedRes.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(callsInStorm).toBe(0);
    await flushVibeKeyCooldownWritesForTests();
  });

  test("handles compressed 402 budget failover, untruncated non-budget 402, 401/drop settlement, and concurrent/oversized SSE streams", async () => {
    resetVibePassthroughKeyStateForTests();
    let scenario: "gzip-budget-402" | "non-budget-402-small" | "non-budget-402-large" | "fail-401" | "sse-utf8-oversize" = "gzip-budget-402";
    let upstreamCalls = 0;
    const largeNonBudgetPayload = JSON.stringify({ error: { code: "payment_required", detail: "p".repeat(80 * 1024) } });

    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        await req.arrayBuffer();
        upstreamCalls++;
        if (scenario === "gzip-budget-402") {
          if (upstreamCalls === 1) {
            return new Response(gzipSync(Buffer.from(JSON.stringify({ type: "billing_vibe_budget_exhausted" }))), {
              status: 402,
              headers: { "content-type": "application/json", "content-encoding": "gzip" },
            });
          }
          return new Response(JSON.stringify({ id: "ok-gzip" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (scenario === "non-budget-402-small") {
          return new Response(JSON.stringify({ code: "card_declined" }), {
            status: 402,
            headers: { "content-type": "application/json" },
          });
        }
        if (scenario === "non-budget-402-large") {
          const bytes = new TextEncoder().encode(largeNonBudgetPayload);
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              for (let off = 0; off < bytes.byteLength; off += 16 * 1024) {
                controller.enqueue(bytes.subarray(off, Math.min(bytes.byteLength, off + 16 * 1024)));
              }
              controller.close();
            },
          });
          return new Response(stream, { status: 402, headers: { "content-type": "application/json" } });
        }
        if (scenario === "fail-401") {
          if (upstreamCalls === 1) return new Response('{"error":"bad key"}', { status: 401 });
          return new Response(JSON.stringify({ id: "ok-401-failover" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        const splitIndex = Buffer.from('data: {"choices":[{"delta":{"content":"🚀').length - 2;
        const sseFirst = Buffer.from('data: {"choices":[{"delta":{"content":"🚀"}}]}\n\n');
        const oversizedLine = `data: {"padding":"${"z".repeat(70_000)}"}\n\n`;
        const usageLine = 'data: {"choices":[],"usage":{"prompt_tokens":19,"completion_tokens":5,"total_tokens":24}}\n\ndata: [DONE]\n\n';
        const isStreamA = req.headers.get("x-stream-role") === "utf8-split";
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            if (isStreamA) {
              controller.enqueue(sseFirst.subarray(0, splitIndex));
              await Bun.sleep(25);
              controller.enqueue(sseFirst.subarray(splitIndex));
              controller.enqueue(Buffer.from(usageLine));
            } else {
              controller.enqueue(Buffer.from(oversizedLine.slice(0, 40_000)));
              await Bun.sleep(10);
              controller.enqueue(Buffer.from(oversizedLine.slice(40_000)));
              controller.enqueue(Buffer.from(usageLine));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => savedFetch(input, init), {
      preconnect() {},
    }) as typeof fetch;

    const config = {
      port: 0,
      hostname: "0.0.0.0",
      defaultProvider: VIBE_PROVIDER_ID,
      nativeHarnessOnly: true,
      apiKeys: [{ id: "vibe", name: "vibe", key: hubKey, createdAt: "2026-01-01T00:00:00.000Z" }],
      providers: {
        [VIBE_PROVIDER_ID]: {
          adapter: "openai-chat",
          authMode: "key",
          apiKey: "vibe-k1",
          apiKeyPool: [
            { id: "vibe-k1", key: "vibe-k1" },
            { id: "vibe-k2", key: "vibe-k2" },
          ],
          baseUrl: `${upstream.url.origin}/v1`,
          allowPrivateNetwork: true,
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

    const postVibe = (extraHeaders: Record<string, string> = {}) => new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: proxy!.port,
        path: "/vibe/v1/chat/completions",
        method: "POST",
        headers: { authorization: `Bearer ${hubKey}`, "user-agent": vibeUa, "content-type": "application/json", ...extraHeaders },
      }, message => {
        let text = "";
        message.setEncoding("utf8");
        message.on("data", chunk => { text += chunk; });
        message.on("end", () => resolve({ status: message.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end('{"model":"devstral-latest","messages":[]}');
    });

    const gzipRes = await postVibe();
    expect(gzipRes.status).toBe(200);
    expect(upstreamCalls).toBe(2);

    clearKeyCooldowns(VIBE_PROVIDER_ID);
    await flushVibeKeyCooldownWritesForTests();

    scenario = "non-budget-402-small";
    upstreamCalls = 0;
    const small402 = await postVibe();
    expect(small402.status).toBe(402);
    expect(JSON.parse(small402.text)).toEqual({ code: "card_declined" });
    expect(upstreamCalls).toBe(1);

    scenario = "non-budget-402-large";
    upstreamCalls = 0;
    const large402 = await postVibe();
    expect(large402.status).toBe(402);
    expect(large402.text).toBe(largeNonBudgetPayload);
    expect(upstreamCalls).toBe(1);

    scenario = "fail-401";
    upstreamCalls = 0;
    const res401 = await postVibe();
    expect(res401.status).toBe(200);
    expect(upstreamCalls).toBe(2);

    clearKeyCooldowns(VIBE_PROVIDER_ID);
    scenario = "sse-utf8-oversize";
    clearRequestLogsForTests();
    const [sseA, sseB] = await Promise.all([
      postVibe({ "x-stream-role": "utf8-split" }),
      postVibe({ "x-stream-role": "oversized-line" }),
    ]);
    expect(sseA.status).toBe(200);
    expect(sseA.text).toContain("🚀");
    expect(sseB.status).toBe(200);
    expect(sseB.text).toContain('"total_tokens":24');

    const logs = (await import("../../src/server/request-log")).getRequestLogEntries();
    expect(logs.length).toBeGreaterThanOrEqual(2);
    for (const entry of logs.slice(-2)) {
      expect(entry.usage?.inputTokens).toBe(19);
      expect(entry.usage?.outputTokens).toBe(5);
      expect(entry.usage?.totalTokens).toBe(24);
    }

    // Raw TCP server that truncates a 402 body mid-stream -> must settle 502 without leaking ActiveTurnLease.
    const dropServer = createNetServer(socket => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{\"partial\":");
        socket.destroy();
      });
    });
    await new Promise<void>(resolve => dropServer.listen(0, "127.0.0.1", () => resolve()));
    const dropPort = (dropServer.address() as { port: number }).port;
    const dropConfig = {
      ...config,
      providers: {
        [VIBE_PROVIDER_ID]: {
          adapter: "openai-chat",
          authMode: "key",
          apiKey: "only-one-key",
          baseUrl: `http://127.0.0.1:${dropPort}/v1`,
          allowPrivateNetwork: true,
          liveModels: false,
        },
      },
    } as OcxConfig;
    await proxy!.stop(true);
    saveConfig(dropConfig);
    bindNativeHarnessConfig(dropConfig);
    proxy = (await import("../../src/server")).startServer(0);

    const dropRes = await postVibe();
    expect(dropRes.status).toBe(502);
    expect((await import("../../src/server/lifecycle")).getActiveTurnCount()).toBe(0);
    await new Promise<void>(resolve => dropServer.close(() => resolve()));
  });
});
