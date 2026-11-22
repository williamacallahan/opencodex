import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { apiKeyAccountLogLabel } from "../../src/codex/account-label";
import { clearComboTargetCooldowns } from "../../src/combos/failover";
import { clearComboSelectionState } from "../../src/combos/resolve";
import { configureSharedSpendLedger, sharedSpendLedger, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import { admitWorkflowTurn, listWorkflowBudgetEvents, resetWorkflowBudgetsForTest, workflowBudgetSnapshot } from "../../src/lib/workflow-budget";
import { clearKeyCooldowns, forgetApiKeyRotationCursor } from "../../src/providers/key-failover";
import { MistralBudgetPacer, resolveMistralTransport } from "../../src/providers/mistral-transport";
import { protocolTraceForRequest } from "../../src/protocols/trace";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { createInferenceSendBudget } from "../../src/server/inference/context";
import type { RequestLogContext } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { chatSuccess, responsesSuccess } from "../helpers/combo-failover-upstream";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const provider = "fixture-mistral";
const root = "fixture-mistral-spend-root";
const keys = [
  { id: "first", key: "fixture-selected-first", addedAt: 1 },
  { id: "second", key: "fixture-selected-second", addedAt: 2 },
];
function label(index: number) {
  const { id, key } = keys[index]!;
  return apiKeyAccountLogLabel(provider, { entryId: id, reference: key })!;
}
const headroom = { maxTokens: 10_000 };
const combined = { identity: headroom, pool: headroom, root: headroom };
let home: TempHome, release: () => void;
beforeEach(() => {
  home = createTempHome("ocx-mistral-selected-spend-");
  release = acquireOwnedSpendHome();
});
afterEach(async () => {
  try { await flushResponseState(); } finally {
    clearResponseStateForTests();
    clearComboTargetCooldowns("selected");
    clearComboSelectionState("selected");
    clearKeyCooldowns(provider);
    forgetApiKeyRotationCursor(provider);
    resetProviderRequestPacingForTest();
    resetWorkflowBudgetsForTest();
    release(); home.remove();
  }
});

type FixtureTransport = "Mistral" | "ordinary keyed Chat" | "ordinary keyed Responses";
function fixture(spend: NonNullable<OcxConfig["spend"]>, rotate: boolean, combo = false, wireProtocol: FixtureTransport = "Mistral") {
  configureSharedSpendLedger(spendPolicyFromConfig(spend, undefined, combo ? [provider, "earlier"] : [provider]));
  const ledger = sharedSpendLedger();
  const wire: string[] = [];
  const reservations: number[][] = [];
  const transport = resolveMistralTransport({
    adapter: wireProtocol === "ordinary keyed Responses" ? "openai-responses" : "openai-chat",
    baseUrl: wireProtocol === "Mistral" ? "https://api.mistral.ai/v1" : "https://chat.example.test/v1", authMode: "key",
    apiKey: keys[0]!.key, apiKeyPool: combo ? [keys[1]!, keys[0]!] : keys, models: ["m1"], liveModels: false,
    requestPacing: { enabled: true, keySelection: "round-robin" }, retryOn429: { enabled: false },
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const destination = input instanceof Request ? input.url : String(input);
      const path = wireProtocol === "ordinary keyed Responses" ? "/v1/responses" : "/v1/chat/completions";
      if (new URL(destination).pathname !== path) throw new Error(`Expected fixture inference at ${path}`);
      const bearer = new Headers(init?.headers).get("authorization");
      const selected = keys.find(entry => bearer === `Bearer ${entry.key}`);
      if (!selected) throw new Error("Expected one of the two fixture keys");
      wire.push(selected.id);
      reservations.push([0, 1].map(index => ledger.snapshot("identity", label(index))?.reserved ?? 0));
      return rotate && selected.id === "first"
        ? Response.json({ error: { message: "fixture key is rate limited" } }, { status: 429 })
        : wireProtocol === "ordinary keyed Responses" ? Response.json(responsesSuccess("fixture answer", "m1")) : chatSuccess("fixture answer", "m1");
    }, { preconnect: fetch.preconnect }),
  }, new MistralBudgetPacer());
  const config: OcxConfig = { port: 0, defaultProvider: provider, providers: { [provider]: transport }, spend };
  if (combo) config.combos = { selected: { strategy: "failover", targets: [{ provider, model: "m1" }] } };
  const log: RequestLogContext = { model: "", provider: "" };
  const run = async (withRoot = true) => {
    if (withRoot) {
      const admission = admitWorkflowTurn(root, "interactive");
      if (!admission?.admitted) throw new Error("Fixture root was refused before inference");
      admission.lease.release();
    }
    const request = new Request("http://localhost/v1/responses", { method: "POST",
      headers: { "content-type": "application/json", ...(withRoot ? { "x-codex-parent-thread-id": root } : {}) },
      body: JSON.stringify({ model: combo ? "combo/selected" : `${provider}/m1`, input: "hello", max_output_tokens: 16, stream: false, store: false }),
    });
    const network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected network fetch in spend fixture"); });
    try {
      const sendBudget = createInferenceSendBudget(request, log);
      const response = await handleResponses(request, config, log, { sendBudget });
      const text = await response.text();
      log.spendTracker?.settle(log.usage);
      return { status: response.status, text, chargedSends: sendBudget.used };
    } finally { network.mockRestore(); }
  };
  return { config, ledger, wire, reservations, log, run };
}

