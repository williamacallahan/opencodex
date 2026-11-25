import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { buildOpenAIChatPassthroughRequest } from "../../src/adapters/openai-chat/passthrough";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { getDefaultConfig } from "../../src/config";
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

function responsesWire(provider: OcxProviderConfig, model: string): Record<string, unknown> {
  const budget = createTranslatorBudget();
  const request = createResponsesPassthroughAdapter(provider).buildRequest(
    parseRequest({ model, input: "hi", stream: true, ...sampling }),
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
});
