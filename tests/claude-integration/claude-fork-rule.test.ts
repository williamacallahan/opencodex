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
// Independent vectors: fresh agents split the body key, not the wire session.
const MAIN = { key: "ded3519449f6b3132a5908b61cafe21f", sessionId: "ded35194-49f6-4313-8a59-08b61cafe21f" };
const OWN = { key: "40dfe2ab195caa9b78ba1a0f8412bf3c", sessionId: MAIN.sessionId };
const OTHER_OWN_KEY = "c43f21926b7645fa29644c35264cfcc0";
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
  for (const id of ["fixture-a", "fixture-b"]) {
    saveCodexAccountCredential(id, { accessToken: `test-access-${id}`, refreshToken: `test-refresh-${id}`, expiresAt: Date.now() + 3_600_000, chatgptAccountId: id });
    updateAccountQuota(id, 10, 10);
  }
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
  session?: string; sessionHeader?: string; explicitThread?: string; headerOnly?: boolean; agentId?: string; agentHeader?: string; firstMessage: FirstMessage; tools?: unknown[]; admission?: DataPlaneAdmission;
}): Promise<{ key: unknown; sessionId: string | null; fork: unknown }> {
  const config = { defaultProvider: "openai", activeCodexAccountId: "fixture-a", autoSwitchThreshold: 0,
    accountPoolStrategy: "round-robin", accountPoolStickyLimit: 1,
    codexAccounts: [{ id: "fixture-a", label: "a" }, { id: "fixture-b", label: "b" }],
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", upstreamWebsocket: false } },
  } as unknown as OcxConfig;
  const requestId = `fork-${crypto.randomUUID()}`;
  const lease = tryAdmitTurn();
  expect(lease).not.toBeNull();
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", ...(options.agentId ? { "x-claude-code-agent-id": options.agentId } : {}),
        ...(options.headerOnly || options.sessionHeader ? { "x-claude-code-session-id": options.sessionHeader ?? options.session ?? SESSION } : {}),
        ...(options.explicitThread ? { "thread-id": options.explicitThread } : {}),
        ...(options.agentHeader !== undefined ? { "x-claude-code-agent-id": options.agentHeader } : {}) },
      body: JSON.stringify({ model: "openai/gpt-5.4", max_tokens: 32, stream: false, ...(options.headerOnly ? {} : { metadata: { user_id: options.session ?? SESSION } }),
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
  const other = await turn({ session: OTHER_SESSION, firstMessage: "different" });
  expect(await turn({ session: OTHER_SESSION, agentId: AGENT, firstMessage: "the task" }))
    .toEqual({ key: OTHER_OWN_KEY, sessionId: other.sessionId, fork: "false" });
});

test("a different tools array is not a fork, even with the main loop's first message", async () => {
  await turn({ firstMessage: "the task" });
  expect(await turn({ agentId: AGENT, firstMessage: "the task", tools: OTHER_TOOLS })).toEqual({ key: OWN.key, sessionId: OWN.sessionId, fork: "false" });
});

test.each([false, true])("a fork keeps its cache group and its own wire thread after parent hint eviction (header only: %s)", async headerOnly => {
  const main = await turn({ firstMessage: "the task", headerOnly });
  const parentThread = wires.at(-1)?.headers.get("thread-id");
  const parentSeat = wires.at(-1)?.headers.get("chatgpt-account-id");
  const fork = await turn({ agentId: AGENT, firstMessage: "the task", headerOnly });
  const forkThread = wires.at(-1)?.headers.get("thread-id");
  expect(fork).toEqual({ ...main, fork: "true" });
  const forkSeat = wires.at(-1)?.headers.get("chatgpt-account-id");
  expect(forkSeat).toBeTruthy();
  expect(forkSeat).not.toBe(parentSeat);
  expect(forkThread).toBeTruthy();
  expect(forkThread).not.toBe(parentThread);
  for (let i = 0; i < MAX_CLAUDE_FORK_PAIRS; i++) await turn({ firstMessage: `side ${i}`, headerOnly });
  expect(await turn({ agentId: AGENT, firstMessage: "the task", headerOnly })).toEqual(fork);
  expect(wires.at(-1)?.headers.get("thread-id")).toBe(forkThread);
  expect(wires.at(-1)?.headers.get("chatgpt-account-id")).toBe(forkSeat);
  const sibling = await turn({ agentId: "sibling", firstMessage: "the task", headerOnly });
  expect(sibling.fork).toBe("false");
  expect(sibling.key).not.toBe(main.key);
  expect(wires.at(-1)?.headers.get("thread-id")).not.toBe(forkThread);
});

test("a served legacy key survives a header-only continuation and eviction of the parent hint store", async () => {
  const sessionHeader = "documented-session";
  const main = await turn({ sessionHeader, firstMessage: "the task" });
  expect(main.key).toBe(MAIN.key);
  const first = await turn({ sessionHeader, agentId: AGENT, firstMessage: "the task" });
  expect(first.fork).toBe("true");
  const digest = "a".repeat(32);
  for (let i = 0; i <= MAX_CLAUDE_FORK_SESSIONS; ++i) resolveClaudeFork({ sessionKey: `unserved-${i}`, kind: "absent", firstMessageDigest: digest, toolsDigest: digest });
  expect(await turn({ sessionHeader, headerOnly: true, agentId: AGENT, firstMessage: "continued" })).toEqual(first);
});

test("two Claude sessions reusing a thread and agent id have separate first placements", async () => {
  const common = { explicitThread: "same-thread", firstMessage: "main" };
  const main = await turn({ ...common, sessionHeader: "one", headerOnly: true });
  const fork = await turn({ ...common, sessionHeader: "one", agentId: AGENT, headerOnly: true });
  const seat = wires.at(-1)?.headers.get("chatgpt-account-id");
  const other = await turn({ ...common, sessionHeader: "two", agentId: AGENT, headerOnly: true });
  expect(fork.fork).toBe("true");
  expect(fork.key).toBe(main.key);
  expect(other.fork).toBe("false");
  expect(wires.at(-1)?.headers.get("chatgpt-account-id")).not.toBe(seat);
});

test("a request whose agent header is empty is neither remembered as the main loop nor judged as a fork", async () => {
  await turn({ firstMessage: "the task" });
  expect((await turn({ agentHeader: " ", firstMessage: "an impostor" })).fork).toBe("absent");
  expect((await turn({ agentId: AGENT, firstMessage: "an impostor" })).fork).toBe("false");
  expect((await turn({ agentId: "fresh-sibling", firstMessage: "the task" })).fork).toBe("true");
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