for (const transport of ["Mistral", "ordinary keyed Chat", "ordinary keyed Responses"] as const) for (const admitted of [false, true]) test(`an earlier unattributed combo booking preserves the ${transport} identity ceiling and both balances (admitted=${admitted})`, async () => {
  const f = fixture({ identity: admitted ? headroom : { maxTokens: 15 } }, false, true, transport);
  let earlierSends = 0;
  f.config.providers.earlier = { adapter: "openai-chat", baseUrl: "https://fixture.example/v1", authMode: "local", models: ["m1"], liveModels: false,
    fetch: Object.assign(async () => {
      earlierSends++;
      return Response.json({ error: { message: "temporary fixture failure" } }, { status: 503 });
    }, { preconnect: fetch.preconnect }) };
  f.config.combos!.selected!.targets.unshift({ provider: "earlier", model: "m1" });
  const response = await f.run();
  expect(earlierSends).toBe(1);
  expect(f.wire).toEqual(admitted ? ["second"] : []);
  expect(response.chargedSends).toBe(admitted ? 2 : 1);
  if (transport !== "Mistral") {
    expect(workflowBudgetSnapshot(root)?.sends).toBe(admitted ? 2 : 1);
    expect(f.log.attempts?.reduce((sum, attempt) => sum + attempt.sendCount, 0)).toBe(admitted ? 2 : 1);
    const finalPool = f.ledger.snapshot("pool", provider);
    expect([finalPool?.reserved ?? 0, finalPool?.unresolved ?? 0, finalPool?.settled ?? 0]).toEqual([0, 0, admitted ? 3 : 0]);
    if (admitted) {
      expect(response.status, response.text).toBe(200);
      expect(f.reservations[0]?.[1]).toBeGreaterThanOrEqual(16);
    }
  }
  if (admitted) expect(f.ledger.snapshot("identity", label(1))).toMatchObject({ reserved: 0, unresolved: 0, settled: 3 });
  else expect(listWorkflowBudgetEvents(1)[0]).toMatchObject({ reason: "workflow-spend-exhausted", spendScope: "identity" });
  const balance = f.ledger.snapshot("pool", "earlier");
  expect(balance?.reserved).toBe(0);
  expect(balance?.unresolved).toBeGreaterThan(0);
});

