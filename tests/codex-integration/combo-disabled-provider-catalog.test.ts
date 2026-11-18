import { expect, test } from "bun:test";
import { gatherRoutedModels, getLastComboCatalogOmissions } from "../../src/codex/catalog";
import type { OcxConfig } from "../../src/types";

test("combo catalog derives capabilities only from enabled providers", async () => {
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "enabled",
    visionSidecar: { enabled: false },
    providers: {
      disabled: { adapter: "openai-chat", baseUrl: "https://disabled.example/v1", liveModels: false, disabled: true, models: ["m"], modelContextWindows: { m: 8_000 }, modelInputModalities: { m: ["image"] }, modelReasoningEfforts: { m: ["low"] } },
      enabled: { adapter: "openai-chat", baseUrl: "https://enabled.example/v1", liveModels: false, models: ["m"], modelContextWindows: { m: 128_000 }, modelInputModalities: { m: ["text"] }, modelReasoningEfforts: { m: ["high"] } },
    },
    combos: {
      mixed: { targets: [{ provider: "disabled", model: "m" }, { provider: "enabled", model: "m" }] },
      allDisabled: { targets: [{ provider: "disabled", model: "m" }] },
      incomplete: { targets: [{ provider: "disabled", model: "m" }, { provider: "missing", model: "m" }] },
    },
  };
  const models = await gatherRoutedModels(config);
  expect(models.find(model => model.provider === "combo" && model.id === "mixed")).toMatchObject({
    contextWindow: 128_000, inputModalities: ["text"], reasoningEfforts: ["high"],
  });
  expect(models.some(model => model.provider === "combo" && ["allDisabled", "incomplete"].includes(model.id))).toBe(false);
  expect(getLastComboCatalogOmissions()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "allDisabled", reason: "incomplete_metadata" }),
    expect.objectContaining({ id: "incomplete", reason: "incomplete_metadata" }),
  ]));
});
