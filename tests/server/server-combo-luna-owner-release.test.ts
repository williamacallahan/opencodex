import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget } from "../../src/combos";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { handleResponses } from "../../src/server/responses";
import { CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { createTempHome } from "../helpers/temp-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const model = "gpt-6-luna", seat = "owner-release-seat";
const native = { provider: "openai", model }, relay = { provider: "relay", model };
const relayUrl = "https://relay.example.test/backend-api/codex";
const config: OcxConfig = {
  port: 0, defaultProvider: "openai", codexMainAccountHardLock: false, accountPoolStrategy: "quota", autoSwitchThreshold: 0,
  activeCodexAccountId: seat, codexAccounts: [{ id: seat, email: "owner@example.test", isMain: false, plan: "pro" }],
  providers: {
    openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: "pool", upstreamWebsocket: false },
    relay: { adapter: "openai-responses", authMode: "key", apiKey: "fixture-relay", baseUrl: relayUrl, upstreamWebsocket: false },
  },
  combos: { luna: { strategy: "failover", waitForCooldownMs: 0, targets: [native, relay] } },
};
const question = { role: "user", content: "Run both lookups" };
const reasoning = (issuer: string) => ({ type: "reasoning", id: `rs_${issuer}`, encrypted_content: `${issuer}-cipher`, summary: [] });
const call = (issuer: string) => ({ type: "function_call", call_id: `call_${issuer}`, name: "lookup", arguments: "{}" });
const output = (issuer: string) => ({ type: "function_call_output", call_id: `call_${issuer}`, output: `found ${issuer}` });
const nativeHistory = [question, reasoning("native"), call("native"), output("native")];

function completed(issuer: string, items: unknown[]) {
  const frames = items.map((item, output_index) => ({ type: "response.output_item.done", output_index, item }));
  const terminal = { type: "response.completed", response: { id: `resp_${issuer}`, object: "response", model, status: "completed", output: items } };
  return new Response([...frames, terminal].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
let nativeReply: () => Response;
let relayReply: () => Response;
let relayInput: { type?: string; call_id?: string }[];
let cleanup: () => void;
function reset() {
  clearComboRecallForTests(); clearComboSelectionState(); clearComboTargetCooldowns();
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap();
}
beforeEach(() => {
  const home = createTempHome(), release = acquireOwnedSpendHome(); reset();
  const expiry = Date.now() + 86_400_000;
  saveCodexAccountCredential(seat, { accessToken: "fixture-access", refreshToken: "fixture-refresh", chatgptAccountId: "fixture-owner", expiresAt: expiry });
  updateAccountQuota(seat, 100, expiry);
  setAccountQuotaFromParsed(seat, { customWindows: [{ label: "Luna Reserve", percent: 25, resetAt: expiry, observedAt: Date.now() }] });
  nativeReply = () => completed("native", [reasoning("native"), call("native")]);
  relayReply = () => completed("relay", [reasoning("relay"), call("relay")]);
  relayInput = [];
  const upstream = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url === CODEX_RESPONSES_HTTP_URL) return nativeReply();
    if (request.url !== `${relayUrl}/v1/responses`) throw new Error(`unexpected upstream ${request.url}`);
    relayInput = (await request.json()).input;
    return relayReply();
  }, { preconnect() {} }));
  cleanup = () => { upstream.mockRestore(); reset(); release(); home.remove(); };
});
afterEach(() => cleanup());

async function post(input: unknown[], log: RequestLogContext = { provider: "", model: "" }) {
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
    headers: { "content-type": "application/json", "thread-id": "luna-owner-release" },
    body: JSON.stringify({ model: "combo/luna", input, store: false, stream: true,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }] }),
  }), config, log, { admission: { kind: "loopback", source: "loopback" } });
  return { status: response.status, text: await response.text() };
}

function expectRelayHistory(issuers: string[]) {
  expect(relayInput.filter(entry => entry.type === "reasoning")).toEqual(issuers.includes("relay") ? [reasoning("relay")] : []);
  expect(relayInput.filter(entry => entry.call_id)).toEqual(issuers.flatMap(issuer => [call(issuer), output(issuer)]));
}

test("a cooling native owner releases a stateless tool turn", async () => {
  expect((await post([question])).text).toContain(reasoning("native").encrypted_content);
  coolComboTarget("luna", native, { status: 503, retryAfter: "120" });
  coolComboTarget("luna", relay, { status: 503, retryAfter: "60" });
  const held = await post(nativeHistory);
  expect(held.status).toBe(503);
  expect(held.text).toContain("conversation owner is cooling down");
  clearComboTargetCooldowns("luna", [`relay/${model}`]);
  const log: RequestLogContext = { provider: "", model: "" };
  const result = await post(nativeHistory, log);
  expect(result.status).toBe(200);
  expect(result.text).toContain("response.completed");
  expectRelayHistory(["native"]);
  expect(log.routeDecision?.selected.reason).toBe("luna-owner-spent-ported");
  expect(log.attempts?.map(({ provider, sendCount }) => [provider, sendCount])).toEqual([["relay", 1]]);
});

test("a second tool result on the replacement store does not replay the old owner's reasoning", async () => {
  expect((await post([question])).text).toContain(reasoning("native").encrypted_content);
  nativeReply = () => Response.json({ error: { code: "usage_limit_reached", message: "Limit reached" } }, { status: 429 });
  const move: RequestLogContext = { provider: "", model: "" };
  expect((await post(nativeHistory, move)).text).toContain(reasoning("relay").encrypted_content);
  expect(move.routeDecision?.selected.reason).toBe("luna-owner-spent-ported");
  expectRelayHistory(["native"]);
  relayReply = () => completed("final", []);
  const mixed = [...nativeHistory, reasoning("relay"), call("relay"), output("relay")];
  expect((await post([{ type: "item_reference", id: "msg_bound" }, ...mixed])).status).toBe(409);
  const result = await post(mixed);
  expect(result.status).toBe(200);
  expect(result.text).toContain("response.completed");
  expectRelayHistory(["native", "relay"]);
});
