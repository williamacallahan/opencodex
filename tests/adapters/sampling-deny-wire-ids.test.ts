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

  const chat: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.kimi.com/coding/v1",
    authMode: "key", apiKey: "fixture", modelSuffixBracketStrip: true, ...deny };

  test("native Chat drops listed fields for a bracket-suffixed selector", () => {
    const request = buildOpenAIChatPassthroughRequest(chat,
      { model: bracketed, messages: [{ role: "user", content: "hi" }], ...sampling }, bracketed, false);
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.model).toBe("k3.1-pro");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
  });

  test("translated Chat drops listed fields for a bracket-suffixed selector", () => {
    const request = createOpenAIChatAdapter(chat).buildRequest(
      parseRequest({ model: bracketed, input: "hi", stream: false, ...sampling }));
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.model).toBe("k3.1-pro");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
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

  test("drops listed sampling fields from the physical compact send", async () => {
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "fixture" }] });
    }) as typeof fetch;
    const provider: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://gateway.example/v1",
      authMode: "key", apiKey: "fixture", supportsNativeCompactEndpoint: true,
      noTemperatureModels: ["some-model"], noTopPModels: ["some-model"] };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody(sampling)), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    await response.text();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("temperature");
    expect(sent[0]).not.toHaveProperty("top_p");
  });
});
