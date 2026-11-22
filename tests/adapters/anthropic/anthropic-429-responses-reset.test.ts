import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState } from "../../../src/combos/resolve";
import { clearComboTargetCooldowns } from "../../../src/combos/failover";
import { clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum } from "../../../src/oauth/anthropic-routing";
import { clearAnthropicRatePauses } from "../../../src/oauth/anthropic-rate-limit-policy";
import { clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { clearAccountQuotaCache, resetProviderQuotaReconcileStateForTests } from "../../../src/providers/quota";
import { clearResponseStateForTests, flushResponseState } from "../../../src/responses/state";
import { handleResponses } from "../../../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const MODEL = "claude-sonnet-4-5";
let now = 1_770_000_000_000;
let originalHome = process.env.OPENCODEX_HOME;
let home = "";
let releaseSpendHome: (() => void) | undefined;
let sentTokens: string[] = [];

function credential(index: number) {
  return {
    access: `synthetic-anthropic-access-${index}`,
    refresh: `synthetic-anthropic-refresh-${index}`,
    expires: now + 3_600_000_000,
    accountId: `synthetic-account-${index}`,
  };
}

async function seed(count: number): Promise<string[]> {
  for (let index = 0; index < count; index++) await saveCredential("anthropic", credential(index));
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
  return ids;
}

function transient429(retryAfterSeconds = "5"): Response {
  return Response.json(
    { type: "error", error: { type: "rate_limit_error", message: "synthetic transient rate limit" } },
    { status: 429, headers: { "retry-after": retryAfterSeconds } },
  );
}

function spent5h(): Response {
  return Response.json(
    { type: "error", error: { type: "rate_limit_error", message: "synthetic 5h quota" } },
    { status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "60" } },
  );
}

function answered(text = "Done"): Response {
  return Response.json({
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 8, output_tokens: 4 },
  });
}

function configFor(reply: (token: string) => Response): OcxConfig {
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic",
    baseUrl: "https://anthropic-reset.test",
    authMode: "oauth",
    models: [MODEL],
    fetch: (async (_input, init) => {
      const token = String(new Headers(init?.headers).get("authorization"));
      sentTokens.push(token);
      return reply(token);
    }) as typeof fetch,
  };
  return {
    port: 0,
    defaultProvider: "anthropic",
    anthropicAccountPool: { enabled: true, strategy: "fill-first" },
    providers: { anthropic: provider },
  };
}

async function post(config: OcxConfig, raw: Record<string, unknown> = {}): Promise<Response> {
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: "Answer briefly", stream: false, ...raw }),
  }), config, { model: "", provider: "" });
  await response.text();
  return response;
}

beforeEach(() => {
  originalHome = process.env.OPENCODEX_HOME;
  now = 1_770_000_000_000;
  setSystemTime(now);
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-429-reset-"));
  process.env.OPENCODEX_HOME = home;
  sentTokens = [];
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearAnthropicRatePauses();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  clearGenericFailoverHealth();
  clearAccountQuotaCache();
  resetProviderQuotaReconcileStateForTests();
  clearResponseStateForTests();
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(async () => {
  setSystemTime();
  await flushResponseState();
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearAnthropicRatePauses();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  clearGenericFailoverHealth();
  clearAccountQuotaCache();
  resetProviderQuotaReconcileStateForTests();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearResponseStateForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  if (home) removeTreeWithRetry(home);
});

test("200 OK on /v1/responses resets Anthropic 429 escalation back to base 15s admission pause", async () => {
  const ids = await seed(2);
  let mode: "fail0" | "succeed0" | "fail0-again" | "check0" = "fail0";
  const cfg = configFor(token => {
    const isAcct0 = token === `Bearer ${credential(0).access}`;
    if (mode === "fail0") return isAcct0 ? transient429("15") : answered("fallback1");
    if (mode === "succeed0") return isAcct0 ? answered("recovered0") : spent5h();
    if (mode === "fail0-again") return isAcct0 ? transient429("15") : answered("fallback2");
    return isAcct0 ? answered("admitted-at-15s") : transient429("15");
  });

  // 1. Account 0 hits strike-1 transient 429 (15s admission pause) and fails over to account 1.
  expect((await post(cfg)).status).toBe(200);
  expect(sentTokens).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);

  // 2. Past 15s, account 0 serves 200 OK on /v1/responses and resets its consecutive 429 strike counter.
  now += 15_001;
  setSystemTime(now);
  sentTokens = [];
  mode = "succeed0";
  await setActiveAccount("anthropic", ids[0]!);
  expect((await post(cfg)).status).toBe(200);
  expect(sentTokens).toContain(`Bearer ${credential(0).access}`);

  // 3. A subsequent transient 429 starts back at strike 1 (15s pause), not escalated 30s.
  now += 61_000;
  setSystemTime(now);
  sentTokens = [];
  mode = "fail0-again";
  await setActiveAccount("anthropic", ids[0]!);
  expect((await post(cfg)).status).toBe(200);
  expect(sentTokens).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);

  // 4. At +15_001ms (< 30_000ms), account 0 is immediately admissible again rather than blocked until 30s.
  now += 15_001;
  setSystemTime(now);
  sentTokens = [];
  mode = "check0";
  await setActiveAccount("anthropic", ids[0]!);
  expect((await post(cfg)).status).toBe(200);
  expect(sentTokens[0]).toBe(`Bearer ${credential(0).access}`);
}, 20_000);

function answeredStream(text: string): Response {
  const sse = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}

function headerless429(): Response {
  return Response.json(
    { type: "error", error: { type: "rate_limit_error", message: "synthetic headerless rate limit" } },
    { status: 429 },
  );
}

test("200 OK in /v1/responses empty-completion continuation resets Anthropic 429 escalation", async () => {
  await seed(2);
  let phase: "stream-continue" | "headerless-after" = "stream-continue";
  let streamTurn = 0;
  const cfg = configFor(() => {
    if (phase === "stream-continue") {
      streamTurn += 1;
      if (streamTurn === 1) return answeredStream("");
      if (streamTurn === 2) return headerless429();
      return answeredStream("Fixed and verified.");
    }
    return headerless429();
  });
  cfg.emptyCompletionRetry = true;

  // 1. Account 0 completes empty; empty-completion continuation hits headerless 429 (strike 1) then succeeds 200 OK on retry.
  const continued = await post(cfg, { stream: true, input: "Please fix the bug" });
  expect(continued.status).toBe(200);
  expect(sentTokens).toEqual([
    `Bearer ${credential(0).access}`,
    `Bearer ${credential(0).access}`,
    `Bearer ${credential(0).access}`,
  ]);

  // 2. Next request hitting headerless 429 starts back at strike 1 (retries account 0 once rather than
  // treating it as repeated strike 2 -> immediate 15s pause + sibling detour without retry).
  phase = "headerless-after";
  sentTokens = [];
  await post(cfg);
  expect(sentTokens).toEqual([
    `Bearer ${credential(0).access}`,
    `Bearer ${credential(0).access}`,
  ]);
}, 20_000);

