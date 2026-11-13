import { describe, expect, test } from "bun:test";
import { applyCodexLbThreadHeaders, buildResponsesTransport } from "../../src/adapters/openai-responses/transport";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { claudeSessionCacheKey } from "../../src/claude/inbound";
import { parseRequest } from "../../src/responses/parser";
import { agentServingThreadKey } from "../../src/oauth/session-affinity-key";
import type { OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// Regression coverage for the forward-mode baseUrl normalization: the previous implementation
// used `replace(/\/+$/, "")`, which retries candidate end positions when a long slash run is not
// at the end of the string. The replacement is a linear scan, pinned here on the shapes that
// distinguish the two. Provider validation requires an absolute http(s) baseUrl, so empty and
// slash-only values are outside this call's contract and are not exercised here.
const forwardProvider = (baseUrl: string): OcxProviderConfig => ({
  adapter: "openai-responses",
  authMode: "forward",
  baseUrl,
});

const incoming = { headers: new Headers() };

describe("buildResponsesTransport baseUrl normalization", () => {
  test("noncanonical forward baseUrl drops every trailing slash", () => {
    const { url } = buildResponsesTransport(forwardProvider("https://relay.example.test/v1///"), incoming);
    expect(url).toBe("https://relay.example.test/v1/responses");
  });

  test("a single trailing slash is dropped", () => {
    const { url } = buildResponsesTransport(forwardProvider("https://relay.example.test/"), incoming);
    expect(url).toBe("https://relay.example.test/responses");
  });

  test("a baseUrl without a trailing slash is unchanged", () => {
    const { url } = buildResponsesTransport(forwardProvider("https://relay.example.test/v1"), incoming);
    expect(url).toBe("https://relay.example.test/v1/responses");
  });

  test("interior slash runs are preserved", () => {
    const { url } = buildResponsesTransport(forwardProvider("https://relay.example.test//v1//"), incoming);
    expect(url).toBe("https://relay.example.test//v1/responses");
  });

  test("a mid-path slash run does not stall normalization", () => {
    // The input shape that made `/\/+$/` retry: a long slash run that is not at the end.
    // The linear scan treats it like any other URL and preserves it.
    const baseUrl = `https://relay.example.test${"/".repeat(2_000)}v1`;
    const { url } = buildResponsesTransport(forwardProvider(baseUrl), incoming);
    expect(url).toBe(`${baseUrl}/responses`);
  });
});

describe("codex-lb thread headers for Claude Code requests", () => {
  const codexLb: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://lb.example.test/backend-api/codex", apiKey: "k" };
  const plain: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://api.example.test/v1", apiKey: "k" };
  const sessionKey = claudeSessionCacheKey("user_abc_account__session_11111111-1111-1111-1111-111111111111");

  function sent(provider: OcxProviderConfig, claudeAgentId?: string, inbound: Record<string, string> = {}, key: string | null = sessionKey) {
    const parsed = parseRequest({ model: "m", input: "hi", prompt_cache_key: "body-key" });
    if (key) parsed._sessionScopedCacheKey = key;
    if (claudeAgentId !== undefined) parsed._claudeAgentId = claudeAgentId;
    const budget = createTestTranslatorBudget();
    const request = createResponsesPassthroughAdapter(provider)
      .buildRequest(parsed, { headers: new Headers(inbound), translatorBudget: budget });
    try { return { headers: new Headers(request.headers), body: JSON.parse(request.body) }; }
    finally { request.releaseBodyObservation?.(); budget.dispose(); }
  }

  test("main loop, fresh subagent and fork each get their own thread-id under one session_id", () => {
    const main = sent(codexLb);
    const sub = sent(codexLb, "agent-sub");
    const fork = sent(codexLb, "agent-fork");
    expect(main.headers.get("session_id")).toBe(sessionKey);
    expect(main.headers.get("thread-id")).toBe(sessionKey);
    expect(sub.headers.get("session_id")).toBe(sessionKey);
    expect(sub.headers.get("thread-id")).toBe(agentServingThreadKey(sessionKey, "agent-sub"));
    expect(fork.headers.get("thread-id")).toBe(agentServingThreadKey(sessionKey, "agent-fork"));
    expect(new Set([main, sub, fork].map(r => r.headers.get("thread-id"))).size).toBe(3);
    // A fork shares its parent's body key; only the agent id differs, and the body is untouched.
    expect(sub.body.prompt_cache_key).toBe(main.body.prompt_cache_key);
    expect(fork.body.prompt_cache_key).toBe(main.body.prompt_cache_key);
    expect(sub.headers.get("thread-id")).not.toContain("agent-sub");
  });

  test("a non-codex-lb provider gets neither header", () => {
    const { headers } = sent(plain, "agent-sub");
    expect(headers.has("session_id")).toBe(false);
    expect(headers.has("thread-id")).toBe(false);
  });

  test("inbound thread identity is preserved and nothing is added", () => {
    for (const inbound of [{ "thread-id": "t-1" }, { session_id: "s-1" }, { "session-id": "s-1" }, { "x-codex-turn-state": "ts" }]) {
      const { headers } = sent(codexLb, "agent-sub", inbound);
      // The hub forwards no inbound thread header itself; the point is that it adds none of its own.
      expect(headers.get("thread-id")).not.toBe(agentServingThreadKey(sessionKey, "agent-sub"));
      expect(headers.get("session_id")).not.toBe(sessionKey);
    }
  });

  test("no session key means no headers", () => {
    const { headers } = sent(codexLb, "agent-sub", {}, null);
    expect(headers.has("session_id")).toBe(false);
    expect(headers.has("thread-id")).toBe(false);
  });

  test("the helper leaves other headers unchanged", () => {
    const headers: Record<string, string> = { Authorization: "Bearer k" };
    applyCodexLbThreadHeaders(codexLb, headers, new Headers(), { sessionScopedCacheKey: sessionKey });
    expect(headers.Authorization).toBe("Bearer k");
    expect(Object.keys(headers).sort()).toEqual(["Authorization", "session_id", "thread-id"]);
  });
});
