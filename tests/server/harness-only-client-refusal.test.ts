/**
 * A client refused by `nativeHarnessOnly` reads the refusal itself. The translated adapters throw
 * it before any send; the dispatcher used to fold it into a 400 that Chat clients saw only as
 * "The provider rejected the request."
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindNativeHarnessConfig, NativeHarnessRefusal } from "../../src/lib/native-harness";
import { saveCredential } from "../../src/oauth/store";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
let home: string;
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;
let releaseSpend: () => void;

const anthropicRefusal = new NativeHarnessRefusal("anthropic").message;
const antigravityRefusal = new NativeHarnessRefusal("antigravity").message;
const anthropic = { adapter: "anthropic", baseUrl: "https://api.anthropic.com/v1", authMode: "oauth", selectedModels: ["claude-sonnet-5-5"] };
const antigravity = { adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com", googleMode: "cloud-code-assist", selectedModels: ["gemini-3.8-flash"] };
const expires = () => Date.now() + 3_600_000;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-harness-refusal-"));
  process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome("ocx-harness-refusal-codex-");
  releaseSpend = acquireOwnedSpendHome();
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("unexpected network call");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  bindNativeHarnessConfig(null);
  releaseSpend();
  codexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

async function errorMessage(response: Response): Promise<string> {
  return (await response.json() as { error: { message: string } }).error.message;
}

function chat(config: OcxConfig, model: string): Promise<Response> {
  return handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  }), config, { model: "", provider: "" });
}

test("Chat and Responses clients read the nativeHarnessOnly refusal, directly and through a combo", async () => {
  await saveCredential("anthropic", { access: "synthetic-anthropic", refresh: "synthetic-refresh", expires: expires(), accountId: "synthetic-anthropic" });
  await saveCredential("google-antigravity", { access: "synthetic-agy", refresh: "synthetic-refresh", expires: expires(), accountId: "synthetic-agy", projectId: "synthetic-project" });
  const config = {
    port: 0, nativeHarnessOnly: true, defaultProvider: "anthropic",
    providers: { anthropic, "google-antigravity": antigravity },
    combos: { pair: { strategy: "failover", targets: [{ provider: "anthropic", model: "claude-sonnet-5-5" }, { provider: "google-antigravity", model: "gemini-3.8-flash" }] } },
  } as unknown as OcxConfig;
  bindNativeHarnessConfig(config);
  for (const [model, refusal] of [["anthropic/claude-sonnet-5-5", anthropicRefusal], ["google-antigravity/gemini-3.8-flash", antigravityRefusal], ["combo/pair", anthropicRefusal]] as const) {
    const response = await chat(config, model);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(refusal);
    const responses = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model, input: "hi" }),
    }), config, { model: "", provider: "" });
    expect(responses.status).toBe(400);
    expect(await responses.text()).toContain(refusal);
  }
  expect(fetchCalls).toBe(0);
});

test("a Messages client on the managed native lane reads the refusal", async () => {
  await saveCredential("anthropic", { access: "synthetic-anthropic", refresh: "synthetic-refresh", expires: expires(), accountId: "synthetic-anthropic" });
  const config = {
    port: 0, nativeHarnessOnly: true, defaultProvider: "anthropic", providers: { anthropic },
    anthropicAccountPool: { enabled: false },
    protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } },
  } as unknown as OcxConfig;
  bindNativeHarnessConfig(config);
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-sonnet-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  }), config, { model: "", provider: "" });
  expect(response.status).toBe(400);
  expect(await errorMessage(response)).toBe(anthropicRefusal);
  expect(fetchCalls).toBe(0);
});

test("an Antigravity account that has no project yet reads the refusal, not an authentication failure", async () => {
  await saveCredential("google-antigravity", { access: "synthetic-agy", refresh: "synthetic-refresh", expires: expires(), accountId: "synthetic-agy" });
  const config = { port: 0, nativeHarnessOnly: true, defaultProvider: "google-antigravity", providers: { "google-antigravity": antigravity } } as unknown as OcxConfig;
  bindNativeHarnessConfig(config);
  const response = await chat(config, "google-antigravity/gemini-3.8-flash");
  expect(response.status).toBe(400);
  expect(await errorMessage(response)).toBe(antigravityRefusal);
  expect(fetchCalls).toBe(0);
});
