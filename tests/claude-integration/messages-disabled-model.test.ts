/** A client-named switched-off row is refused on the translating-native and the strict native Messages lanes. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum } from "../../src/oauth/anthropic-routing";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const MODEL = "claude-sonnet-5-5";
const PROVIDER = "operator-anth";
let home: string;
let oldHome: string | undefined;
let release: (() => void) | undefined;
let sent = 0;

beforeEach(() => {
  oldHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-messages-disabled-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  sent = 0;
});
afterEach(() => {
  release?.();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  removeTreeWithRetry(home);
});

async function send(options: { strict: boolean; disabled: boolean }) {
  const transport = (async () => {
    sent += 1;
    return Response.json({ id: "msg_x", type: "message", role: "assistant", model: MODEL,
      content: [{ type: "text", text: "fixture reply" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } });
  }) as typeof fetch;
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic", baseUrl: "https://api.anthropic.com", models: [MODEL], authMode: "key", apiKey: "synthetic-key", fetch: transport,
  };
  const config = {
    port: 0, defaultProvider: PROVIDER, providers: { [PROVIDER]: provider }, anthropicAccountPool: { enabled: false },
    protocols: { rollout: { managedMessagesNative: true } },
    claudeCode: { strictPassthrough: options.strict, intercept: { enabled: false } },
    ...(options.disabled ? { disabledModels: [`${PROVIDER}/${MODEL}`] } : {}),
  } as OcxConfig;
  saveConfig(config);
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: options.strict ? MODEL : `${PROVIDER}/${MODEL}`, max_tokens: 16, stream: false, messages: [{ role: "user", content: "hi" }] }),
  }), config, { model: "", provider: "" }, { requestId: crypto.randomUUID(), start: Date.now(), admission: { kind: "loopback", source: "loopback" } });
  return { response, text: await response.text() };
}

describe("disabled native Claude row", () => {
  for (const strict of [false, true]) {
    test(`is refused with a 404 naming the model, strict=${strict}`, async () => {
      const { response, text } = await send({ strict, disabled: true });
      expect(response.status, text).toBe(404);
      expect(text).toContain("disabled on this hub");
      expect(sent).toBe(0);
    });
  }
  // The strict lane's enabled case needs a byte-exact Claude Code request; it is proved live through claude-any.
  test("an enabled native row is served", async () => {
    const { response, text } = await send({ strict: false, disabled: false });
    expect(response.status, text).toBe(200);
    expect(sent).toBe(1);
  });
});
