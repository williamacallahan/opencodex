import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { buildOpenAIChatPassthroughRequest } from "../../src/adapters/openai-chat/passthrough";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { getDefaultConfig } from "../../src/config";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { configureSharedSpendLedger, sharedSpendLedger, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { parseRequest } from "../../src/responses/parser";
import { handleResponsesCompact } from "../../src/server/responses";
import { baseCompactionBody, compactionRequest, removeCompactionFixture } from "../helpers/compaction-routing-fixtures";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxProviderConfig } from "../../src/types";

// A deny list names the catalog id ("k3.1-pro"); the routed selector can carry a bracketed
// context suffix that the adapter strips only when it serializes the wire model.
const deny = { noTemperatureModels: ["k3.1-pro"], noTopPModels: ["k3.1-pro"] };
const bracketed = "k3.1-pro[256k]";
const sampling = { temperature: 0.3, top_p: 0.9 };

function responsesWire(provider: OcxProviderConfig, model: string, controls: Record<string, unknown> = sampling): Record<string, unknown> {
  const budget = createTranslatorBudget();
  const request = createResponsesPassthroughAdapter(provider).buildRequest(
    parseRequest({ model, input: "hi", stream: true, ...controls }),
    { headers: new Headers({ authorization: "Bearer caller-fixture" }), translatorBudget: budget },
  );
  request.releaseBodyObservation?.();
  budget.dispose();
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("sampling deny lists match the serialized wire model", () => {
  test("Responses drops listed fields for a bracket-suffixed selector", () => {
    const body = responsesWire({ adapter: "openai-responses", baseUrl: "https://api.kimi.com/coding/v1",
      authMode: "key", apiKey: "fixture", modelSuffixBracketStrip: true, ...deny }, bracketed);
    expect(body.model).toBe("k3.1-pro");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
  });

  test("a custom forward gateway honors the list and keeps an unlisted model's settings", () => {
    const gateway: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://gateway.fixture.test/v1",
      authMode: "forward", ...deny };
    const listed = responsesWire(gateway, "k3.1-pro");
    expect(listed).not.toHaveProperty("temperature");
    expect(listed).not.toHaveProperty("top_p");
    expect(responsesWire(gateway, "other-model")).toMatchObject(sampling);
  });

  test("a Reserve-only penalty entry applies to the Reserve move and not to the ordinary Luna send", () => {
    // The pool Reserve rewrite turns gpt-6-luna into gpt-reserve on the canonical backend; only the
    // rewritten id is listed, so only the moved send may lose the penalty.
    const canonical = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward", noPenaltyModels: ["gpt-reserve"] } as OcxProviderConfig;
    const seat = { accessToken: "seat-fixture", chatgptAccountId: "acct-fixture", kind: "pool" as const };
    const penalties = { presence_penalty: 0.4, frequency_penalty: 0.2 };
    const ordinary = responsesWire({ ...canonical, _codexAccountOverride: seat } as OcxProviderConfig, "gpt-6-luna", penalties);
    const reserve = responsesWire({ ...canonical, _codexAccountOverride: { ...seat, poolReserve: true } } as OcxProviderConfig, "gpt-6-luna", penalties);
    expect(ordinary).toMatchObject({ model: "gpt-6-luna", ...penalties });
    expect(reserve.model).toBe("gpt-reserve");
    expect(reserve).not.toHaveProperty("presence_penalty");
    expect(reserve).not.toHaveProperty("frequency_penalty");
    const { model: _ordinaryModel, presence_penalty: _p, frequency_penalty: _f, ...ordinaryRest } = ordinary;
    const { model: _reserveModel, ...reserveRest } = reserve;
    expect(reserveRest).toEqual(ordinaryRest);
  });

  // Chat also carries stop and both penalties, each with its own list naming the bare id.
  const chat: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.kimi.com/coding/v1",
    authMode: "key", apiKey: "fixture", modelSuffixBracketStrip: true, ...deny,
    noStopModels: ["k3.1-pro"], noPenaltyModels: ["k3.1-pro"] };
  const chatControls = { ...sampling, stop: ["END"], presence_penalty: 0.4, frequency_penalty: 0.2 };
  const cases = [
    ["a listed", bracketed, "k3.1-pro", false],
    ["an unlisted", "other-model[256k]", "other-model", true],
  ] as const;

  test.each(cases)("native Chat applies the lists to %s bracket-suffixed selector", (_label, selector, wireModel, kept) => {
    const request = buildOpenAIChatPassthroughRequest(chat,
      { model: selector, messages: [{ role: "user", content: "hi" }], ...chatControls }, selector, false);
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.model).toBe(wireModel);
    for (const field of Object.keys(chatControls)) expect(Object.hasOwn(body, field)).toBe(kept);
  });

  test.each(cases)("translated Chat applies the lists to %s bracket-suffixed selector", (_label, selector, wireModel, kept) => {
    const request = createOpenAIChatAdapter(chat).buildRequest(
      parseRequest({ model: selector, input: "hi", stream: false, ...chatControls }));
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.model).toBe(wireModel);
    for (const field of Object.keys(chatControls)) expect([field, Object.hasOwn(body, field)]).toEqual([field, kept]);
  });
});

