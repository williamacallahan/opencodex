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
// session stays constant across the family; thread-id distinguishes the actual agent.
const MAIN_KEY = "ded3519449f6b3132a5908b61cafe21f";
const MAIN_SESSION_ID = "ded35194-49f6-4313-8a59-08b61cafe21f";
const SUBAGENT_KEYS = { a1b2c3d4e5f60718: "40dfe2ab195caa9b78ba1a0f8412bf3c", f0e1d2c3b4a59687: "c297a4f3a042b973a147c1e60b1a153d" } as const;
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

test("the upstream sees fixed per-agent cache keys and distinct threads under the same wire session", async () => {
  await turn();
  await turn("a1b2c3d4e5f60718");
  await turn("f0e1d2c3b4a59687");
  expect(wires.map(wire => [wire.key, wire.headers.get("session_id")])).toEqual([
    [MAIN_KEY, MAIN_SESSION_ID],
    [SUBAGENT_KEYS.a1b2c3d4e5f60718, MAIN_SESSION_ID],
    [SUBAGENT_KEYS.f0e1d2c3b4a59687, MAIN_SESSION_ID],
  ]);
  const threads = wires.map(wire => wire.headers.get("thread-id"));
  expect(threads[0]).toBe(MAIN_SESSION_ID);
  expect(threads.every(Boolean)).toBe(true);
  expect(new Set(threads).size).toBe(3);
});

test("a spent relay thread accepts the complete Claude turn on a fresh thread", async () => {
  const refusal = { error: { type: "invalid_request_error", code: "previous_response_not_found",
    message: "The previous response owner is out of usage. Resend the full conversation without previous_response_id." } };
  let firstThread: string | null = null;
  let firstInput = "", firstCache: unknown, firstSession: string | null = null;
  globalThis.fetch = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://relay.example/backend-api/codex/responses");
    const headers = new Headers(init?.headers), thread = headers.get("thread-id");
    const body = JSON.parse(String(init?.body));
    expect(body.store).toBe(false); expect(body.previous_response_id).toBeUndefined();
    expect(thread).toBeTruthy();
    const history = JSON.stringify(body.input);
    if (!firstThread) { firstThread = thread; firstInput = history; firstCache = body.prompt_cache_key; firstSession = headers.get("session_id"); }
    if (thread === firstThread) return Response.json(refusal, { status: 400 });
    expect(history).toBe(firstInput); expect(history).toContain("call_test"); expect(history).toContain("tool result"); expect(history).toContain("wake up");
    expect(body.prompt_cache_key).toBe(firstCache); expect(headers.get("session_id")).toBe(firstSession);
    return new Response([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"continued"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_good","status":"completed","usage":{"input_tokens":20,"output_tokens":1}}}\n\n',
    ].join(""), { headers: { "Content-Type": "text/event-stream" } });
  }, originalFetch);
  const config = { port: 0, defaultProvider: "relay", providers: { relay: { adapter: "openai-responses", baseUrl: "https://relay.example/backend-api/codex", responsesPath: "/responses", apiKey: "fixture-key", upstreamWebsocket: false } } } satisfies OcxConfig;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "relay/gpt-6.2-sol", stream: true, max_tokens: 128, metadata: { user_id: userId },
      messages: [{ role: "user", content: "start" }, { role: "system", content: "follow the instructions" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_test", name: "example", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_test", content: "tool result" }] }, { role: "user", content: "wake up" }],
      tools: [{ name: "example", input_schema: { type: "object", properties: {} } }] }) }), config, { model: "", provider: "" });
  const text = await response.text(); expect(response.status).toBe(200); expect(text).toContain("continued"); expect(text).toContain("event: message_stop");
});

test("a fresh thread whose owner is spent later is replaced again and the session stays on the newest thread", async () => {
  const refusal = { error: { type: "invalid_request_error", code: "previous_response_not_found",
    message: "The previous response owner is out of usage. Resend the full conversation without previous_response_id." } };
  const spent = new Set<string>();
  const sent: Array<{ thread: string | null; status: number }> = [];
  globalThis.fetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const thread = new Headers(init?.headers).get("thread-id");
    if (sent.length === 0 && thread) spent.add(thread);
    const refused = thread !== null && spent.has(thread);
    sent.push({ thread, status: refused ? 400 : 200 });
    if (refused) return Response.json(refusal, { status: 400 });
    return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_good","status":"completed","usage":{"input_tokens":20,"output_tokens":1}}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } });
  }, originalFetch);
  const config = { port: 0, defaultProvider: "relay", providers: { relay: { adapter: "openai-responses", baseUrl: "https://relay.example/backend-api/codex", responsesPath: "/responses", apiKey: "fixture-key", upstreamWebsocket: false } } } satisfies OcxConfig;
  const sessionUser = "user_ghi789_account__session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const run = async (text: string) => {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay/gpt-6.2-sol", stream: true, max_tokens: 128, metadata: { user_id: sessionUser }, messages: [{ role: "user", content: text }] }) }), config, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(200);
  };
  await run("one"); await run("two");
  const second = sent[1]!.thread!;
  spent.add(second);
  await run("three"); await run("four");
  expect(sent.map(row => row.status)).toEqual([400, 200, 200, 400, 200, 200]);
  expect(sent[3]!.thread).toBe(second);
  expect(sent[4]!.thread).not.toBe(second);
  expect(sent[5]!.thread).toBe(sent[4]!.thread);
});

test("after a spent relay owner moved a turn to a fresh thread, the next turn starts on that thread instead of the spent one", async () => {
  const refusal = { error: { type: "invalid_request_error", code: "previous_response_not_found",
    message: "The previous response owner is out of usage. Resend the full conversation without previous_response_id." } };
  const spentThread = new Set<string>();
  const sent: Array<{ thread: string | null; status: number }> = [];
  globalThis.fetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const thread = new Headers(init?.headers).get("thread-id");
    // codex-lb answers the first thread it sees for this session with the spent-owner refusal, then accepts any other.
    if (spentThread.size === 0 && thread) spentThread.add(thread);
    const refused = thread !== null && spentThread.has(thread);
    sent.push({ thread, status: refused ? 400 : 200 });
    if (refused) return Response.json(refusal, { status: 400 });
    return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_good","status":"completed","usage":{"input_tokens":20,"output_tokens":1}}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } });
  }, originalFetch);
  const config = { port: 0, defaultProvider: "relay", providers: { relay: { adapter: "openai-responses", baseUrl: "https://relay.example/backend-api/codex", responsesPath: "/responses", apiKey: "fixture-key", upstreamWebsocket: false } } } satisfies OcxConfig;
  const sessionUser = "user_def456_account__session_66666666-7777-8888-9999-000000000000";
  for (const text of ["first turn", "second turn", "third turn"]) {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "relay/gpt-6.2-sol", stream: true, max_tokens: 128, metadata: { user_id: sessionUser }, messages: [{ role: "user", content: text }] }) }), config, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(200);
  }
  // Turn one: refused on the session thread, resent once on a fresh thread. Turns two and three go straight to that fresh thread.
  expect(sent.map(row => row.status)).toEqual([400, 200, 200, 200]);
  expect(new Set(sent.slice(1).map(row => row.thread)).size).toBe(1);
  expect(sent[1]!.thread).not.toBe(sent[0]!.thread);
});
