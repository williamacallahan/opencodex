/** Muse Code reads its roster at /muse-code/models; the hub answers with the policy-filtered /v1/models list. */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SERVER_BUDGET_MS);

const API_KEY = "muse-code-models-admission";
const previous = { home: process.env.OPENCODEX_HOME, apiToken: process.env.OPENCODEX_API_AUTH_TOKEN };
let testHome = "";
let codexHome: IsolatedCodexHome | null = null;
let server: ReturnType<typeof startServer> | null = null;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-muse-code-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = API_KEY;
  codexHome = installIsolatedCodexHome("ocx-muse-code-codex-");
});

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
  codexHome?.restore();
  for (const [key, value] of [["OPENCODEX_HOME", previous.home], ["OPENCODEX_API_AUTH_TOKEN", previous.apiToken]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await removeTreeAfterBackgroundWork(testHome);
});

test("/muse-code/models serves the /v1/models list, without a disabled row, and needs the data-plane key", async () => {
  saveConfig({
    port: 0,
    hostname: "0.0.0.0",
    runtimeRole: "hub",
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, liveModels: false, models: ["on", "off"] } },
    disabledModels: ["mock/off"],
    clientIntegrations: { codex: false },
    webSearchSidecar: { enabled: false },
  } as OcxConfig);
  server = startServer(0);
  const auth = { authorization: `Bearer ${API_KEY}` };
  const muse = await fetch(new URL("/muse-code/models", server.url), { headers: auth });
  expect(muse.status).toBe(200);
  const body = await muse.json() as { data: { id: string }[] };
  const ids = body.data.map(row => row.id);
  expect(ids).toContain("mock/on");
  expect(ids).not.toContain("mock/off");
  const v1 = await (await fetch(new URL("/v1/models", server.url), { headers: auth })).json() as { data: { id: string }[] };
  expect(ids).toEqual(v1.data.map(row => row.id));
  expect((await fetch(new URL("/muse-code/models", server.url))).status).toBe(401);
});
