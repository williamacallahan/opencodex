import { describe, expect, test } from "bun:test";
import { catalogHintsFromModelsApiItem } from "../../src/codex/catalog/provider-fetch";

describe("models-API reasoning ladder fields", () => {
  test("reads the codex-lb metadata ladder and default", () => {
    expect(catalogHintsFromModelsApiItem("codex-lb", {
      id: "gpt-6-luna",
      metadata: {
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" },
        ],
      },
      capabilities: { reasoning_effort: null, supports_reasoning: true },
    })).toMatchObject({
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
    });
  });

  test("keeps ultra from the codex-lb metadata ladder", () => {
    expect(catalogHintsFromModelsApiItem("codex-lb", {
      id: "gpt-6-sol",
      metadata: { supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }] },
    }).reasoningEfforts).toEqual(["low", "ultra"]);
  });

  test("reads the LLM gateway ladder and default", () => {
    expect(catalogHintsFromModelsApiItem("gateway", {
      id: "kimi-k3.1",
      capabilities: { reasoning: { effort_levels: ["low", "high", "max"], default_effort: "high" } },
    })).toMatchObject({ reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high" });
  });

  test("leaves none and minimal out of a published ladder", () => {
    expect(catalogHintsFromModelsApiItem("gateway", {
      id: "deepseek/deepseek-v4.1-flash",
      capabilities: { reasoning: { effort_levels: ["none", "low", "high", "max"], default_effort: "high" } },
    })).toMatchObject({ reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high" });
    expect(catalogHintsFromModelsApiItem("gateway", {
      id: "muse-spark",
      capabilities: { reasoning: { effort_levels: ["minimal", "low", "medium", "high", "xhigh"], default_effort: "minimal" } },
    })).toEqual(expect.objectContaining({ reasoningEfforts: ["low", "medium", "high", "xhigh"] }));
    expect(catalogHintsFromModelsApiItem("gateway", {
      id: "muse-spark",
      capabilities: { reasoning: { effort_levels: ["minimal", "low", "medium", "high", "xhigh"], default_effort: "minimal" } },
    })).not.toHaveProperty("defaultReasoningEffort");
  });

  test("treats a ladder of only none and minimal as absent", () => {
    expect(catalogHintsFromModelsApiItem("gateway", {
      id: "sentinel-only-model",
      capabilities: { reasoning: { effort_levels: ["none", "minimal"] } },
    })).not.toHaveProperty("reasoningEfforts");
  });

  test("treats an empty gateway ladder as absent", () => {
    const hints = catalogHintsFromModelsApiItem("gateway", {
      id: "no-effort-model",
      capabilities: { reasoning: { effort_levels: [], default_effort: "low" } },
    });
    expect(hints).not.toHaveProperty("reasoningEfforts");
    expect(hints).not.toHaveProperty("defaultReasoningEffort");
  });

  test("treats a ladder with no recognized rung as absent", () => {
    const hints = catalogHintsFromModelsApiItem("gateway", {
      id: "toggle-only-model",
      capabilities: { reasoning: { effort_levels: ["on", "off"], default_effort: "on" } },
    });
    expect(hints).not.toHaveProperty("reasoningEfforts");
    expect(hints).not.toHaveProperty("defaultReasoningEffort");
  });

  test("falls through an empty metadata ladder to the gateway ladder", () => {
    expect(catalogHintsFromModelsApiItem("gateway", {
      id: "metadata-empty-fallback-model",
      metadata: { supported_reasoning_levels: [] },
      capabilities: { reasoning: { effort_levels: ["low", "high"] } },
    }).reasoningEfforts).toEqual(["low", "high"]);
  });

  test("keeps existing ladder fields ahead of the codex-lb metadata ladder", () => {
    expect(catalogHintsFromModelsApiItem("gateway", {
      id: "precedence-model",
      capabilities: { reasoning_effort: ["low", "high"] },
      metadata: { supported_reasoning_levels: ["medium", "max"] },
    }).reasoningEfforts).toEqual(["low", "high"]);
  });

  test("drops a default that is not in the selected ladder", () => {
    expect(catalogHintsFromModelsApiItem("gateway", {
      id: "invalid-default-model",
      capabilities: { reasoning: { effort_levels: ["low", "high"], default_effort: "max" } },
    })).not.toHaveProperty("defaultReasoningEffort");
  });

  test("reads gateway capabilities when metadata capabilities shadow them", () => {
    expect(catalogHintsFromModelsApiItem("gateway", {
      id: "shadowed-capabilities-model",
      capabilities: { reasoning: { effort_levels: ["low", "high"], default_effort: "high" } },
      metadata: { capabilities: { supports_reasoning: true } },
    })).toMatchObject({ reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" });
  });

  test("omits reasoning ladder fields when the row publishes none", () => {
    expect(catalogHintsFromModelsApiItem("gateway", { id: "plain-model" })).not.toHaveProperty("reasoningEfforts");
  });
});
