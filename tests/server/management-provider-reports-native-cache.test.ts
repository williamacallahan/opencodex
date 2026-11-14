/** reportsNativeCache survives a dashboard save and is settable by PATCH. */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { startServer } from "../../src/server";
import type { OcxProviderConfig } from "../../src/types";
import { managementFetch as fetch } from "../helpers/management-auth";
import { config } from "../helpers/management-relative-send-paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";

setDefaultTimeout(60_000);

const BASE_URL = "https://relay.example/backend-api/codex";
const previousHome = process.env.OPENCODEX_HOME;
let home = "";

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

async function withServer(provider: OcxProviderConfig, run: (url: URL) => Promise<void>): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "ocx-provider-native-cache-"));
  process.env.OPENCODEX_HOME = home;
  const base = config("127.0.0.1");
  saveConfig({ ...base, providers: { ...base.providers, relay: provider } });
  const server = startServer(0);
  const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  try {
    await run(server.url);
  } finally {
    resolved.mockRestore();
    await server.stop(true);
  }
}

function send(url: URL, path: string, method: "PATCH" | "POST", body: unknown): Promise<Response> {
  return fetch(new URL(path, url), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const relay: OcxProviderConfig = { adapter: "openai-responses", baseUrl: BASE_URL, reportsNativeCache: true };

describe("reportsNativeCache management", () => {
  test("a same-destination dashboard save keeps the flag", async () => {
    await withServer(relay, async url => {
      const response = await send(url, "/api/providers", "POST", {
        name: "relay", provider: { adapter: "openai-responses", baseUrl: BASE_URL, note: "edited" },
      });
      expect(response.status).toBe(200);
      expect(loadConfig().providers.relay).toMatchObject({ note: "edited", reportsNativeCache: true });
    });
  });

  test("PATCH sets, clears, and refuses a non-boolean", async () => {
    await withServer({ adapter: "openai-responses", baseUrl: BASE_URL }, async url => {
      expect((await send(url, "/api/providers?name=relay", "PATCH", { reportsNativeCache: true })).status).toBe(200);
      expect(loadConfig().providers.relay?.reportsNativeCache).toBe(true);
      const reject = await send(url, "/api/providers?name=relay", "PATCH", { reportsNativeCache: "yes" });
      expect(reject.status).toBe(400);
      expect(loadConfig().providers.relay?.reportsNativeCache).toBe(true);
      expect((await send(url, "/api/providers?name=relay", "PATCH", { reportsNativeCache: null })).status).toBe(200);
      expect(loadConfig().providers.relay).not.toHaveProperty("reportsNativeCache");
    });
  });

  test("POST refuses a string value", async () => {
    await withServer(relay, async url => {
      const response = await send(url, "/api/providers", "POST", {
        name: "relay", provider: { adapter: "openai-responses", baseUrl: BASE_URL, reportsNativeCache: "true" },
      });
      expect(response.status).toBe(400);
      expect(loadConfig().providers.relay?.reportsNativeCache).toBe(true);
    });
  });
});
