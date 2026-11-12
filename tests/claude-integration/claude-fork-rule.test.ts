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
import {
  MAX_CLAUDE_FORK_PAIRS, MAX_CLAUDE_FORK_SESSIONS, claudeForkSessionCountForTests, clearClaudeForkSessionsForTests, resolveClaudeFork,
} from "../../src/server/claude-fork-session";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const SESSION = "user_abc123_account__session_11111111-2222-3333-4444-555555555555";
const OTHER_SESSION = `${SESSION}-other`;
const AGENT = "a1b2c3d4e5f60718";
const TOOLS = [{ name: "lookup", description: "find", input_schema: { type: "object" } }];
const OTHER_TOOLS = [{ name: "write", description: "write", input_schema: { type: "object" } }];
// Independent SHA-256 vectors (python hashlib): the main loop's key and session_id, the fresh subagent's own,
// and the same agent id under the other session. The session_id is the key laid out as a version-4 uuid.
const MAIN = { key: "ded3519449f6b3132a5908b61cafe21f", sessionId: "ded35194-49f6-4313-8a59-08b61cafe21f" };
const OWN = { key: "40dfe2ab195caa9b78ba1a0f8412bf3c", sessionId: "40dfe2ab-195c-4a9b-88ba-1a0f8412bf3c" };
const OTHER_OWN = { key: "c43f21926b7645fa29644c35264cfcc0", sessionId: "c43f2192-6b76-45fa-8964-4c35264cfcc0" };
let home: string, previous: string | undefined, isolated: IsolatedCodexHome, release: () => void;
let wires: Array<{ headers: Headers; key: unknown }>;

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-fork-rule-"));
  process.env.OPENCODEX_HOME = home;
  isolated = installIsolatedCodexHome("ocx-fork-rule-codex-");
  release = acquireOwnedSpendHome();
  clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota(); clearCodexThreadLineageForTests(); clearConversationStateIssuerMap();
  clearClaudeForkSessionsForTests(); clearRequestLogsForTests();
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
  clearClaudeForkSessionsForTests();
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(home); clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota(); clearCodexThreadLineageForTests(); clearConversationStateIssuerMap();
});

/** Sends one turn and returns what the upstream saw plus the shape row's fork decision. */
type FirstMessage = string | Array<Record<string, unknown>>;
async function turn(options: {
  session?: string; agentId?: string; agentHeader?: string; firstMessage: FirstMessage; tools?: unknown[]; admission?: DataPlaneAdmission;
}): Promise<{ key: unknown; sessionId: string | null; fork: unknown }> {
  const config = { defaultProvider: "openai", activeCodexAccountId: "fixture-a", autoSwitchThreshold: 0,
    codexAccounts: [{ id: "fixture-a", label: "a" }],
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", upstreamWebsocket: false } },
  } as unknown as OcxConfig;
  const requestId = `fork-${crypto.randomUUID()}`;
  const lease = tryAdmitTurn();
  expect(lease).not.toBeNull();
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", ...(options.agentId ? { "x-claude-code-agent-id": options.agentId } : {}),
        ...(options.agentHeader !== undefined ? { "x-claude-code-agent-id": options.agentHeader } : {}) },
      body: JSON.stringify({ model: "openai/gpt-5.4", max_tokens: 32, stream: false, metadata: { user_id: options.session ?? SESSION },
        tools: options.tools ?? TOOLS, messages: [{ role: "user", content: options.firstMessage }] }),
    }), config, { model: "", provider: "" }, { requestId, start: Date.now(), turnAdmissionLease: lease!, admission: options.admission ?? { kind: "loopback", source: "loopback" } });
    await response.text();
    expect(response.status).toBe(200);
  } finally { lease?.release(); }
  const wire = wires.at(-1)!;
  let fork: unknown;
  for (let i = 0; i < 100 && fork === undefined; i++) {
    fork = (getRequestLogEntries().find(entry => entry.requestId === requestId) as { claudeRequestShape?: { fork?: string } } | undefined)?.claudeRequestShape?.fork;
    if (fork === undefined) await Bun.sleep(10);
  }
  return { key: wire.key, sessionId: wire.headers.get("session_id"), fork };
}

test("a request with an agent id and the main loop's first message is a fork: the parent's key and session_id", async () => {
  expect(await turn({ firstMessage: "the task" })).toEqual({ key: MAIN.key, sessionId: MAIN.sessionId, fork: "absent" });
  expect(await turn({ agentId: AGENT, firstMessage: "the task" })).toEqual({ key: MAIN.key, sessionId: MAIN.sessionId, fork: "true" });
});

test("a fresh subagent (different first message) keeps its own key and session_id", async () => {
  await turn({ firstMessage: "the task" });
  expect(await turn({ agentId: AGENT, firstMessage: "a different brief" })).toEqual({ key: OWN.key, sessionId: OWN.sessionId, fork: "false" });
});

test("a fork arriving with no remembered main-loop message keeps its own key", async () => {
  expect(await turn({ agentId: AGENT, firstMessage: "the task" })).toEqual({ key: OWN.key, sessionId: OWN.sessionId, fork: "false" });
});

