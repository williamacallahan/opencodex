/** A client that names a switched-off model is refused; hub-chosen destinations may still use a disabled row. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleResponses } from "../../src/server/responses";
import { filterCatalogVisibleModels } from "../../src/codex/catalog/model-visibility";
import { internalCallCapability } from "../../src/lib/local-internal-call-capability";
import { registerAdvisorAdmissionPolicy, SIDECAR_ADMISSION_POLICY_HEADER, SIDECAR_INTERNAL_CAPABILITY_HEADER } from "../../src/server/advisor-admission-scope";
import { captureAdmissionPolicy } from "../../src/server/capture-admission-policy";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import type { OcxConfig } from "../../src/types";

let sends: string[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let home = "";
let releaseSpendHome = () => {};
const previousHome = { ocx: process.env.OPENCODEX_HOME, codex: process.env.CODEX_HOME };

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-disabled-model-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json() as { model?: string };
      sends.push(String(body.model));
      return Response.json({
        id: "chatcmpl-fixture", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});
afterAll(() => {
  upstream.stop(true);
  releaseSpendHome();
  for (const [name, value] of [["OPENCODEX_HOME", previousHome.ocx], ["CODEX_HOME", previousHome.codex]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  removeTreeWithRetry(home);
});
beforeEach(() => { sends = []; clearComboSelectionState(); clearComboTargetCooldowns(); });

function fixtureConfig(extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "fix",
    providers: {
      fix: {
        adapter: "openai-chat", authMode: "key", apiKey: "synthetic", baseUrl: `${upstream.url}v1`,
        allowPrivateNetwork: true, models: ["on", "off", "vendor/off2"],
      },
    },
    disabledModels: ["fix/off", "fix/vendor/off2"],
    ...extra,
  };
}

const ctx = () => ({ model: "", provider: "" });
const chat = (config: OcxConfig, model: string) => handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
}), config, ctx());
const responses = (config: OcxConfig, model: string, headers: Record<string, string> = {}) => handleResponses(new Request("http://localhost/v1/responses", {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model, input: "hi", stream: false }),
}), config, ctx());

describe("client-named disabled model", () => {
  test("chat completions refuses a disabled row with 404 model_disabled and sends nothing upstream", async () => {
    for (const model of ["fix/off", "fix/vendor/off2"]) {
      const response = await chat(fixtureConfig(), model);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error", code: "model_disabled" } });
    }
    expect(sends).toEqual([]);
  });

  test("chat completions serves the enabled sibling", async () => {
    const response = await chat(fixtureConfig(), "fix/on");
    expect(response.status).toBe(200);
    expect(sends).toEqual(["on"]);
  });

  test("responses refuses a disabled row and serves the enabled one", async () => {
    const refused = await responses(fixtureConfig(), "fix/off");
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ error: { code: "model_disabled" } });
    expect(sends).toEqual([]);
    expect((await responses(fixtureConfig(), "fix/on")).status).toBe(200);
  });

  test("a combo target that is a disabled row is still served: the combo, not the client, named it", async () => {
    const config = fixtureConfig({ combos: { pool: { strategy: "failover", targets: [{ provider: "fix", model: "off" }] } } });
    const response = await responses(config, "combo/pool");
    expect(response.status).toBe(200);
    expect(sends).toEqual(["off"]);
  });

  test("a memory-phase destination that is a disabled row is still served", async () => {
    const config = fixtureConfig({ memoryModels: { extract: { model: "fix/off" } } });
    const metadata = JSON.stringify({ request_kind: "memory", thread_source: "memory_consolidation" });
    const response = await responses(config, "gpt-5.6-luna", { "x-codex-turn-metadata": metadata });
    expect(response.status).toBe(200);
    expect(sends).toEqual(["off"]);
  });

  test("a client-named disabled combo is refused by its alias or canonical id; an enabled combo is served", async () => {
    const combos = { pool: { alias: "pool-alias", strategy: "failover" as const, targets: [{ provider: "fix", model: "on" }] } };
    for (const stored of ["combo/pool", "pool-alias"]) {
      const refused = await responses(fixtureConfig({ combos, disabledModels: [stored] }), "combo/pool");
      expect(refused.status, stored).toBe(404);
      expect(await refused.json()).toMatchObject({ error: { code: "model_disabled" } });
    }
    expect(sends).toEqual([]);
    expect((await responses(fixtureConfig({ combos }), "combo/pool")).status).toBe(200);
  });

  test("a row outside the provider's selectedModels allowlist is hidden by the catalog and refused by name", async () => {
    const config = fixtureConfig({ disabledModels: [] });
    config.providers.fix!.selectedModels = ["on"];
    const rows = [{ provider: "fix", id: "on" }, { provider: "fix", id: "other" }] as never[];
    expect(filterCatalogVisibleModels(rows, config).map(row => (row as { id: string }).id)).toEqual(["on"]);
    const refused = await chat(config, "fix/other");
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ error: { code: "model_disabled" } });
    expect((await chat(config, "fix/on")).status).toBe(200);
    expect(sends).toEqual(["on"]);
  });

  test("a legacy encoded disabledModels slug refuses the same row the catalog hides", async () => {
    const config = fixtureConfig({ disabledModels: ["fix/vendor-off2"] });
    const rows = [{ provider: "fix", id: "vendor/off2" }] as never[];
    expect(filterCatalogVisibleModels(rows, config)).toEqual([]);
    expect((await chat(config, "fix/vendor/off2")).status).toBe(404);
  });

  test("a sidecar call carrying the internal capability may name a disabled row (vision and role-sizing models)", async () => {
    const config = fixtureConfig();
    const registration = registerAdvisorAdmissionPolicy(captureAdmissionPolicy(config));
    try {
      const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIDECAR_ADMISSION_POLICY_HEADER]: registration.token,
          [SIDECAR_INTERNAL_CAPABILITY_HEADER]: internalCallCapability(),
        },
        body: JSON.stringify({ model: "fix/off", messages: [{ role: "user", content: "hi" }] }),
      }), config, ctx());
      expect(response.status).toBe(200);
      expect(sends).toEqual(["off"]);
    } finally { registration.release(); }
    // The same request without the capability is an ordinary client and is refused.
    expect((await chat(config, "fix/off")).status).toBe(404);
  });
});
