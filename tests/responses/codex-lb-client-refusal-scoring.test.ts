import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// 2026-11-22 07:17:31Z: a client named a model codex-lb does not serve. codex-lb answered HTTP 200
// and relayed upstream's bare `error` frame (model_not_found / invalid_request_error); on the
// explicit-provider route the hub synthesized a 502 upstream_server_error terminal and logged the
// attempt as an upstream fault against codex-lb.
let testDir = "";
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  codexHome = installIsolatedCodexHome("ocx-lb-refusal-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-lb-refusal-"));
  process.env.OPENCODEX_HOME = testDir;
  clearRequestLogsForTests();
});
afterEach(() => {
  resetProviderRequestPacingForTest();
  clearRequestLogsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome?.restore();
  codexHome = undefined;
  removeTreeWithRetry(testDir);
});

const modelNotFound = {
  type: "invalid_request_error",
  code: "model_not_found",
  message: "The 'gpt-6.2-terra' model is not supported when using Codex with a ChatGPT account.",
};

for (const stream of [true, false]) {
  test(`a relayed model_not_found frame is a client refusal, not an upstream fault (${stream ? "stream" : "buffered"})`, async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response(`event: error\ndata: ${JSON.stringify({ type: "error", status: 400, error: modelNotFound })}\n\n`,
        { headers: { "content-type": "text/event-stream" } }),
    });
    saveConfig({
      port: 0, defaultProvider: "lb",
      providers: { lb: {
        adapter: "openai-responses", apiKey: "lb-key", authMode: "key",
        baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`, allowPrivateNetwork: true,
      } },
    } as OcxConfig);
    const server = startServer(0);
    try {
      const result = await fetch(new URL("/v1/responses", server.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "lb/gpt-6.2-terra", input: "hi", stream }),
      });
      const text = await result.text();
      expect(text).toContain('"type":"not_found_error","code":"model_not_found"');
      expect(text).not.toContain("upstream_server_error");
      const entry = getRequestLogEntries().find(row => row.requestedModel === "lb/gpt-6.2-terra");
      expect(entry?.status).toBe(404);
      expect(entry?.attempts?.map(attempt => attempt.failureCause)).toEqual(["payload-rejected"]);
    } finally {
      await server.stop(true);
      upstream.stop(true);
    }
  });
}
