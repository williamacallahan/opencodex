import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeSessionId } from "../../src/adapters/client-fingerprint";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import { saveCredential } from "../../src/oauth/store";
import { anthropicSessionAffinitySizeForTests, clearAnthropicAccountPoolState } from "../../src/oauth/anthropic-routing";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const userId = "user_abc123_account__session_11111111-2222-3333-4444-555555555555";
// Independent SHA-256 vector: the key the main loop of `userId` has always used (hex, first 32 chars).
const MAIN_LOOP_KEY = "ded3519449f6b3132a5908b61cafe21f";
const ACCESS = "fixture-access-token";
let home: string;
let previousHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;
let wires: Headers[];

beforeEach(async () => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-subagent-key-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
  clearAnthropicAccountPoolState();
  await saveCredential("anthropic", { access: ACCESS, refresh: "fixture-refresh", expires: Date.now() + 3_600_000, accountId: "A" });
  wires = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    wires.push(new Headers(init?.headers));
    const frames: Array<[string, unknown]> = [
      ["message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    return new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAnthropicAccountPoolState();
  releaseSpendHome?.();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function translatedAnthropicConfig(): OcxConfig {
  // Native Messages off for the managed OAuth lane: every turn takes the translating bridge.
  return {
    defaultProvider: "anthropic",
    providers: { anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", models: ["claude-sonnet-4-5"] } },
    anthropicAccountPool: { enabled: true },
    protocols: { rollout: { managedMessagesNative: false, managedMessagesNativeOAuth: false } },
  } as unknown as OcxConfig;
}

async function turn(config: OcxConfig, agentId?: string): Promise<void> {
  const lease = tryAdmitTurn();
  expect(lease).not.toBeNull();
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...(agentId ? { "x-claude-code-agent-id": agentId } : {}) },
      body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", max_tokens: 32, stream: false,
        metadata: { user_id: userId }, messages: [{ role: "user", content: agentId ? "a fresh subagent brief" : "ping" }] }),
    }), config, { model: "", provider: "" }, { requestId: "fixture", start: Date.now(), turnAdmissionLease: lease!,
      admission: { kind: "loopback", source: "loopback" } });
    await response.text();
    expect(response.status).toBe(200);
  } finally { lease?.release(); }
}

test("a subagent on the translated Anthropic route keeps the session's fingerprint id and pool affinity key", async () => {
  const config = translatedAnthropicConfig();
  await turn(config);
  await turn(config, "a1b2c3d4e5f60718");
  await turn(config, "f0e1d2c3b4a59687");
  expect(wires).toHaveLength(3);
  const expected = claudeCodeSessionId(ACCESS, MAIN_LOOP_KEY);
  expect(wires.map(wire => wire.get("x-claude-code-session-id"))).toEqual([expected, expected, expected]);
  // One session, one affinity binding: a per-agent key would bind three.
  expect(anthropicSessionAffinitySizeForTests()).toBe(1);
});
