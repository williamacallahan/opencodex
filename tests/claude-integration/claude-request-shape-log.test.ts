import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseClaudeRequestShape } from "../../src/server/claude-request-shape";
import { readRecentUsageEntries } from "../../src/usage/log";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const AGENT = "a1b2c3d4e5f60718";
const PARENT = "9f8e7d6c5b4a3921";
const SYSTEM_TEXT = "private system prompt text";
const FIRST_MESSAGE_TEXT = "private first message text";
const sha32 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const text32 = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const idHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const TOOLS = [{ name: "lookup", description: "find", input_schema: { type: "object" } }];
let home: string, previous: string | undefined, release: () => void;

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-request-shape-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearRequestLogsForTests();
  globalThis.fetch = (async () => new Response([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 1 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch; release();
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(home);
});

async function row(headers: Record<string, string>, bodyOverrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const config = { defaultProvider: "mock", providers: { mock: { adapter: "openai-chat", baseUrl: "https://mock.example/v1", apiKey: "k", models: ["m"] } } } as unknown as OcxConfig;
  const requestId = `shape-${crypto.randomUUID()}`;
  const lease = tryAdmitTurn();
  expect(lease).not.toBeNull();
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "mock/m", max_tokens: 16, stream: false, system: SYSTEM_TEXT, tools: TOOLS,
        messages: [{ role: "user", content: FIRST_MESSAGE_TEXT }, { role: "assistant", content: "a" }, { role: "user", content: "b" }], ...bodyOverrides }),
    }), config, { model: "", provider: "" }, { requestId, start: Date.now(), turnAdmissionLease: lease!, admission: { kind: "loopback", source: "loopback" } });
    await response.text();
    expect(response.status).toBe(200);
  } finally { lease?.release(); }
  for (let i = 0; i < 100; i++) {
    const entry = getRequestLogEntries().find(candidate => candidate.requestId === requestId);
    if (entry) return entry as unknown as Record<string, unknown>;
    await Bun.sleep(10);
  }
  throw new Error("request log row never appeared");
}

test("a subagent request's row carries hashes of its ids and prefix, joinable to its usage, and no raw value", async () => {
  const entry = await row({ "x-claude-code-agent-id": AGENT, "x-claude-code-parent-agent-id": PARENT });
  expect(entry.claudeRequestShape).toEqual({
    agentId: idHash(AGENT), parentAgentId: idHash(PARENT), system: sha32(SYSTEM_TEXT), tools: sha32(TOOLS),
    messageCount: 3, firstMessage: sha32({ role: "user", content: FIRST_MESSAGE_TEXT }),
    systemBlockCount: 1, systemBlocks: [text32(SYSTEM_TEXT)], systemLastBlock: "absent",
    messagesPrefix: [sha32(FIRST_MESSAGE_TEXT), sha32("a"), sha32("b")],
  });
  expect(entry.usage).toBeDefined();
  const serialized = JSON.stringify(entry);
  for (const secret of [AGENT, PARENT, SYSTEM_TEXT, FIRST_MESSAGE_TEXT]) expect(serialized).not.toContain(secret);
  expect(parseClaudeRequestShape(entry.claudeRequestShape)).toEqual(entry.claudeRequestShape as never);
  // The durable usage record keeps the same shape beside the usage the row reports.
  const persisted = readRecentUsageEntries(5).find(candidate => candidate.requestId === entry.requestId);
  expect(persisted?.claudeRequestShape).toEqual(entry.claudeRequestShape as never);
  expect(persisted?.usage).toBeDefined();
});

test("a main-loop request marks both id headers absent, and a blank header reads as empty", async () => {
  expect((await row({})).claudeRequestShape).toMatchObject({ agentId: "absent", parentAgentId: "absent", messageCount: 3 });
  expect((await row({ "x-claude-code-agent-id": " ", "x-claude-code-parent-agent-id": "" })).claudeRequestShape)
    .toMatchObject({ agentId: "empty", parentAgentId: "empty" });
});

test("a stored shape accepts only digests, markers and a bounded count", () => {
  const ok = { agentId: "absent", parentAgentId: "empty", system: sha32("s"), tools: "absent", messageCount: 2, firstMessage: "invalid" };
  expect(parseClaudeRequestShape(ok)).toEqual(ok);
  for (const bad of [{ ...ok, agentId: AGENT }, { ...ok, system: SYSTEM_TEXT }, { ...ok, messageCount: -1 }, { ...ok, messageCount: 1.5 }, "x", null])
    expect(parseClaudeRequestShape(bad)).toBeUndefined();
});

test("system block structure: per-block text hashes in order, the last block past twelve, markers when there is no system", async () => {
  const texts = Array.from({ length: 14 }, (_, i) => `private system block ${i}`);
  const system = texts.map((text, i) => ({ type: "text", text, ...(i === 0 ? { cache_control: { type: "ephemeral" } } : {}) }));
  const entry = await row({}, { system });
  expect(entry.claudeRequestShape).toMatchObject({
    systemBlockCount: 14, systemBlocks: texts.slice(0, 12).map(text32), systemLastBlock: text32(texts[13]!),
  });
  for (const text of texts) expect(JSON.stringify(entry)).not.toContain(text);
  expect((await row({}, { system: texts.slice(0, 2).map(text => ({ type: "text", text })) })).claudeRequestShape)
    .toMatchObject({ systemBlockCount: 2, systemBlocks: texts.slice(0, 2).map(text32), systemLastBlock: "absent" });
  expect((await row({}, { system: undefined })).claudeRequestShape)
    .toMatchObject({ systemBlockCount: 0, systemBlocks: [], system: "absent", systemLastBlock: "absent" });
  expect((await row({}, { messages: [{ role: "user", content: "only" }] })).claudeRequestShape)
    .toMatchObject({ messageCount: 1, messagesPrefix: [sha32("only")] });
});

test("a stored shape keeps accepting rows from before the block fields and rejects bad block fields", () => {
  const legacy = { agentId: "absent", parentAgentId: "absent", system: "absent", tools: "absent", messageCount: 1, firstMessage: "absent" };
  expect(parseClaudeRequestShape(legacy)).toEqual(legacy);
  const full = { ...legacy, systemBlockCount: 1, systemBlocks: [sha32("s")], systemLastBlock: "absent", messagesPrefix: ["absent"] };
  expect(parseClaudeRequestShape(full)).toEqual(full);
  for (const bad of [{ ...full, systemBlocks: [SYSTEM_TEXT] }, { ...full, systemBlocks: Array(13).fill("absent") },
    { ...full, messagesPrefix: Array(4).fill("absent") }, { ...full, systemBlockCount: -1 }, { ...full, systemLastBlock: undefined }])
    expect(parseClaudeRequestShape(bad)).toBeUndefined();
});
