import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget } from "../../src/combos";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { issueTurnStateHandle, resetTurnStateHandlesForTests, TURN_STATE_HEADER, turnStateBinding } from "../../src/server/turn-state-handles";
import { handleResponses } from "../../src/server/responses";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { createTempHome } from "../helpers/temp-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const clientFetch = globalThis.fetch;
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
let nativeRequest: Request | undefined;
let nativeBody: { input: { type?: string; call_id?: string }[]; client_metadata?: Record<string, string> } | undefined;
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
  nativeRequest = undefined; nativeBody = undefined;
  const upstream = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url === CODEX_RESPONSES_HTTP_URL) {
      nativeRequest = request;
      nativeBody = await request.clone().json();
      return nativeReply();
    }
    if (request.url !== `${relayUrl}/v1/responses`) throw new Error(`unexpected upstream ${request.url}`);
    relayInput = (await request.json()).input;
    return relayReply();
  }, { preconnect() {} }));
  cleanup = () => { upstream.mockRestore(); reset(); release(); home.remove(); };
});
afterEach(() => cleanup());

async function post(input: unknown[], log: RequestLogContext = { provider: "", model: "" }, headers: Record<string, string> = {}, extra = {}, routing = config) {
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
    headers: { "content-type": "application/json", "thread-id": "luna-owner-release", ...headers },
    body: JSON.stringify({ model: "combo/luna", input, store: false, stream: true,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }], ...extra }),
  }), routing, log, { admission: { kind: "loopback", source: "loopback" } });
  return { status: response.status, headers: response.headers, text: await response.text() };
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

test.each(["no handle", "no recall or handle", "expired header", "expired metadata", "live but unavailable"] as const)(
  "Luna starts a fresh Reserve turn with complete tool history (%s)", async mode => {
    expect((await post([question])).text).toContain(reasoning("native").encrypted_content);
    if (mode === "no recall or handle") clearComboRecallForTests();
    const handle = mode.startsWith("no ") ? undefined : issueTurnStateHandle("fixture-turn-state", turnStateBinding("openai",
      new Headers({ authorization: "Bearer fixture-other-access", "chatgpt-account-id": "fixture-other-seat" })));
    if (mode !== "live but unavailable") resetTurnStateHandlesForTests();
    clearThreadAccountMap();
    nativeReply = () => completed("replacement", []);
    const log: RequestLogContext = { provider: "", model: "" };
    const headers: Record<string, string> = handle && mode !== "expired metadata" ? { [TURN_STATE_HEADER]: handle } : {};
    const extra = mode === "expired metadata" ? { client_metadata: { [TURN_STATE_HEADER]: handle, keep: "client-value" } } : {};
    const result = await post(nativeHistory, log, headers, extra);
    expect(result.status).toBe(200);
    expect(result.text).toContain("resp_replacement");
    expect(log.attempts?.filter(attempt => attempt.sendCount).map(attempt => attempt.wireModel)).toEqual(["gpt-reserve"]);
    expect(nativeRequest?.headers.get(TURN_STATE_HEADER)).toBeNull();
    expect(nativeBody?.client_metadata?.[TURN_STATE_HEADER]).toBeUndefined();
    expect(nativeBody?.input.filter(entry => entry.type === "reasoning")).toEqual([]);
    expect(nativeBody?.input.filter(entry => entry.call_id)).toEqual([call("native"), output("native")]);
  },
);

test("a zero-send owner refusal can rebuild on the only configured Reserve seat", async () => {
  const oneSeat: OcxConfig = { ...config, combos: { luna: { strategy: "failover", targets: [native] } } };
  expect((await post([question], undefined, {}, {}, oneSeat)).status).toBe(200);
  clearThreadAccountMap();
  const log: RequestLogContext = { provider: "", model: "" };
  nativeReply = () => completed("single_seat", []);
  const result = await post(nativeHistory, log, {}, {}, oneSeat);
  expect(result.status).toBe(200);
  expect(result.text).toContain("resp_single_seat");
  expect(log.attempts?.map(attempt => [attempt.sendCount, attempt.wireModel]))
    .toEqual([[0, undefined], [1, "gpt-reserve"]]);
});

test("missing owner and an incomplete tool history are terminal even without a turn handle", async () => {
  const result = await post([question, reasoning("native"), output("native")]);
  expect(result.status).toBe(409);
  expect(result.headers.get("x-should-retry")).toBe("false");
  expect(nativeRequest).toBeUndefined();
  expect(relayInput).toEqual([]);
});

test("HTTP resumes a Pi tool turn after both owner records are lost", async () => {
  saveConfig(config);
  const server = startServer(0);
  const request = (input: unknown[]) => clientFetch(new URL("/v1/responses", server.url), { method: "POST",
    headers: { "content-type": "application/json", "thread-id": "pi-luna-restart" },
    body: JSON.stringify({ model: "combo/luna", store: false, input, stream: true,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }] }),
  });
  try {
    expect(await (await request([question])).text()).toContain(reasoning("native").encrypted_content);
    clearComboRecallForTests(); clearThreadAccountMap();
    nativeReply = () => completed("http_replacement", []);
    const response = await request(nativeHistory);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("resp_http_replacement");
    expect(nativeBody?.input.filter(entry => entry.call_id)).toEqual([call("native"), output("native")]);
  } finally { await server.stop(true); }
});

test.each([
  ["stored turn", nativeHistory, { store: true }],
  ["unresolved response id", nativeHistory, { previous_response_id: "resp_missing" }],
  ["item reference", [...nativeHistory, { type: "item_reference", id: "msg_missing" }], {}],
  ["orphan result", [question, output("native")], {}],
  ["pending tool call", [question, call("native")], {}],
  ["missing tool arguments", [question, { ...call("native"), arguments: undefined }, output("native")], {}],
  ["missing tool output", [question, call("native"), { ...output("native"), output: undefined }], {}],
  ["provider-hosted tool", nativeHistory, { tools: [{ type: "code_interpreter", container: "cn_fixture" }] }],
  ["uploaded file", [...nativeHistory, { type: "message", role: "user", content: [{ type: "input_file", file_id: "file_fixture" }] }], {}],
] as const)("Luna never sends a fresh turn with a %s", async (_, input, extra) => {
  const handle = issueTurnStateHandle("fixture-turn-state", turnStateBinding("openai", new Headers()));
  resetTurnStateHandlesForTests();
  const result = await post([...input], undefined, { [TURN_STATE_HEADER]: handle }, extra);
  expect(result.status).toBe(409);
  expect(result.headers.get("x-should-retry")).toBe("false");
  expect(result.text).toContain("Resend the full conversation");
  expect(nativeRequest).toBeUndefined();
  expect(relayInput).toEqual([]);
});
