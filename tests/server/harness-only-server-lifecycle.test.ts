/**
 * The `nativeHarnessOnly` policy is process-wide and a server claims it at startup. An embedded start that fails
 * to listen must leave the previous policy in place, and a stopped server hands the policy back only while it
 * still owns it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { bindNativeHarnessConfig, nativeHarnessOnly } from "../../src/lib/native-harness";
import { startServer, waitForFailedStartRollback } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let home = "";
let codexHome: IsolatedCodexHome | null = null;

const config = (harnessOnly: boolean): OcxConfig => ({
  port: 0,
  hostname: "127.0.0.1",
  nativeHarnessOnly: harnessOnly,
  defaultProvider: "chatgpt",
  providers: { chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
} as unknown as OcxConfig);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-harness-lifecycle-"));
  process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome("ocx-harness-lifecycle-codex-");
  bindNativeHarnessConfig(null);
});

afterEach(() => {
  bindNativeHarnessConfig(null);
  codexHome?.restore();
  codexHome = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

test("a start that fails to bind leaves the running policy in place", async () => {
  bindNativeHarnessConfig({ nativeHarnessOnly: true });
  const squatter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("occupied") });
  saveConfig(config(false));
  try {
    let failure: unknown;
    try { startServer(squatter.port!); } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    await waitForFailedStartRollback(failure);
    expect(nativeHarnessOnly()).toBe(true);
  } finally {
    await squatter.stop(true);
  }
});

test("a stopped server hands the policy back only while it still owns it", async () => {
  bindNativeHarnessConfig({ nativeHarnessOnly: true });
  saveConfig(config(false));
  const first = startServer(0);
  expect(nativeHarnessOnly()).toBe(false);
  await first.stop(true);
  expect(nativeHarnessOnly()).toBe(true);

  bindNativeHarnessConfig(null);
  const second = startServer(0);
  expect(nativeHarnessOnly()).toBe(false);
  // A later owner (another embedded server's policy) replaces it while this server still runs.
  bindNativeHarnessConfig({ nativeHarnessOnly: true });
  await second.stop(true);
  expect(nativeHarnessOnly()).toBe(true);
});
