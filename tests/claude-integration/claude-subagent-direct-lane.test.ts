/**
 * A Claude Code subagent's own prompt_cache_key must survive both Messages translations the
 * Antigravity direct lane can take: the direct plan's settings translation and the full bridge
 * translation. Either call dropping the agent id would give every subagent its session's key.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import { saveCredential } from "../../src/oauth/store";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const actualResolver = await import("../../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;
let adapterFactory: ((provider: OcxProviderConfig) => ProviderAdapter) | undefined;
mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    return adapterFactory?.(provider) ?? actualResolveAdapter(provider, cacheRetention);
  },
}));
const { handleClaudeMessages } = await import("../../src/server/claude-messages");

const userId = "user_abc123_account__session_11111111-2222-3333-4444-555555555555";
// Independent SHA-256 vectors (python hashlib): sha256(sha256(user_id) + ":agent:" + agentId)[:32].
const MAIN_KEY = "ded3519449f6b3132a5908b61cafe21f";
const SUBAGENT_KEY = "40dfe2ab195caa9b78ba1a0f8412bf3c";
const AGENT_ID = "a1b2c3d4e5f60718";
let testDir = "", previousHome: string | undefined, isolated: IsolatedCodexHome | null = null, releaseSpendHome: (() => void) | undefined;
let captured: OcxParsedRequest[];

beforeEach(async () => {
  clearGenericFailoverHealth();
  previousHome = process.env.OPENCODEX_HOME;
  isolated = installIsolatedCodexHome("ocx-subagent-direct-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-subagent-direct-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  await saveCredential("google-antigravity", { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000,
    accountId: "antigravity-fixture-account", projectId: "fixture-project", source: "oauth" });
  captured = [];
  adapterFactory = () => ({
    name: "capture-subagent-key",
    buildRequest: () => ({ url: "https://capture.test", method: "POST", headers: {}, body: "{}" }),
    async *parseStream(): AsyncGenerator<AdapterEvent> { yield { type: "done" }; },
    async runTurn(parsed: OcxParsedRequest, _incoming, emit) { captured.push(parsed); emit({ type: "done" }); },
  });
});
afterEach(() => {
  adapterFactory = undefined;
  releaseSpendHome?.(); releaseSpendHome = undefined;
  clearGenericFailoverHealth();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  isolated?.restore(); isolated = null;
  if (testDir) removeTreeWithRetry(testDir);
});

function antigravityConfig(direct: boolean): OcxConfig {
  return { port: 0, hostname: "127.0.0.1", defaultProvider: "google-antigravity",
    providers: { "google-antigravity": { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth",
      googleMode: "cloud-code-assist", project: "fixture-project", models: ["gemini-3.8-flash"] } },
    protocols: { rollout: { antigravityDirect: direct } },
  } as unknown as OcxConfig;
}

const CACHE_DIAGNOSTIC_HOOK = Symbol.for("opencodex.cache-diagnostic.v1");
type DiagnosticHooks = { enabled(): boolean };

/**
 * Make the cache-diagnostic recorder report "not observing" for its first call (the ingress plans
 * the direct lane) and "observing" afterwards (the settled route then declines the plan), so the
 * ingress leaves the direct plan for the full bridge translation.
 */
function observeDiagnosticsAfterPlanning(): () => void {
  const slot = globalThis as Record<symbol, DiagnosticHooks | undefined>;
  const real = slot[CACHE_DIAGNOSTIC_HOOK];
  let calls = 0;
  slot[CACHE_DIAGNOSTIC_HOOK] = { ...(real as object), enabled: () => ++calls > 1 } as DiagnosticHooks;
  return () => { slot[CACHE_DIAGNOSTIC_HOOK] = real; };
}

async function promptCacheKeyFor(direct: boolean, agentId: string | undefined, firstMessage?: string): Promise<unknown> {
  const lease = tryAdmitTurn();
  expect(lease).not.toBeNull();
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", ...(agentId ? { "x-claude-code-agent-id": agentId } : {}) },
      body: JSON.stringify({ model: "google-antigravity/gemini-3.8-flash", max_tokens: 64, stream: false, metadata: { user_id: userId },
        tools: [{ name: "lookup", description: "find", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: firstMessage ?? (agentId ? "a fresh subagent brief" : "ping") }] }),
    }), antigravityConfig(direct), { model: "", provider: "" }, { requestId: `fixture-${crypto.randomUUID()}`, start: Date.now(), turnAdmissionLease: lease!,
      admission: { kind: "loopback", source: "loopback" } });
    await response.text();
  } finally { lease?.release(); }
  expect(captured).toHaveLength(1);
  return captured[0]!.options.promptCacheKey;
}

for (const direct of [true, false]) {
  test(`a subagent keeps its own prompt_cache_key and the main loop its session's (direct lane ${direct ? "on" : "off"})`, async () => {
    expect(await promptCacheKeyFor(direct, undefined)).toBe(MAIN_KEY);
    captured.length = 0;
    expect(await promptCacheKeyFor(direct, AGENT_ID)).toBe(SUBAGENT_KEY);
  });
}

test("a subagent keeps its own prompt_cache_key when the ingress leaves the direct plan for the bridge translation", async () => {
  const restore = observeDiagnosticsAfterPlanning();
  try {
    expect(await promptCacheKeyFor(true, AGENT_ID)).toBe(SUBAGENT_KEY);
  } finally { restore(); }
});

// A fork carries its parent's first message and tools, so it takes the main loop's key on every translation call.
for (const direct of [true, false]) {
  test(`a fork keeps the main loop's prompt_cache_key (direct lane ${direct ? "on" : "off"})`, async () => {
    expect(await promptCacheKeyFor(direct, undefined, "the shared task")).toBe(MAIN_KEY);
    captured.length = 0;
    expect(await promptCacheKeyFor(direct, AGENT_ID, "the shared task")).toBe(MAIN_KEY);
  });
}

test("a fork keeps the main loop's prompt_cache_key when the ingress leaves the direct plan for the bridge translation", async () => {
  expect(await promptCacheKeyFor(true, undefined, "the shared task")).toBe(MAIN_KEY);
  captured.length = 0;
  const restore = observeDiagnosticsAfterPlanning();
  try {
    expect(await promptCacheKeyFor(true, AGENT_ID, "the shared task")).toBe(MAIN_KEY);
  } finally { restore(); }
});
