/**
 * `nativeHarnessOnly` refuses hub-built subscription sends at their send sites: nothing reaches
 * the network when the switch is on, and nothing is refused when it is off.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { buildAnthropicMessagesPassthroughRequest } from "../../src/adapters/anthropic/passthrough";
import { bindNativeHarnessConfig, NativeHarnessRefusal } from "../../src/lib/native-harness";
import { runAnthropicWebSearch } from "../../src/web-search/anthropic-executor";
import { runGeminiWebSearch } from "../../src/web-search/gemini-executor";
import { describeImageAnthropic } from "../../src/vision/anthropic-describe";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { captureGatherFlight } from "../../src/codex/catalog/gather-capture";

const originalFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("unexpected network call");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  bindNativeHarnessConfig(null);
});

const oauthProvider: OcxProviderConfig = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  authMode: "oauth",
  apiKey: "fixture-oauth-token",
};

const parsed: OcxParsedRequest = {
  modelId: "claude-haiku-4-5",
  context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
  stream: false,
  options: {},
};

const messagesBody = { model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
const sidecarSettings = { model: "claude-haiku-4-5", reasoning: "low" as const, timeoutMs: 1000 };

describe("nativeHarnessOnly send gates", () => {
  test("the translated Anthropic adapter refuses an OAuth account", async () => {
    bindNativeHarnessConfig({ nativeHarnessOnly: true });
    await expect(createAnthropicAdapter(oauthProvider).buildRequest(parsed)).rejects.toBeInstanceOf(NativeHarnessRefusal);
    expect(fetchCalls).toBe(0);
  });

  test("the translated Anthropic adapter still builds an OAuth request when the switch is off", async () => {
    await expect(createAnthropicAdapter(oauthProvider).buildRequest(parsed)).resolves.toBeDefined();
  });

  test("the managed native Messages builder refuses an OAuth account", () => {
    bindNativeHarnessConfig({ nativeHarnessOnly: true });
    expect(() => buildAnthropicMessagesPassthroughRequest(oauthProvider, "claude-wire", messagesBody))
      .toThrow(NativeHarnessRefusal);
    expect(fetchCalls).toBe(0);
  });

  test("the managed native Messages builder still serves an API key account under the switch", () => {
    bindNativeHarnessConfig({ nativeHarnessOnly: true });
    const keyProvider: OcxProviderConfig = { ...oauthProvider, authMode: "key", apiKey: "fixture-key" };
    expect(buildAnthropicMessagesPassthroughRequest(keyProvider, "claude-wire", messagesBody).body).toContain("claude-wire");
  });

  test("the managed native Messages builder builds an OAuth request when the switch is off", () => {
    expect(buildAnthropicMessagesPassthroughRequest(oauthProvider, "claude-wire", messagesBody).body).toContain("claude-wire");
  });

  test("the Anthropic web-search sidecar returns a refusal without a network call", async () => {
    bindNativeHarnessConfig({ nativeHarnessOnly: true });
    const outcome = await runAnthropicWebSearch("query", "anthropic", oauthProvider, sidecarSettings);
    expect(outcome.error).toContain("nativeHarnessOnly");
    expect(fetchCalls).toBe(0);
  });

  test("the Anthropic image describer returns a refusal without a network call", async () => {
    bindNativeHarnessConfig({ nativeHarnessOnly: true });
    const outcome = await describeImageAnthropic(
      "data:image/png;base64,iVBORw0KGgo=", undefined, "", "anthropic", oauthProvider, sidecarSettings,
    );
    expect(outcome.error).toContain("nativeHarnessOnly");
    expect(fetchCalls).toBe(0);
  });

  test("the Gemini web-search sidecar returns a refusal without a network call", async () => {
    bindNativeHarnessConfig({ nativeHarnessOnly: true });
    const outcome = await runGeminiWebSearch("query", "google-antigravity", oauthProvider, sidecarSettings);
    expect(outcome.error).toContain("nativeHarnessOnly");
    expect(fetchCalls).toBe(0);
  });

  test("the catalog gather leaves a Cloud Code row out instead of failing every provider", () => {
    bindNativeHarnessConfig({ nativeHarnessOnly: true });
    const config = {
      providers: {
        "google-antigravity": { adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com", googleMode: "cloud-code-assist" },
        "fixture-chat": { adapter: "openai-chat", authMode: "key", apiKey: "fixture-key", baseUrl: "https://fixture.invalid/v1" },
      },
    } as unknown as OcxConfig;
    const capture = captureGatherFlight(config, () => ({ kind: "refreshing" }));
    expect(capture.providers.map(provider => provider.name)).toEqual(["fixture-chat"]);
    expect(fetchCalls).toBe(0);
  });
});
