import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindNativeHarnessConfig, NativeHarnessRefusal } from "../../src/lib/native-harness";
import { saveCredential } from "../../src/oauth/store";
import { handleChatCompletions } from "../../src/server/chat-completions";
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
  home = mkdtempSync(join(tmpdir(), "ocx-sidecar-refusal-"));
  process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome("ocx-sidecar-refusal-codex-");
  releaseSpend = acquireOwnedSpendHome();
  fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls++; throw new Error("unexpected network call"); }) as unknown as typeof fetch;
  await saveCredential("anthropic", { access: "synthetic-anthropic", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000, accountId: "synthetic-anthropic" });
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

for (const sidecar of ["search", "video"] as const) {
  test(`Chat exposes the native harness refusal through the ${sidecar} sidecar`, async () => {
    const config = {
      port: 0, nativeHarnessOnly: true, defaultProvider: "anthropic",
      providers: {
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com/v1", authMode: "oauth", selectedModels: ["claude-sonnet-5-5"] },
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "synthetic-key" },
      },
      webSearchSidecar: { backend: "exa", exaApiKey: "synthetic-key" },
      images: { videoBridgeEnabled: sidecar === "video" },
    } as unknown as OcxConfig;
    bindNativeHarnessConfig(config);
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", body: JSON.stringify({
        model: "anthropic/claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }],
        ...(sidecar === "search" ? { tools: [{ type: "web_search" }] } : {}),
      }),
    }), config, { model: "", provider: "" });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toBe(new NativeHarnessRefusal("anthropic").message);
    expect(fetchCalls).toBe(0);
  });
}
