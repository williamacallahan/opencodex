/** A provider PATCH either stores every field it names or says which it refused; it never answers 200 and drops one. */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { providerConfigSchema } from "../../src/config/schema/leaf-validators";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { startServer } from "../../src/server";
import type { OcxProviderConfig } from "../../src/types";
import { managementFetch as fetch } from "../helpers/management-auth";
import { config } from "../helpers/management-relative-send-paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";

setDefaultTimeout(60_000);

const previousHome = process.env.OPENCODEX_HOME;
let home = "";

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

async function withRelay(run: (patch: (body: unknown) => Promise<Response>) => Promise<void>): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "ocx-provider-patch-fields-"));
  process.env.OPENCODEX_HOME = home;
  const base = config("127.0.0.1");
  const relay: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://relay.example/v1" };
  saveConfig({ ...base, providers: { ...base.providers, relay } });
  const server = startServer(0);
  const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  try {
    await run(body => fetch(new URL("/api/providers?name=relay", server.url), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  } finally {
    resolved.mockRestore();
    await server.stop(true);
  }
}

describe("provider PATCH field mask", () => {
  test("rejects nonfinite and out-of-range sampling settings at config load", () => {
    for (const record of [{ " ": { topP: 1 } }, { m: { temperature: Infinity } }, { m: { temperature: -0.1 } }, { m: { topP: 1.1 } }]) {
      expect(providerConfigSchema.safeParse({ adapter: "openai-chat", baseUrl: "https://example.test", modelSamplingDefaults: record }).success).toBe(false);
    }
  });
  test("refuses a field it would drop and stores nothing from that request", async () => {
    await withRelay(async patch => {
      const response = await patch({ modelContextWindows: { "relay-model": 200_000 }, modelMaxOutputTokens: { "relay-model": 8_000 } });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "unrecognized provider fields: modelMaxOutputTokens" });
      expect(loadConfig().providers.relay?.modelContextWindows).toBeUndefined();
    });
  });

  test("validates and persists per-model sampling defaults", async () => {
    await withRelay(async patch => {
      expect((await patch({ modelSamplingDefaults: { model: { temperature: 1, topP: 1 } } })).status).toBe(200);
      expect(loadConfig().providers.relay?.modelSamplingDefaults).toEqual({ model: { temperature: 1, topP: 1 } });
      expect((await patch({ modelSamplingDefaults: { other: { temperature: 0 } } })).status).toBe(200);
      expect(loadConfig().providers.relay?.modelSamplingDefaults).toEqual({ model: { temperature: 1, topP: 1 }, other: { temperature: 0 } });
      for (const invalid of [{ " ": { temperature: 1 } }, { model: { temperature: 3 } }, { model: { topP: -1 } }]) {
        expect((await patch({ modelSamplingDefaults: invalid })).status).toBe(400);
      }
      expect((await patch({ modelSamplingDefaults: { model: null } })).status).toBe(200);
      expect(loadConfig().providers.relay?.modelSamplingDefaults).toEqual({ other: { temperature: 0 } });
    });
  });

  test("stores promptCacheKey and clears it with null", async () => {
    await withRelay(async patch => {
      expect((await patch({ promptCacheKey: true })).status).toBe(200);
      expect(loadConfig().providers.relay?.promptCacheKey).toBe(true);
      expect((await patch({ promptCacheKey: null })).status).toBe(200);
      expect(loadConfig().providers.relay).not.toHaveProperty("promptCacheKey");
    });
  });
});
