/**
 * A client refused by `nativeHarnessOnly` reads the refusal itself. The translated adapters throw
 * it before any send; the dispatcher used to fold it into a 400 that Chat clients saw only as
 * "The provider rejected the request."
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindNativeHarnessConfig } from "../../src/lib/native-harness";
import { saveCredential } from "../../src/oauth/store";
import { handleChatCompletions } from "../../src/server/chat-completions";
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

beforeEach(async () => {
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
  const expires = Date.now() + 3_600_000;
  await saveCredential("anthropic", { access: "synthetic-anthropic", refresh: "synthetic-refresh", expires, accountId: "synthetic-anthropic" });
  await saveCredential("google-antigravity", { access: "synthetic-agy", refresh: "synthetic-refresh", expires, accountId: "synthetic-agy", projectId: "synthetic-project" });
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

test("Chat and Responses clients read the nativeHarnessOnly refusal, directly and through a combo", async () => {
  const config = {
    port: 0, nativeHarnessOnly: true, defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com/v1", authMode: "oauth", selectedModels: ["claude-sonnet-5-5"] },
      "google-antigravity": { adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com", googleMode: "cloud-code-assist", selectedModels: ["gemini-3.8-flash"] },
    },
    combos: { pair: { strategy: "failover", targets: [{ provider: "anthropic", model: "claude-sonnet-5-5" }, { provider: "google-antigravity", model: "gemini-3.8-flash" }] } },
  } as unknown as OcxConfig;
  bindNativeHarnessConfig(config);
  for (const [model, harness] of [["anthropic/claude-sonnet-5-5", "only Claude Code"], ["google-antigravity/gemini-3.8-flash", "only the agy harness"], ["combo/pair", "only Claude Code"]] as const) {
    const chat = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    }), config, { model: "", provider: "" });
    const chatBody = await chat.text();
    expect(chat.status).toBe(400);
    expect(chatBody).toContain(harness);
    expect(chatBody).toContain("nativeHarnessOnly is on");
    const responses = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model, input: "hi" }),
    }), config, { model: "", provider: "" });
    expect(responses.status).toBe(400);
    expect(await responses.text()).toContain(harness);
  }
  expect(fetchCalls).toBe(0);
});
