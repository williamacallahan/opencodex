/**
 * Regression coverage for the Claude Code thought-signature replay scope:
 *
 * Claude Code speaks Anthropic Messages and does not send Codex's
 * `x-codex-parent-thread-id`. The server must still create a reasoning-replay
 * scope for a real per-session `prompt_cache_key` (derived from
 * `metadata.user_id`) so Gemini/Antigravity thought signatures can be remembered
 * by call_id. The shared Desktop `prompt_cache_key` cohort must NOT get a scope.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { agentServingThreadKey } from "../../src/oauth/session-affinity-key";
import { clearReasoningReplayCacheForTests, commitReasoningReplayServingIdentity } from "../../src/responses/reasoning-replay-cache";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const actualResolver = await import("../../src/server/adapter-resolve");
// Capture the real function before the override. `mock.module` rewrites the namespace's live
// binding in place, so a lookup through `actualResolver` inside the wrapper would reach
// whichever override is current, including this one, once another file in the same process
// has mocked this module too.
const actualResolveAdapter = actualResolver.resolveAdapter;

let adapterFactory: ((provider: OcxProviderConfig) => ProviderAdapter) | undefined;

mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    return adapterFactory?.(provider) ?? actualResolveAdapter(provider, cacheRetention);
  },
}));

const { handleResponses } = await import("../../src/server/responses");
let releaseSpendHome: (() => void) | undefined;

// Direct physical dispatch needs the writer lease to prevent spend-ledger ownership failures.
const takeSpendHome = (): void => { releaseSpendHome ??= acquireOwnedSpendHome(); };

afterEach(() => {
  // Release first so a failed dispatch cannot leak ownership into the next case.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  adapterFactory = undefined;
  clearReasoningReplayCacheForTests();
});

function captureAdapter(captured: OcxParsedRequest[]): ProviderAdapter {
  return {
    name: "capture-replay-scope",
    buildRequest: () => ({ url: "https://capture.test", method: "POST", headers: {}, body: "{}" }),
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "done" };
    },
    async runTurn(parsed: OcxParsedRequest, _incoming, emit) {
      captured.push(parsed);
      emit({ type: "done" });
    },
  };
}

function testConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "a",
    providers: {
      a: {
        adapter: "openai-chat",
        baseUrl: "https://capture.test",
        authMode: "key",
        apiKey: "capture-key",
        models: ["m1", "m2"],
      },
    },
  } as OcxConfig;
}

async function drive(options: {
  promptCacheKey?: string;
  promptCacheKeyIsSharedCohort?: boolean;
  sessionScopedCacheKey?: string;
  claudeAgentId?: string;
  model?: string;
  reasoning?: boolean;
}): Promise<OcxParsedRequest> {
  const captured: OcxParsedRequest[] = [];
  adapterFactory = () => captureAdapter(captured);
  const body: Record<string, unknown> = {
    model: options.model ?? "m1",
    stream: true,
    input: [
      ...(options.reasoning ? [{ type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] }] : []),
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ],
  };
  if (options.promptCacheKey !== undefined) body.prompt_cache_key = options.promptCacheKey;

  takeSpendHome();
  const response = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    testConfig(),
    { model: "", provider: "" },
    {
      inboundWire: "anthropic",
      ...(options.promptCacheKeyIsSharedCohort === undefined
        ? {}
        : { promptCacheKeyIsSharedCohort: options.promptCacheKeyIsSharedCohort }),
      ...(options.sessionScopedCacheKey === undefined ? {} : { sessionScopedCacheKey: options.sessionScopedCacheKey }),
      ...(options.claudeAgentId === undefined ? {} : { claudeAgentId: options.claudeAgentId }),
    },
  );
  await response.text();
  expect(captured.length).toBe(1);
  return captured[0]!;
}

describe("Claude Code Anthropic inbound reasoning-replay scope", () => {
  test("a real per-session prompt_cache_key creates a call_id replay scope", async () => {
    const parsed = await drive({ promptCacheKey: "session-key-123", promptCacheKeyIsSharedCohort: false });
    expect(parsed._clientThreadId).toBeUndefined();
    expect(parsed._reasoningReplayScope?.clientThreadId).toBe("session-key-123");
    expect(parsed._promptCacheKeyIsSharedCohort).toBe(false);
  });

  test("a subagent's replay scope is its session's, so a fork finds its parent's thought signatures", async () => {
    const parsed = await drive({
      promptCacheKey: "per-agent-key", promptCacheKeyIsSharedCohort: false, sessionScopedCacheKey: "session-key-123",
      claudeAgentId: "agent-a",
    });
    expect(parsed._reasoningReplayScope?.clientThreadId).toBe("session-key-123");
    expect(parsed._reasoningReplayScope?.servingThreadId).toBe(agentServingThreadKey("session-key-123", "agent-a"));
    const main = await drive({
      promptCacheKey: "session-key-123", promptCacheKeyIsSharedCohort: false, sessionScopedCacheKey: "session-key-123",
    });
    expect(main._reasoningReplayScope?.servingThreadId).toBe("session-key-123");
  });

  test("interleaved subagents keep their route while a fork changing models strips reasoning", async () => {
    const shared = { sessionScopedCacheKey: "session-key-123", promptCacheKeyIsSharedCohort: false, reasoning: true };
    const first = await drive({ ...shared, promptCacheKey: "agent-a", claudeAgentId: "agent-a", model: "m1" });
    expect(first._reasoningReplayScope?.current?.credentialDurableIdentity).toBeDefined();
    commitReasoningReplayServingIdentity(first._reasoningReplayScope);
    const sibling = await drive({ ...shared, promptCacheKey: "agent-b", claudeAgentId: "agent-b", model: "m2" });
    commitReasoningReplayServingIdentity(sibling._reasoningReplayScope);
    const resumed = await drive({ ...shared, promptCacheKey: "agent-a", claudeAgentId: "agent-a", model: "m1" });
    expect(resumed._reasoningReplayScope?.clientThreadId).toBe("session-key-123");
    expect(resumed._stripReasoningEncryptedContent).not.toBe(true);
    const fork = await drive({ ...shared, promptCacheKey: "agent-a", claudeAgentId: "agent-a", model: "m2" });
    expect(fork._stripReasoningEncryptedContent).toBe(true);
  });

  test("a recognized fork on another route records its own route and the parent keeps its reasoning", async () => {
    // The fork replays its parent's body prompt_cache_key but sends its own agent id.
    const shared = {
      sessionScopedCacheKey: "session-key-123", promptCacheKeyIsSharedCohort: false, reasoning: true,
      promptCacheKey: "parent-key",
    };
    const parent = await drive({ ...shared, claudeAgentId: "parent", model: "m1" });
    commitReasoningReplayServingIdentity(parent._reasoningReplayScope);
    const fork = await drive({ ...shared, claudeAgentId: "fork", model: "m2" });
    expect(fork._reasoningReplayScope?.servingThreadId).not.toBe(parent._reasoningReplayScope?.servingThreadId);
    commitReasoningReplayServingIdentity(fork._reasoningReplayScope);
    const resumed = await drive({ ...shared, claudeAgentId: "parent", model: "m1" });
    expect(resumed._stripReasoningEncryptedContent).not.toBe(true);
  });

  test("the shared Desktop prompt_cache_key cohort does not create a scope", async () => {
    const parsed = await drive({ promptCacheKey: "shared-cohort-key", promptCacheKeyIsSharedCohort: true });
    expect(parsed._reasoningReplayScope).toBeUndefined();
    expect(parsed._promptCacheKeyIsSharedCohort).toBe(true);
  });

  test("an Anthropic replay without prompt_cache_key does not create a scope", async () => {
    const parsed = await drive({});
    expect(parsed._reasoningReplayScope).toBeUndefined();
    expect(parsed._promptCacheKeyIsSharedCohort).toBeUndefined();
  });

  test("an overlong prompt_cache_key is hashed, not stored raw", async () => {
    const overlong = "k".repeat(200);
    const parsed = await drive({ promptCacheKey: overlong, promptCacheKeyIsSharedCohort: false });
    const scope = parsed._reasoningReplayScope?.clientThreadId;
    expect(scope).toBeDefined();
    expect(scope).not.toBe(overlong);
    expect(scope!.length).toBeLessThanOrEqual(128);
  });

  test("a whitespace-only prompt_cache_key does not create a scope", async () => {
    const parsed = await drive({ promptCacheKey: "   ", promptCacheKeyIsSharedCohort: false });
    expect(parsed._reasoningReplayScope).toBeUndefined();
  });

  test("distinct session identities remain distinct and bounded", async () => {
    const first = await drive({ promptCacheKey: "session-a", promptCacheKeyIsSharedCohort: false });
    const second = await drive({ promptCacheKey: "session-b", promptCacheKeyIsSharedCohort: false });
    const a = first._reasoningReplayScope?.clientThreadId;
    const b = second._reasoningReplayScope?.clientThreadId;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(a).toBe("session-a");
    expect(b).toBe("session-b");
  });
});
