import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30000);
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { initializeMainAccountPolicyBinding, reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { clearMainAccountInfoCache } from "../../src/codex/main-account-cache";
import { setMainAccountPlan } from "../../src/codex/main-account";
import { clearAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearConversationStateIssuerMap, clearThreadAccountMap } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { resetCodexRoutingForManualSelection } from "../../src/codex/routing/active-account";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";

const pool = "stored-main-duplicate";
const email = "member@example.test";
const fileId = "file-fixture";
const realFetch = globalThis.fetch;
const homeKeys = ["CODEX_HOME", "OPENCODEX_HOME"] as const;
let home: string;
let previous: Array<string | undefined>;
let release: () => void;
let config: OcxConfig;
let sends: Array<{ authorization: string | null; body: string }>;

function jwt(accountId = "shared-account", suffix = "fixture",
  claims: { userId?: string; plan?: string; member?: string } = {}): string {
  const userId = claims.userId ?? "same-user";
  const member = claims.member ?? email;
  return `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
    chatgpt_account_id: accountId, "https://api.openai.com/auth": { chatgpt_plan_type: claims.plan ?? "plus",
      ...(userId ? { chatgpt_user_id: userId } : {}) },
    ...(member ? { "https://api.openai.com/profile": { email: member } } : {}) })).toString("base64url")}.${suffix}`;
}
const poolToken = jwt("shared-account", "pool");
const mainToken = jwt("shared-account", "main");
function native(accountId = "shared-account", token = mainToken) {
  writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: token, account_id: accountId } }));
  reconcileMainCodexAccountRuntimeState();
  initializeMainAccountPolicyBinding(join(process.env.CODEX_HOME!, "auth.json"));
}
function clear() {
  clearThreadAccountMap(); clearConversationStateIssuerMap(); clearCodexUpstreamHealth(); clearAccountQuota();
  clearPoolRotationState(); clearMainAccountInfoCache(); setMainAccountPlan(null); resetMainCodexAccountIdentityTrackingForTests();
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-file-scope-"));
  previous = homeKeys.map(key => process.env[key]);
  for (const key of homeKeys) { process.env[key] = join(home, key); mkdirSync(process.env[key]!, { recursive: true }); }
  release = acquireOwnedSpendHome(); clear();
  config = { port: 0, defaultProvider: "openai", activeCodexAccountId: pool, codexMainAccountHardLock: false,
    autoSwitchThreshold: 0, accountPoolStrategy: "round-robin", codexPool: { requestOwnedAffinity: true },
    codexAccounts: [{ id: pool, email, plan: "plus", isMain: false }],
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward", codexAccountMode: "pool", upstreamWebsocket: false } } } as OcxConfig;
  saveCodexAccountCredential(pool, { accessToken: poolToken, refreshToken: "fixture-refresh",
    chatgptAccountId: "shared-account", expiresAt: Date.now() + 3600_000 });
  sends = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url !== "https://chatgpt.com/backend-api/codex/responses" && url !== "https://chatgpt.com/backend-api/codex/responses/compact") throw new Error(`Unexpected destination: ${url}`);
    sends.push({ authorization: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
    if (url.endsWith("/compact")) return Response.json({ id: "cmp_1", object: "response.compaction", output: [] });
    const completed = { id: "resp_1", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch; release(); clear();
  await drainAndRemoveFixtureRoots({ roots: [{ path: home }], restoreEnvironment: () => {
    homeKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  } });
});
function pin(id: string) {
  resetCodexRoutingForManualSelection(id);
  config.activeCodexAccountId = id;
  config.activeCodexAccountPinned = id;
}
async function send(compact: boolean, bearer?: string) {
  const request = new Request(`http://localhost/v1/responses${compact ? "/compact" : ""}`, { method: "POST",
    headers: { "content-type": "application/json", "session-id": "file-session", "thread-id": "file-thread", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ model: "gpt-5.5", stream: false, input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: fileId }] }] }) });
  const response = await (compact ? handleResponsesCompact : handleResponses)(request, config, { model: "", provider: "" });
  const body = await response.text();
  return { status: response.status, body };
}
function expectSend(index: number, token: string) {
  expect(sends[index]?.authorization).toBe(`Bearer ${token}`);
  expect(JSON.parse(sends[index]!.body).input[0].content[0].file_id).toBe(fileId);
}
for (const compact of [false, true]) {
  for (const scenario of ["pool to main", "main to pool", "matching caller", "unrelated caller", "different account"] as const) {
    test(`${compact ? "compact" : "responses"}: ${scenario}`, async () => {
      const caller = scenario === "matching caller" ? mainToken : scenario === "unrelated caller" ? jwt("other-caller", "caller") : undefined;
      if (scenario === "main to pool") { native(); pin("__main__"); }
      else { config.pausedCodexAccountIds = ["__main__"]; pin(pool); }
      const first = await send(compact, caller);
      expect(first.status).toBe(200);
      expectSend(0, scenario === "main to pool" ? mainToken : poolToken);
      if (scenario === "main to pool") {
        writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), "{");
        reconcileMainCodexAccountRuntimeState();
        config.pausedCodexAccountIds = ["__main__"]; pin(pool);
      }
      else { native(scenario === "different account" ? "different-account" : "shared-account", scenario === "different account" ? jwt("different-account", "main") : mainToken); config.pausedCodexAccountIds = []; pin("__main__"); }
      const second = await send(compact, caller);
      const refused = scenario !== "pool to main" && scenario !== "matching caller";
      expect(second.status).toBe(refused ? 400 : 200);
      expect(sends).toHaveLength(refused ? 1 : 2);
      if (!refused) expectSend(1, mainToken);
    });
  }
  test(`${compact ? "compact" : "responses"}: a replacement main login cannot authorize an earlier main issuer`, async () => {
    // Native main is account A when the first file-carrying turn is served; A is the issuer recorded
    // for the conversation. Native Codex then signs into account B, which the stored Pool copy also
    // holds. The `__main__` alias carries no memory of A, so the move to B's copy must stay refused.
    const issuerToken = jwt("issuer-account", "issuer", { userId: "issuer-user" });
    native("issuer-account", issuerToken);
    pin("__main__");
    expect((await send(compact)).status).toBe(200);
    expectSend(0, issuerToken);
    native("shared-account", jwt("shared-account", "main"));
    writeFileSync(join(process.env.CODEX_HOME!, "auth.json"), "{");
    reconcileMainCodexAccountRuntimeState();
    config.pausedCodexAccountIds = ["__main__"]; pin(pool);
    const moved = await send(compact);
    expect(moved.status).toBe(400);
    expect(moved.body).toContain("re-upload the files");
    expect(sends).toHaveLength(1);
  });
  test(`${compact ? "compact" : "responses"}: workspace membership without matching user claims cannot reuse a file`, async () => {
    // Same workspace, same plan bucket, different members: the collision rule still excludes the
    // copy as a duplicate, but a file the copy received is not proven readable by main's member.
    config.codexAccounts![0]!.plan = "team";
    saveCodexAccountCredential(pool, { accessToken: jwt("shared-account", "pool", { userId: "member-two", plan: "team" }),
      refreshToken: "fixture-refresh", chatgptAccountId: "shared-account", expiresAt: Date.now() + 3600_000 });
    config.pausedCodexAccountIds = ["__main__"]; pin(pool);
    expect((await send(compact)).status).toBe(200);
    native("shared-account", jwt("shared-account", "member-one", { userId: "member-one", plan: "team", member: "" }));
    config.pausedCodexAccountIds = []; pin("__main__");
    const moved = await send(compact);
    expect(moved.status).toBe(400);
    expect(moved.body).toContain("re-upload the files");
    expect(sends).toHaveLength(1);
  });
  test(`${compact ? "compact" : "responses"}: confirmed main credential removal refuses crossing to pool`, async () => {
    native(); pin("__main__");
    expect((await send(compact)).status).toBe(200);
    expectSend(0, mainToken);
    unlinkSync(join(process.env.CODEX_HOME!, "auth.json"));
    reconcileMainCodexAccountRuntimeState();
    config.pausedCodexAccountIds = ["__main__"]; pin(pool);
    expect((await send(compact)).status).toBe(400);
    expect(sends).toHaveLength(1);
  });
}