test("native Chat books one ledger entry for an ordinary keyed Chat combo send", async () => {
  const f = fixture({ identity: headroom }, false, true, "ordinary keyed Chat");
  f.config.protocols = { rollout: { nativeChatCombos: true } };
  const admission = admitWorkflowTurn(root, "interactive");
  if (!admission?.admitted) throw new Error("Fixture root refused");
  admission.lease.release();
  const request = new Request("http://localhost/v1/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", "x-codex-parent-thread-id": root },
    body: JSON.stringify({ model: "combo/selected", messages: [{ role: "user", content: "fixture" }], max_tokens: 16 }) });
  const network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected network fetch"); });
  try {
    const response = await handleChatCompletions(request, f.config, f.log);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(protocolTraceForRequest(f.log, f.log.attempts)?.requestPath).toEqual(["chat", "chat"]);
    expect(f.wire).toEqual(["second"]);
    f.log.spendTracker?.settle(f.log.usage);
    const journal = await Bun.file(home.path("spend-ledger.jsonl")).text();
    const dispatched = journal.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.kind === "dispatch");
    expect(dispatched).toHaveLength(1);
    expect(workflowBudgetSnapshot(root)?.sends).toBe(1);
    for (const [scope, id] of [["identity", label(1)], ["pool", provider], ["root", root]] as const)
      expect(f.ledger.snapshot(scope, id)).toMatchObject({ reserved: 0, unresolved: 0, settled: 3 });
  } finally { network.mockRestore(); }
});

