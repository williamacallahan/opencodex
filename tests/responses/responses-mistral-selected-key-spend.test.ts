import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { apiKeyAccountLogLabel } from "../../src/codex/account-label";
import { clearComboTargetCooldowns } from "../../src/combos/failover";
import { clearComboSelectionState } from "../../src/combos/resolve";
import { configureSharedSpendLedger, sharedSpendLedger, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import { admitWorkflowTurn, listWorkflowBudgetEvents, resetWorkflowBudgetsForTest, workflowBudgetSnapshot } from "../../src/lib/workflow-budget";
import { clearKeyCooldowns, forgetApiKeyRotationCursor } from "../../src/providers/key-failover";
import { MistralBudgetPacer, resolveMistralTransport } from "../../src/providers/mistral-transport";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { createInferenceSendBudget } from "../../src/server/inference/context";
import type { RequestLogContext } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { chatSuccess } from "../helpers/combo-failover-upstream";
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

function fixture(spend: NonNullable<OcxConfig["spend"]>, rotate: boolean, combo = false) {
  configureSharedSpendLedger(spendPolicyFromConfig(spend, undefined, [provider]));
  const ledger = sharedSpendLedger();
  const wire: string[] = [];
  const reservations: number[][] = [];
  const transport = resolveMistralTransport({
    adapter: "openai-chat", baseUrl: "https://api.mistral.ai/v1", authMode: "key",
    apiKey: keys[0]!.key, apiKeyPool: combo ? [keys[1]!, keys[0]!] : keys, models: ["m1"], liveModels: false,
    requestPacing: { enabled: true, keySelection: "round-robin" }, retryOn429: { enabled: false },
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const destination = input instanceof Request ? input.url : String(input);
      if (new URL(destination).pathname !== "/v1/chat/completions") throw new Error("Expected translated Chat inference");
      const bearer = new Headers(init?.headers).get("authorization");
      const selected = keys.find(entry => bearer === `Bearer ${entry.key}`);
      if (!selected) throw new Error("Expected one of the two fixture keys");
      wire.push(selected.id);
      reservations.push([0, 1].map(index => ledger.snapshot("identity", label(index))?.reserved ?? 0));
      return rotate && selected.id === "first"
        ? Response.json({ error: { message: "fixture key is rate limited" } }, { status: 429 })
        : chatSuccess("fixture answer", "m1");
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
  return { ledger, wire, reservations, log, run };
}

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
