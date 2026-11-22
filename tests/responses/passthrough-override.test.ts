import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { selectForwardHeaders } from "../../src/server/ws-bridge";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const forwardProvider = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const };

test("Responses effort maps work without a ladder and omit only the mapped effort", () => {
  const model = "custom-test-reasoner";
  const build = (settings: Partial<OcxProviderConfig>, effort = "xhigh") => {
    const adapter = createResponsesPassthroughAdapter({ adapter: "openai-responses", baseUrl: "https://relay.example/v1", ...settings });
    const request = adapter.buildRequest({ modelId: model, stream: false, context: { messages: [] }, options: {},
      _rawBody: { model, input: "hi", reasoning: { effort, summary: "auto" } } }, { headers: new Headers() });
    return { reasoning: JSON.parse(String(request.body)).reasoning, log: request.reasoningLog };
  };
  expect(build({ reasoningEffortMap: { xhigh: "high" } })).toEqual({
    reasoning: { effort: "high", summary: "auto" }, log: { effectiveEffort: "high", wireField: "reasoning.effort", wireValue: "high" },
  });
  expect(build({ modelReasoningEffortMap: { [model]: { xhigh: "__omit__" } } })).toEqual({ reasoning: { summary: "auto" }, log: undefined });
  expect(build({ reasoningEfforts: ["high"], reasoningEffortMap: { high: "__omit__" } })).toEqual({ reasoning: { summary: "auto" }, log: undefined });
  expect(build({ reasoningEffortMap: { xhigh: "high" } }, "provider-specific")).toEqual({ reasoning: { effort: "provider-specific", summary: "auto" }, log: undefined });
});

describe("Responses sampling defaults", () => {
  test("fills missing values without replacing explicit sampling and preserves canonical stripping", () => {
    const model = "deepseek-v4-1-flash-1017";
    const defaults = { [model]: { temperature: 1, topP: 1 } };
    const build = (provider: OcxProviderConfig, sampling: Record<string, number> = {}) => {
      const adapter = createResponsesPassthroughAdapter(provider);
      const request = adapter.buildRequest({ modelId: model, stream: false, context: { messages: [] }, options: {},
        _rawBody: { model, input: "hi", ...sampling } }, { headers: new Headers() });
      return JSON.parse(String(request.body));
    };
    const provider = { ...forwardProvider, authMode: undefined, baseUrl: "https://relay.example/v1", modelSamplingDefaults: defaults };
    expect(build(provider)).toMatchObject({ temperature: 1, top_p: 1 });
    expect(build(provider, { temperature: 0, top_p: 0.2 })).toMatchObject({ temperature: 0, top_p: 0.2 });
    expect(build({ ...forwardProvider, modelSamplingDefaults: defaults })).not.toHaveProperty("temperature");
    expect(build({ ...forwardProvider, modelSamplingDefaults: defaults })).not.toHaveProperty("top_p");
  });
});

describe("passthrough token override", () => {
  test("buildRequest uses original auth when no override", () => {
    const adapter = createResponsesPassthroughAdapter(forwardProvider);
    const headers = new Headers({ authorization: "Bearer original", "chatgpt-account-id": "main_acc" });
    const req = adapter.buildRequest({ modelId: "gpt-5.3", input: [], _rawBody: {} }, { headers });
    expect(req.headers["authorization"]).toBe("Bearer original");
    expect(req.headers["chatgpt-account-id"]).toBe("main_acc");
  });

  test("buildRequest replaces auth when _codexAccountOverride present", () => {
    const override = { accessToken: "pool_token", chatgptAccountId: "pool_acc" };
    const provider = { ...forwardProvider, _codexAccountOverride: override } as typeof forwardProvider;
    const adapter = createResponsesPassthroughAdapter(provider);
    const headers = new Headers({ authorization: "Bearer original", "chatgpt-account-id": "main_acc" });
    const req = adapter.buildRequest({ modelId: "gpt-5.3", input: [], _rawBody: {} }, { headers });
    expect(req.headers["authorization"]).toBe("Bearer pool_token");
    expect(req.headers["chatgpt-account-id"]).toBe("pool_acc");
  });

  test("buildRequest rejects pool-required provider before copying inbound auth", () => {
    const provider = { ...forwardProvider, _codexAccountRequired: true } as typeof forwardProvider;
    const adapter = createResponsesPassthroughAdapter(provider);
    const headers = new Headers({ authorization: "Bearer original", "chatgpt-account-id": "main_acc" });
    expect(() => adapter.buildRequest({ modelId: "gpt-5.3", input: [], _rawBody: {} }, { headers }))
      .toThrow("Codex pool account auth is required");
  });

  test("selectForwardHeaders works without override (backward compat)", () => {
    const headers = new Headers({ authorization: "Bearer test", "chatgpt-account-id": "acc" });
    const selected = selectForwardHeaders(headers);
    expect(selected.get("authorization")).toBe("Bearer test");
    expect(selected.get("chatgpt-account-id")).toBe("acc");
  });

  test("selectForwardHeaders applies override after forwarding", () => {
    const headers = new Headers({ authorization: "Bearer original", "chatgpt-account-id": "main" });
    const selected = selectForwardHeaders(headers, { accessToken: "override_tk", chatgptAccountId: "override_acc" });
    expect(selected.get("authorization")).toBe("Bearer override_tk");
    expect(selected.get("chatgpt-account-id")).toBe("override_acc");
  });
});