test("cancelling a native Chat combo during Mistral pacing records no spend or attempt", async () => {
  const f = fixture(combined, false, true);
  const abort = new AbortController();
  let wires = 0, waits = 0;
  const pacer = new MistralBudgetPacer(() => 0, async (_delay, signal) => {
    waits++;
    abort.abort(); signal?.throwIfAborted();
  });
  const row = resolveMistralTransport({ adapter: "openai-chat", baseUrl: "https://api.mistral.ai/v1", authMode: "key",
    apiKey: keys[0]!.key, liveModels: false, models: ["m1"],
    fetch: Object.assign(async () => {
      wires++;
      return new Response(null, { headers: { "retry-after": "1", "x-ratelimit-remaining-req-minute": "0" } });
    }, { preconnect: fetch.preconnect }) }, pacer);
  // Model a prior response requiring the next send on this key/model to wait.
  await row.fetch!("https://api.mistral.ai/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${row.apiKey}` }, body: JSON.stringify({ model: "m1" }) });
  f.config.providers[provider] = row;
  f.config.protocols = { rollout: { nativeChatCombos: true } };
  const admission = admitWorkflowTurn(root, "interactive");
  if (!admission?.admitted) throw new Error("Fixture root refused");
  admission.lease.release();
  const request = new Request("http://localhost/v1/chat/completions", { method: "POST", signal: abort.signal,
    headers: { "content-type": "application/json", "x-codex-parent-thread-id": root },
    body: JSON.stringify({ model: "combo/selected", messages: [{ role: "user", content: "fixture" }], max_tokens: 16 }) });
  const network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected network fetch"); });
  try {
    const response = await handleChatCompletions(request, f.config, f.log);
    await response.text(); f.log.spendTracker?.settle(undefined);
    expect(waits).toBe(1);
    expect(wires).toBe(1); // Only the prior request.
    expect(response.status).toBe(499);
    const balance = f.ledger.snapshot("pool", provider);
    expect({ unresolved: balance?.unresolved ?? 0, settled: balance?.settled ?? 0, reserved: balance?.reserved ?? 0,
      sends: workflowBudgetSnapshot(root)?.sends, attempts: f.log.attempts?.reduce((sum, a) => sum + a.sendCount, 0) ?? 0 })
      .toEqual({ unresolved: 0, settled: 0, reserved: 0, sends: 0, attempts: 0 });
  } finally { network.mockRestore(); }
});

test("translated Mistral reserves the first and rotated keys separately within one pool and root", async () => {
  const f = fixture(combined, true);
  const response = await f.run();
  expect(response.status, response.text).toBe(200);
  expect(response.text).toContain("fixture answer");
  expect(f.wire).toEqual(["first", "second"]);
  const booked = f.reservations[0]![0]!;
  expect(booked).toBeGreaterThanOrEqual(16);
  expect(f.reservations[0]).toEqual([booked, 0]);
  expect(f.reservations[1]?.[0]).toBe(booked);
  expect(f.reservations[1]?.[1]).toBeGreaterThanOrEqual(16);
  expect(f.ledger.snapshot("identity", label(0))).toMatchObject({ reserved: 0, unresolved: booked, settled: 0 });
  expect(f.ledger.snapshot("identity", label(1))).toMatchObject({ reserved: 0, unresolved: 0, settled: 3 });
  for (const [scope, id] of [["pool", provider], ["root", root]] as const)
    expect(f.ledger.snapshot(scope, id)).toMatchObject({ reserved: 0, unresolved: booked, settled: 3 });
  expect(workflowBudgetSnapshot(root)?.sends).toBe(2);
});

for (const [policy, admitted] of [[{ identity: headroom }, true], [{ identity: { maxTokens: 15 } }, false], [{}, true]] as const) test(`Mistral combo first send accounts for the selected key with ${"identity" in policy ? `a ${policy.identity.maxTokens}-token ceiling` : "no ceiling"}`, async () => {
  // Round-robin selects the second key, not the configured default. No pool or root token ceiling applies.
  const f = fixture(policy, false, true);
  const response = await f.run();
  expect(f.wire).toEqual(admitted ? ["second"] : []);
  expect(response.status, response.text).toBe(admitted ? 200 : 429);
  expect(response.chargedSends).toBe(admitted ? 1 : 0);
  expect(workflowBudgetSnapshot(root)?.sends).toBe(admitted ? 1 : 0);
  expect(f.log.attempts?.reduce((total, attempt) => total + attempt.sendCount, 0)).toBe(admitted ? 1 : 0);
  if (admitted) {
    expect(f.reservations[0]?.[1]).toBeGreaterThanOrEqual(16);
    expect(f.reservations[0]?.[0]).toBe(0);
    expect(f.ledger.snapshot("identity", label(1))).toMatchObject({ reserved: 0, unresolved: 0, settled: 3 });
  } else {
    expect(listWorkflowBudgetEvents(1)[0]).toMatchObject({ rootId: root, reason: "workflow-spend-exhausted", spendScope: "identity" });
  }
  for (const [scope, id] of [["pool", provider], ["root", root]] as const) {
    const balance = f.ledger.snapshot(scope, id);
    expect([balance?.reserved ?? 0, balance?.unresolved ?? 0, balance?.settled ?? 0]).toEqual([0, 0, admitted ? 3 : 0]);
  }
});

for (const scope of ["pool", "root"] as const) test(`translated Mistral retains the ${scope} ceiling when the selected key has room`, async () => {
  const f = fixture({ ...combined, [scope]: { maxTokens: 15 } }, false);
  const response = await f.run(); // The requested output alone reserves 16 tokens.
  expect(response.status, response.text).toBe(429);
  expect(listWorkflowBudgetEvents(1)[0]).toMatchObject({ rootId: root, reason: "workflow-spend-exhausted", spendScope: scope });
  expect(f.wire).toEqual([]);
  expect(workflowBudgetSnapshot(root)?.sends).toBe(0);
});

for (const [description, rotate, withRoot] of [
  ["first key", false, true], ["rotated key", true, true], ["first key without a pool or root ceiling", false, false],
] as const) test(`translated Mistral refuses the ${description} at its own ceiling without logging an unsent attempt`, async () => {
  const f = fixture(withRoot ? combined : { identity: headroom }, rotate);
  const identityId = label(rotate ? 1 : 0);
  const sendId = "fixture-prior-usage";
  expect(f.ledger.reserve({ sendId, scopes: { identityId }, inputTokens: headroom.maxTokens, outputCeilingTokens: 0 }).reserved).toBe(true);
  expect(f.ledger.markDispatched(sendId)).toBe(true);
  expect(f.ledger.settle(sendId, { inputTokens: headroom.maxTokens, outputTokens: 0 })).toBe(true);
  const response = await f.run(withRoot);
  expect(f.wire).toEqual(rotate ? ["first"] : []);
  expect(response.status, response.text).toBe(429);
  expect(f.log.localTerminalReason).toBe("workflow_spend_exhausted");
  expect(f.log.accountLogLabel).toBe(rotate ? label(0) : undefined);
  expect(f.log.attempts?.reduce((total, attempt) => total + attempt.sendCount, 0)).toBe(f.wire.length);
  expect(f.ledger.snapshot("identity", identityId)).toMatchObject({ reserved: 0, unresolved: 0, settled: headroom.maxTokens });
  if (withRoot) {
    expect(workflowBudgetSnapshot(root)?.sends).toBe(f.wire.length);
    expect(listWorkflowBudgetEvents(1)[0]).toMatchObject({ rootId: root, reason: "workflow-spend-exhausted", spendScope: "identity" });
  }
});