test("two sessions with the same first message do not affect each other", async () => {
  await turn({ firstMessage: "the task" });
  expect(await turn({ session: OTHER_SESSION, agentId: AGENT, firstMessage: "the task" }))
    .toEqual({ key: OTHER_OWN.key, sessionId: OTHER_OWN.sessionId, fork: "false" });
});

test("a different tools array is not a fork, even with the main loop's first message", async () => {
  await turn({ firstMessage: "the task" });
  expect(await turn({ agentId: AGENT, firstMessage: "the task", tools: OTHER_TOOLS })).toEqual({ key: OWN.key, sessionId: OWN.sessionId, fork: "false" });
});

test("a one-message side request does not displace the main loop's pair; the last four distinct pairs all match", async () => {
  await turn({ firstMessage: "the task" });
  await turn({ firstMessage: "a side question", tools: OTHER_TOOLS });
  expect((await turn({ agentId: AGENT, firstMessage: "the task" })).fork).toBe("true");
  expect((await turn({ agentId: AGENT, firstMessage: "a side question", tools: OTHER_TOOLS })).fork).toBe("true");
  // Four distinct pairs are remembered; a fifth displaces the oldest.
  for (let i = 0; i < MAX_CLAUDE_FORK_PAIRS - 1; i++) await turn({ firstMessage: `another ${i}` });
  expect((await turn({ agentId: AGENT, firstMessage: "the task" })).fork).toBe("false");
  expect((await turn({ agentId: AGENT, firstMessage: "another 0" })).fork).toBe("true");
});

test("a request whose agent header is empty is neither remembered as the main loop nor judged as a fork", async () => {
  await turn({ firstMessage: "the task" });
  expect((await turn({ agentHeader: " ", firstMessage: "an impostor" })).fork).toBe("absent");
  expect((await turn({ agentId: AGENT, firstMessage: "an impostor" })).fork).toBe("false");
  expect((await turn({ agentId: AGENT, firstMessage: "the task" })).fork).toBe("true");
});

test("moving cache_control markers in the first message's content blocks does not change the match", async () => {
  const blocks = (marked: number) => [{ type: "text", text: "the task" }, { type: "text", text: "more" }]
    .map((block, index) => (index === marked ? { ...block, cache_control: { type: "ephemeral" } } : block));
  await turn({ firstMessage: blocks(0) });
  expect(await turn({ agentId: AGENT, firstMessage: blocks(1) })).toEqual({ key: MAIN.key, sessionId: MAIN.sessionId, fork: "true" });
});

test("another principal sending the same session id neither matches nor overwrites", async () => {
  const principal = (id: string): DataPlaneAdmission => ({ kind: "configured", keyId: "fixture", source: "dedicated", contextPrincipalId: id });
  await turn({ firstMessage: "the task", admission: principal("p1") });
  expect((await turn({ agentId: AGENT, firstMessage: "the task", admission: principal("p2") })).fork).toBe("false");
  await turn({ firstMessage: "a different task", admission: principal("p2") });
  expect((await turn({ agentId: AGENT, firstMessage: "the task", admission: principal("p1") })).fork).toBe("true");
});

test("the session map is bounded and evicts the least recently used session", () => {
  const digest = (n: number) => n.toString(16).padStart(32, "0");
  const main = (key: string, n: number) => resolveClaudeFork({ sessionKey: key, kind: "absent", firstMessageDigest: digest(n), toolsDigest: digest(1) });
  const agent = (key: string, n: number) => resolveClaudeFork({ sessionKey: key, kind: "agent", firstMessageDigest: digest(n), toolsDigest: digest(1) });
  for (let i = 0; i < MAX_CLAUDE_FORK_SESSIONS; i++) main(`s${i}`, i + 2);
  expect(claudeForkSessionCountForTests()).toBe(MAX_CLAUDE_FORK_SESSIONS);
  // A fork match refreshes s0, so the next insertion evicts s1 instead.
  expect(agent("s0", 2)).toBe("true");
  main("extra", 99_999);
  expect(claudeForkSessionCountForTests()).toBe(MAX_CLAUDE_FORK_SESSIONS);
  expect(agent("s1", 3)).toBe("false");
  expect(agent("s0", 2)).toBe("true");
});

test("markers and a missing session never remember or match", () => {
  const digest = "a".repeat(32);
  const input = { sessionKey: "s" as string | undefined, kind: "absent" as const, firstMessageDigest: digest as string | undefined, toolsDigest: digest as string | undefined };
  resolveClaudeFork({ ...input, firstMessageDigest: "absent" });
  resolveClaudeFork({ ...input, toolsDigest: "absent" });
  resolveClaudeFork({ ...input, sessionKey: undefined });
  expect(claudeForkSessionCountForTests()).toBe(0);
  for (const bad of [{ firstMessageDigest: "absent" }, { toolsDigest: "absent" }, { sessionKey: undefined }])
    expect(resolveClaudeFork({ ...input, ...bad, kind: "agent" })).toBe("false");
});