describe("native compact endpoint", () => {
  let home: string;
  let previousHome: string | undefined;
  let release: (() => void) | undefined;
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-compact-sampling-"));
    process.env.OPENCODEX_HOME = home;
    release = acquireOwnedSpendHome();
  });
  afterEach(async () => {
    try {
      release?.();
      globalThis.fetch = originalFetch;
      await removeCompactionFixture(home);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
    }
  });

  test.each([
    ["the same id", "gw/some-model", "some-model", "some-model", false],
    ["a bracket-suffixed selector", "gw/k3.1-pro[256k]", "k3.1-pro", "k3.1-pro", true],
  ] as const)("drops listed sampling fields from the physical compact send for %s", async (_label, selector, listed, wireModel, strip) => {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "fixture" }] });
    }) as typeof fetch;
    const provider: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://gateway.example/v1",
      authMode: "key", apiKey: "fixture", supportsNativeCompactEndpoint: true, modelSuffixBracketStrip: strip,
      noTemperatureModels: [listed], noTopPModels: [listed] };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({ ...sampling, model: selector })), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    await response.text();
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).pathname).toBe("/v1/responses/compact");
    expect(sent[0]!.body.model).toBe(wireModel);
    expect(sent[0]!.body).not.toHaveProperty("temperature");
    expect(sent[0]!.body).not.toHaveProperty("top_p");
  });

  test.each([
    ["only the suffixed id", ["gw/k3.1-pro[256k]"], 403, 0],
    ["both ids", ["gw/k3.1-pro[256k]", "gw/k3.1-pro"], 200, 1],
  ] as const)("a scoped key that allows %s is checked against the projected wire model", async (_label, allowedModels, status, sends) => {
    let upstream = 0;
    globalThis.fetch = (async () => {
      upstream++;
      return Response.json({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "fixture" }] });
    }) as typeof fetch;
    const provider: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://gateway.example/v1",
      authMode: "key", apiKey: "fixture", supportsNativeCompactEndpoint: true, modelSuffixBracketStrip: true };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider },
      apiKeys: [{ id: "scoped", name: "scoped", key: "ocx_data_" + "b".repeat(40), createdAt: "2026-11-25T00:00:00Z", allowedModels: [...allowedModels] }] };
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({ model: "gw/k3.1-pro[256k]" })), config,
      { model: "", provider: "" }, undefined, { kind: "configured", keyId: "scoped", source: "bearer" });
    expect(response.status).toBe(status);
    await response.text();
    expect(upstream).toBe(sends);
  });

  test("a compact deny entry naming only the pre-rewrite virtual id still applies", async () => {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "fixture" }] });
    }) as typeof fetch;
    const provider: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1",
      authMode: "key", apiKey: "fixture", supportsNativeCompactEndpoint: true,
      noTemperatureModels: ["gpt-5.6-sol-pro"], noTopPModels: ["gpt-5.6-sol-pro"] };
    const config = { ...getDefaultConfig(), defaultProvider: "openai-apikey", providers: { "openai-apikey": provider } };
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({ ...sampling, model: "openai-apikey/gpt-5.6-sol-pro" })),
      config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    await response.text();
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).pathname).toBe("/v1/responses/compact");
    expect(sent[0]!.body.model).toBe("gpt-5.6-sol");
    expect(sent[0]!.body).not.toHaveProperty("temperature");
    expect(sent[0]!.body).not.toHaveProperty("top_p");
  });

  test("a key scoped only to a virtual id cannot reach its wire model through native compact", async () => {
    let upstream = 0;
    globalThis.fetch = (async () => {
      upstream++;
      return Response.json({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "fixture" }] });
    }) as typeof fetch;
    const provider: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1",
      authMode: "key", apiKey: "fixture", supportsNativeCompactEndpoint: true };
    const config = { ...getDefaultConfig(), defaultProvider: "openai-apikey", providers: { "openai-apikey": provider },
      apiKeys: [{ id: "scoped", name: "scoped", key: "ocx_data_" + "c".repeat(40), createdAt: "2026-11-25T00:00:00Z",
        allowedModels: ["openai-apikey/gpt-5.6-sol-pro"] }] };
    // A local refusal spends nothing: no send slot from the workflow's allowance, and, with token
    // ceilings on, no reservation recorded as dispatched.
    configureSharedSpendLedger(spendPolicyFromConfig({ pool: { maxTokens: 100_000 } }, undefined, ["openai-apikey"]));
    const sendBudget = createRequestExecutionBudget();
    const allowance = sendBudget.remainingBaseSends(4);
    try {
      const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({ model: "openai-apikey/gpt-5.6-sol-pro" })),
        config, { model: "", provider: "" }, undefined, { kind: "configured", keyId: "scoped", source: "bearer" }, { sendBudget });
      expect(response.status).toBe(403);
      await response.text();
      expect(upstream).toBe(0);
      expect(sendBudget.used).toBe(0);
      expect(sendBudget.remainingBaseSends(4)).toBe(allowance);
      const spend = sharedSpendLedger().snapshot("pool", "openai-apikey");
      expect(spend?.reserved ?? 0).toBe(0);
      expect(spend?.unresolved ?? 0).toBe(0);
      expect(spend?.settled ?? 0).toBe(0);
    } finally {
      configureSharedSpendLedger(spendPolicyFromConfig({}));
    }
  });
});
