import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearMainAccountInfoCache, clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearCodexThreadLineageForTests } from "../../src/codex/lineage";
import { clearConversationStateIssuerMap } from "../../src/codex/routing/thread-affinity";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const userId = "user_abc123_account__session_11111111-2222-3333-4444-555555555555";
// Independent SHA-256 vectors (python hashlib, not a production helper): the main loop's key is
// sha256(user_id)[:32]; a subagent's is sha256(sha256(user_id) + ":agent:" + agentId)[:32]. The
// session_id the upstream sees is that key laid out as a version-4 uuid.
const MAIN_KEY = "ded3519449f6b3132a5908b61cafe21f";
const MAIN_SESSION_ID = "ded35194-49f6-4313-8a59-08b61cafe21f";
const SUBAGENT_KEYS = { a1b2c3d4e5f60718: "40dfe2ab195caa9b78ba1a0f8412bf3c", f0e1d2c3b4a59687: "c297a4f3a042b973a147c1e60b1a153d" } as const;
const SUBAGENT_SESSION_IDS = { a1b2c3d4e5f60718: "40dfe2ab-195c-4a9b-88ba-1a0f8412bf3c", f0e1d2c3b4a59687: "c297a4f3-a042-4973-8147-c1e60b1a153d" } as const;
let home: string, previous: string | undefined, isolated: IsolatedCodexHome, release: () => void;
let wires: Array<{ headers: Headers; key: unknown }>;

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-subagent-wire-"));
  process.env.OPENCODEX_HOME = home;
  isolated = installIsolatedCodexHome("ocx-subagent-wire-codex-");
  release = acquireOwnedSpendHome();
  clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota(); clearCodexThreadLineageForTests(); clearConversationStateIssuerMap();
  saveCodexAccountCredential("fixture-a", { accessToken: "fixture-access-a", refreshToken: "fixture-refresh-a", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "account-a" });
  updateAccountQuota("fixture-a", 10, 10);
  wires = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { prompt_cache_key?: unknown };
    wires.push({ headers: new Headers(init?.headers), key: body.prompt_cache_key });
    return Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch; clearMainAccountInfoCache(); release(); isolated.restore();
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(home); clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota(); clearCodexThreadLineageForTests(); clearConversationStateIssuerMap();
});

async function turn(agentId?: string): Promise<void> {
  const config = { defaultProvider: "openai", activeCodexAccountId: "fixture-a", autoSwitchThreshold: 0,
    codexAccounts: [{ id: "fixture-a", label: "a" }],
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", upstreamWebsocket: false } },
  } as unknown as OcxConfig;
  const lease = tryAdmitTurn();
  expect(lease).not.toBeNull();
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", ...(agentId ? { "x-claude-code-agent-id": agentId } : {}) },
      body: JSON.stringify({ model: "openai/gpt-5.4", max_tokens: 32, stream: false, metadata: { user_id: userId }, messages: [{ role: "user", content: agentId ? "a fresh subagent brief" : "ping" }] }),
    }), config, { model: "", provider: "" }, { requestId: "fixture", start: Date.now(), turnAdmissionLease: lease!, admission: { kind: "loopback", source: "loopback" } });
    await response.text();
    expect(response.status).toBe(200);
  } finally { lease?.release(); }
}

test("the upstream sees fixed per-agent prompt_cache_key and session_id values; the main loop keeps the session's", async () => {
  await turn();
  await turn("a1b2c3d4e5f60718");
  await turn("f0e1d2c3b4a59687");
  expect(wires.map(wire => [wire.key, wire.headers.get("session_id")])).toEqual([
    [MAIN_KEY, MAIN_SESSION_ID],
    [SUBAGENT_KEYS.a1b2c3d4e5f60718, SUBAGENT_SESSION_IDS.a1b2c3d4e5f60718],
    [SUBAGENT_KEYS.f0e1d2c3b4a59687, SUBAGENT_SESSION_IDS.f0e1d2c3b4a59687],
  ]);
});
