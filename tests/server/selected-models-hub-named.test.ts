/** A selectedModels write that would hide a model the hub's own settings route clients to is refused. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearModelCache } from "../../src/codex/model-cache";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previousHome: string | undefined;
let codex: IsolatedCodexHome;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-selected-hub-named-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("ocx-selected-hub-named-codex-");
});
afterEach(() => {
  clearModelCache();
  codex.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function fixture(extra: Partial<OcxConfig>): OcxConfig {
  const config: OcxConfig = {
    port: 0, defaultProvider: "codex-lb", clientIntegrations: { codex: false },
    providers: { "codex-lb": { adapter: "openai-responses", baseUrl: "https://lb.example.test/v1", authMode: "key", apiKey: "fixture", liveModels: false, models: ["gpt-6.1-sol", "other"] } },
    ...extra,
  };
  saveConfig(config);
  return config;
}

async function select(config: OcxConfig, models: string[]): Promise<Response> {
  const url = new URL("http://localhost/api/selected-models");
  const request = new ManagementRequest(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "codex-lb", models }) });
  const response = await handleManagementAPI(request, url, config, { createManagementConvergeCodex: catalogConvergenceFactory() });
  if (!response) throw new Error("missing management route");
  return response;
}

test("an allowlist that omits a sub-agent, injection or role-tier model of the provider is refused and changes nothing", async () => {
  const config = fixture({ subagentModels: ["codex-lb/gpt-6.1-sol"], injectionModel: "codex-lb/gpt-6-astra", codexRoleTiers: { fast: ["codex-lb/gpt-6-luna"] } });
  const before = structuredClone(config);
  const response = await select(config, ["other"]);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    code: "selected_models_omit_routed_ids",
    omitted: ["codex-lb/gpt-6.1-sol", "codex-lb/gpt-6-astra", "codex-lb/gpt-6-luna"],
  });
  expect(config).toEqual(before);
});

test("an allowlist that keeps every hub-named model, or no allowlist at all, is accepted", async () => {
  const config = fixture({ subagentModels: ["codex-lb/gpt-6.1-sol", "other-provider/x"] });
  expect((await select(config, ["gpt-6.1-sol", "other"])).status).toBe(200);
  expect(config.providers["codex-lb"]!.selectedModels).toEqual(["gpt-6.1-sol", "other"]);
  // Clearing the allowlist exposes every model again and is always allowed.
  expect((await select(config, [])).status).toBe(200);
  expect(config.providers["codex-lb"]!.selectedModels).toBeUndefined();
});
