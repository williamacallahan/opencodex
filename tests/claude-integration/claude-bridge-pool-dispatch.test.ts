import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { clearMainAccountInfoCache } from "../../src/codex/auth-api";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { clearCodexThreadLineageForTests } from "../../src/codex/lineage";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearThreadAccountMap, clearCodexUpstreamHealth } from "../../src/codex/routing";
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
import * as authContext from "../../src/codex/auth-context";
import { clearConversationStateIssuerMap, peekConversationStateIssuer } from "../../src/codex/routing/thread-affinity";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { withCallerSessionIdentity } from "../../src/server/caller-session-identity";
import { handleResponses } from "../../src/server/responses/core";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { resolveClaudeBridgePoolSession } from "../../src/server/claude-bridge-pool-session";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const local: DataPlaneAdmission = { kind: "loopback", source: "loopback" };
const metadataUuid = "9745d86c-d579-494a-8d0e-f69a5214cf96";
const principal = (id: string): DataPlaneAdmission => ({ kind: "configured", keyId: "fixture", source: "dedicated", contextPrincipalId: id });
// What a caller could compute from public inputs; the keyed bridge identity must never equal it.
const publicDigest = (principalId: string, value: string) => new Bun.CryptoHasher("sha256")
  .update(JSON.stringify(["opencodex-caller-session-v1", principalId, value])).digest("hex");
// The bridge's own identity for these inputs (same process key), used to read its bookkeeping.
const bridgeIdentity = (admission: DataPlaneAdmission, ingress: Record<string, string> = {}, metadataSessionId?: string) =>
  resolveClaudeBridgePoolSession({ ingress: new Headers(ingress), replay: new Headers(ingress), admission, metadataSessionId })!;
const poolKey = (identity: string) => codexPoolAffinityKey(new Headers({ "session-id": identity, "thread-id": identity }))!;
const account = (wire: Headers | undefined) => wire?.get("chatgpt-account-id");
/** The pool identity is selection-only: no attempt may carry a synthesized pair upstream. */
function expectNoSynthesizedPair(wire: Headers) {
  // The public pair may travel; the private selection HMAC must not.
  for (const name of ["session_id", "session-id", "thread-id"]) expect(wire.get(name) ?? "").not.toMatch(/^[0-9a-f]{64}$/);
}
let home: string, previous: string | undefined, isolated: IsolatedCodexHome, release: () => void;
let wires: Headers[];
let cacheKeys: Array<string | undefined>;
let cfg: OcxConfig;

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-bridge-pool-"));
  process.env.OPENCODEX_HOME = home;
  isolated = installIsolatedCodexHome("ocx-bridge-codex-");
  release = acquireOwnedSpendHome();
  clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota(); clearCodexThreadLineageForTests(); clearConversationStateIssuerMap();
  for (const id of ["fixture-a", "fixture-b"]) {
    saveCodexAccountCredential(id, { accessToken: `fixture-access-${id}`, refreshToken: `fixture-refresh-${id}`, expiresAt: Date.now() + 3_600_000, chatgptAccountId: `account-${id}` });
    updateAccountQuota(id, 10, 10);
  }
  cfg = { defaultProvider: "openai", activeCodexAccountId: "fixture-a", autoSwitchThreshold: 0,
    accountPoolStrategy: "round-robin", accountPoolStickyLimit: 1,
    codexAccounts: [{ id: "fixture-a", label: "a" }, { id: "fixture-b", label: "b" }],
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool", upstreamWebsocket: false } },
  } as unknown as OcxConfig;
  wires = [];
  cacheKeys = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    wires.push(new Headers(init?.headers));
    const payload: { prompt_cache_key?: string } = JSON.parse(String(init?.body));
    cacheKeys.push(payload.prompt_cache_key);
    return Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch; clearMainAccountInfoCache(); release(); isolated.restore();
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(home); clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota(); clearCodexThreadLineageForTests(); clearConversationStateIssuerMap();
});

async function turn(session: string | undefined, admission: DataPlaneAdmission = local, headers: Record<string, string> = {}, model = "openai/gpt-5.4") {
  const lease = tryAdmitTurn();
  expect(lease).not.toBeNull();
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model, max_tokens: 32, stream: false, ...(session ? { metadata: { user_id: session } } : {}), messages: [{ role: "user", content: "ping" }] }),
    }), cfg, { model: "", provider: "" }, { requestId: "fixture", start: Date.now(), turnAdmissionLease: lease!, admission });
    await response.text();
    expect(response.status).toBe(200);
  } finally { lease?.release(); }
}

test("pool binds multiple turns and separates sessions while preserving the native session", async () => {
  for (const session of ["user_test_account__session_conversation-native", "user_test_account__session_conversation-native", "user_test_account__session_other", "user_test_account__session_other"]) await turn(session);
  expect(wires).toHaveLength(4);
  expect(wires[0]!.get("chatgpt-account-id")).toBe(wires[1]!.get("chatgpt-account-id"));
  expect(wires[2]!.get("chatgpt-account-id")).toBe(wires[3]!.get("chatgpt-account-id"));
  expect(wires[0]!.get("chatgpt-account-id")).not.toBe(wires[2]!.get("chatgpt-account-id"));
  expect(wires[0]!.get("session_id")).toBe(metadataUuid);
  for (const wire of wires) expectNoSynthesizedPair(wire);
});

test.each(["session_id", "session-id", "x-session-id", "thread-id", "x-codex-parent-thread-id"])("Responses %s binds one round-robin account per principal", async name => {
  for (const id of ["a", "a", "b", "b", "a"]) {
    const admission = principal(id);
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    try {
      const req = withCallerSessionIdentity(new Request("http://localhost/v1/responses", { method: "POST",
        headers: { "content-type": "application/json", [name]: "repeat" },
        body: JSON.stringify({ model: "openai/gpt-5.4", input: "ping", stream: false }),
      }), admission);
      const result = await handleResponses(req, cfg, { model: "", provider: "" }, { admission, turnAdmissionLease: lease!, inboundWire: "responses" });
      expect(result.status, await result.text()).toBe(200);
    } finally { lease?.release(); }
  }
  const [a, b, c, d, e] = wires.map(account);
  expect(a).toBeTruthy(); expect(c).toBeTruthy(); expect(a).not.toBe(c);
  expect([b, d, e]).toEqual([a, c, a]);
});

test("switching session aliases preserves the same physical native and relay identity", async () => {
  cfg.providers.relay = { adapter: "openai-responses", authMode: "key", apiKey: "fixture-relay-key", baseUrl: "https://relay.example.test/backend-api/codex", models: ["m"] };
  const admission = principal("alias-switch");
  for (const model of ["openai/gpt-5.4", "relay/m"]) {
    for (const name of ["x-session-id", "session-id", "session_id"]) {
      const lease = tryAdmitTurn();
      expect(lease).not.toBeNull();
      try {
        const request = withCallerSessionIdentity(new Request("http://localhost/v1/responses", {
          method: "POST", headers: { "content-type": "application/json", [name]: "same-session" },
          body: JSON.stringify({ model, input: "continue", stream: false }),
        }), admission);
        const response = await handleResponses(request, cfg, { model: "", provider: "" }, { admission, inboundWire: "responses", turnAdmissionLease: lease! });
        expect(response.status, await response.text()).toBe(200);
      } finally { lease?.release(); }
    }
  }
  expect(wires).toHaveLength(6);
  expect(account(wires[0])).toBeTruthy();
  expect(wires[3]?.get("authorization")).toBe("Bearer fixture-relay-key");
  const session = wires[0]?.get("session_id");
  expect(session).toBeTruthy();
  expect(session).not.toBe("same-session");
  for (const wire of wires) {
    expect([wire.get("session_id"), wire.get("session-id"), wire.get("thread-id")]).toEqual([session, session, session]);
  }
});

test("remote principals with identical metadata pin separately and keep the dev wire", async () => {
  for (const id of ["a", "a", "b", "b", "a"]) await turn("user_test_account__session_conversation-native", principal(id));
  expect(account(wires[1])).toBe(account(wires[0]));
  expect(account(wires[2])).not.toBe(account(wires[0]));
  expect(account(wires[3])).toBe(account(wires[2]));
  expect(account(wires[4])).toBe(account(wires[0]));
  expect(wires[0]!.get("session_id")).not.toBe(wires[2]!.get("session_id"));
  for (const wire of wires) {
    expect(wire.get("session_id")).not.toBe(metadataUuid);
    expectNoSynthesizedPair(wire);
  }
});

test("remote principals sending the same session alias do not share a pool binding", async () => {
  for (const id of ["a", "a", "b", "b", "a"]) await turn(undefined, principal(id), { session_id: "fixture-alias" });
  expect(account(wires[1])).toBe(account(wires[0]));
  expect(account(wires[2])).not.toBe(account(wires[0]));
  expect(account(wires[3])).toBe(account(wires[2]));
  expect(account(wires[4])).toBe(account(wires[0]));
  for (const wire of wires) {
    expect(wire.get("session_id")).not.toBe("fixture-alias");
    expectNoSynthesizedPair(wire);
  }
});

test("an alias equal to another principal's derived identity does not join that binding", async () => {
  await turn("user_test_account__session_conversation-native", principal("b"));
  const victim = bridgeIdentity(principal("b"), {}, metadataUuid);
  await turn(undefined, principal("a"), { session_id: victim });
  await turn(undefined, principal("a"), { session_id: victim });
  expect(account(wires[1])).not.toBe(account(wires[0]));
  expect(account(wires[2])).toBe(account(wires[1]));
  expect(peekConversationStateIssuer(poolKey(victim))).toBe(account(wires[0])!.replace(/^account-/, ""));
});

test("a complete caller pair built from public inputs cannot address a synthesized identity", async () => {
  await turn("user_test_account__session_conversation-native", principal("b"));
  const victim = bridgeIdentity(principal("b"), {}, metadataUuid);
  const victimAccount = account(wires[0])!.replace(/^account-/, "");
  // Raw metadata session and the publicly computable digest are what an attacker could know.
  for (const guess of [metadataUuid, publicDigest("b", metadataUuid)]) {
    expect(guess).not.toBe(victim);
    expect(poolKey(guess)).not.toBe(poolKey(victim));
    await turn(undefined, principal("a"), { "session-id": guess, "thread-id": guess });
  }
  expect(account(wires[1])).not.toBe(account(wires[0]));
  expect(peekConversationStateIssuer(poolKey(victim))).toBe(victimAccount);
});

test("translated session and thread aliases are names, not verified upstream tuples", async () => {
  for (const admission of [local, principal("a")]) await turn(undefined, admission, { "session-id": "fixture-pair", "thread-id": "fixture-thread" });
  expect(wires[0]!.get("session_id")).not.toBe(wires[1]!.get("session_id"));
  for (const headers of wires) {
    expect(headers.get("session-id")).toBe(headers.get("session_id"));
    expect(headers.get("session-id")).not.toBe("fixture-pair");
    expect(headers.get("thread-id")).not.toBe("fixture-thread");
  }
});

test("conflicting Claude session aliases cannot fall back to metadata on a native or relay send", async () => {
  cfg.providers.relay = { adapter: "openai-responses", authMode: "key", apiKey: "fixture-relay", baseUrl: "https://relay.example.test/backend-api/codex", models: ["m"] };
  cfg.providers.other = { ...cfg.providers.relay, baseUrl: "https://other.example.test/v1" };
  const aliases = { session_id: "session-one", "session-id": "session-two" };
  for (const model of ["openai/gpt-5.4", "relay/m", "other/m"]) {
    for (const caller of ["first", "second"]) await turn("shared-metadata-session", principal(caller), aliases, model);
  }
  expect(wires).toHaveLength(6);
  for (const wire of wires.slice(0, 4)) {
    for (const name of ["session_id", "session-id", "thread-id", "x-codex-parent-thread-id", "x-session-id"]) expect(wire.has(name)).toBe(false);
  }
  expect(cacheKeys.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
  expect(cacheKeys[4]).toBeTruthy();
  expect(cacheKeys[5]).toBe(cacheKeys[4]);
});

test("translated spawns without a thread send no raw or synthesized identity to native or relay", async () => {
  cfg.providers.relay = { adapter: "openai-responses", authMode: "key", apiKey: "fixture-relay", baseUrl: "https://relay.example.test/backend-api/codex", models: ["m"] };
  for (const model of ["openai/gpt-5.4", "relay/m"]) {
    for (const marker of [{ "x-openai-subagent": "collab_spawn" }, { "x-codex-turn-metadata": '{"subagent_kind":"thread_spawn"}' }]) {
      for (const caller of ["first", "second"]) {
        await turn(undefined, principal(caller), { ...marker, "session-id": "same-unscoped-session" }, model);
        await turn(undefined, principal(caller), { ...marker, "x-codex-parent-thread-id": "parent-without-child" }, model);
      }
    }
  }
  expect(wires).toHaveLength(16);
  for (const wire of wires) for (const name of ["session_id", "session-id", "x-session-id", "thread-id", "x-codex-parent-thread-id"]) {
    expect(wire.has(name)).toBe(false);
  }
});

test("the translated main loop and sibling carry identical identity and cache keys through native and relay auth", async () => {
  cfg.providers.relay = { adapter: "openai-responses", authMode: "key", apiKey: "relay-fixture-key", baseUrl: "https://relay.example.test/backend-api/codex", models: ["m"] };
  for (const agent of [undefined, "sibling"]) {
    const headers: Record<string, string> = { "x-claude-code-session-id": "header-only-session" };
    if (agent) headers["x-claude-code-agent-id"] = agent;
    await turn(undefined, local, headers);
    await turn(undefined, local, headers, "relay/m");
    const native = wires.at(-2)!;
    const relay = wires.at(-1)!;
    for (const name of ["session_id", "session-id", "thread-id"]) {
      expect(native.get(name)).toBeTruthy();
      expect(relay.get(name)).toBe(native.get(name));
    }
    expect(cacheKeys.at(-2)).toBeTruthy();
    expect(cacheKeys.at(-1)).toBe(cacheKeys.at(-2));
    expect(relay.has("chatgpt-account-id")).toBe(false);
    expect(relay.get("authorization")).toBe("Bearer relay-fixture-key");
  }
  expect(wires[0]!.get("session_id")).toBe(wires[2]!.get("session_id"));
  expect(wires[0]!.get("thread-id")).not.toBe(wires[2]!.get("thread-id"));
  expect(cacheKeys[0]).not.toBe(cacheKeys[2]);
});

test("a shared relay separates principals, sessions and actual agents despite a repeated explicit thread", async () => {
  cfg.providers.relay = { adapter: "openai-responses", baseUrl: "https://relay.example.test/backend-api/codex", apiKey: "relay-key", models: ["m"] };
  for (const [caller, session, agent] of [["a", "one", "sibling"], ["b", "one", "sibling"], ["a", "two", "sibling"], ["a", "one", "main"], ["a", "one", "sibling"]] as const) {
    await turn(undefined, principal(caller), { "x-claude-code-session-id": session, "thread-id": "repeated", ...(agent === "main" ? {} : { "x-claude-code-agent-id": agent }) }, "relay/m");
  }
  const sessions = wires.map(h => h.get("session_id"));
  const threads = wires.map(h => h.get("thread-id"));
  expect(new Set(sessions.slice(0, 3)).size).toBe(3);
  expect(new Set(threads.slice(0, 4)).size).toBe(4);
  expect(new Set(cacheKeys.slice(0, 4)).size).toBe(4);
  expect([sessions[4], threads[4], cacheKeys[4]]).toEqual([sessions[0], threads[0], cacheKeys[0]]);
});

test("API-key Responses routes do not receive pool identity", async () => {
  cfg.providers.other = { adapter: "openai-responses", authMode: "key", apiKey: "fixture-key", baseUrl: "https://example.invalid/v1", models: ["m"] };
  await turn("user_test_account__session_conversation-native", local, {}, "other/m");
  expect(wires[0]!.has("thread-id")).toBe(false);
  expect(wires[0]!.has("session-id")).toBe(false);
});

for (const mode of ["stored", "main"] as const) for (const variant of ["local", "remote", "header"] as const) test(`${mode} pool 401 refresh keeps the dev wire for ${variant} identity on retry`, async () => {
  cfg.codexAccounts = mode === "stored" ? [{ id: "fixture-a", label: "a" }] : [];
  if (mode === "main") {
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    clearMainAccountInfoCache();
    const token = fakeChatGptJwt({ exp: Math.floor(Date.now() / 1000) + 86400, chatgpt_account_id: "fixture-main" });
    writeFileSync(join(isolated.path, "auth.json"), JSON.stringify({ tokens: { access_token: token, refresh_token: "fixture-main-grant", account_id: "fixture-main" } }));
  }
  let refreshes = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "auth.openai.com") {
      refreshes++;
      return Response.json({ access_token: mode === "main" ? fakeChatGptJwt({ exp: Math.floor(Date.now() / 1000) + 86400, chatgpt_account_id: "fixture-main" }) : "fixture-refreshed-access", refresh_token: "fixture-refreshed-grant", expires_in: 3600 });
    }
    if (!url.pathname.endsWith("/responses")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    wires.push(new Headers(init?.headers));
    return wires.length === 1 ? Response.json({ error: { message: "expired" } }, { status: 401 })
      : Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
  }) as typeof fetch;
  const admission: DataPlaneAdmission = variant === "remote" ? { kind: "configured", keyId: "fixture", source: "dedicated", contextPrincipalId: "fixture-principal" } : local;
  await turn(variant === "header" ? undefined : "user_test_account__session_conversation-native", admission,
    variant === "header" ? { "x-claude-code-session-id": "fixture-header" } : {});
  expect(refreshes).toBe(1);
  expect(wires).toHaveLength(2);
  for (const name of ["session_id", "session-id", "thread-id"]) {
    expect(wires[1]!.get(name)).toBe(wires[0]!.get(name));
  }
  if (variant !== "local") expect(wires[0]!.get("session_id")).toBeTruthy();
  else expect(wires[0]!.get("session_id")).toBe(metadataUuid);
  for (const wire of wires) expectNoSynthesizedPair(wire);
});

test("native quota retry retains the admitted wire identity and keeps identical callers apart", async () => {
  cfg.codexAccounts?.push({ id: "fixture-c", label: "c" });
  saveCodexAccountCredential("fixture-c", { accessToken: "test-access-c", refreshToken: "test-refresh-c", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "account-c" });
  updateAccountQuota("fixture-c", 10, 10);
  const identities: (string | null)[][] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!request.url.endsWith("/responses")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    const body = await request.json();
    wires.push(request.headers);
    identities.push([request.headers.get("session_id"), request.headers.get("session-id"), request.headers.get("thread-id"), body.prompt_cache_key]);
    return wires.length % 2 ? Response.json({ error: { message: "rate limited" } }, { status: 429 })
      : Response.json({ id: "resp_alternate", object: "response", status: "completed", output: [] });
  }, { preconnect() {} });
  for (const caller of ["one", "two"]) {
    const admission = principal(caller);
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    try {
      const req = withCallerSessionIdentity(new Request("http://localhost/v1/responses", { method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "same-session", "thread-id": "same-thread" },
        body: JSON.stringify({ model: "openai/gpt-5.4", input: "ping", stream: false, prompt_cache_key: "same-prefix" }),
      }), admission);
      const result = await handleResponses(req, cfg, { model: "", provider: "" }, { admission, inboundWire: "responses", turnAdmissionLease: lease! });
      expect(result.status, await result.text()).toBe(200);
    } finally { lease?.release(); }
  }
  expect(wires).toHaveLength(4);
  for (const first of [0, 2]) {
    expect(account(wires[first])).toBeTruthy();
    expect(account(wires[first + 1])).toBeTruthy();
    expect(account(wires[first + 1])).not.toBe(account(wires[first]));
    expect(identities[first + 1]).toEqual(identities[first]);
  }
  for (const [i, raw] of ["same-session", "same-session", "same-thread", "same-prefix"].entries()) {
    expect(identities[0]![i]).toBeTruthy();
    expect(identities[2]![i]).toBeTruthy();
    expect(identities[0]![i]).not.toBe(raw);
    expect(identities[2]![i]).not.toBe(raw);
    expect(identities[2]![i]).not.toBe(identities[0]![i]);
  }
});

for (const variant of ["local-metadata", "remote-alias"] as const) test(`alternate-account failover binds ${variant} under the initial selection key`, async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.endsWith("/responses")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    wires.push(new Headers(init?.headers));
    return wires.length === 1 ? Response.json({ error: { message: "rate limited" } }, { status: 429 })
      : Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
  }) as typeof fetch;
  const send = () => variant === "local-metadata"
    ? turn("user_test_account__session_conversation-native")
    : turn(undefined, principal("fixture-principal"), { session_id: "fixture-alias" });
  // Observe the alternate pick itself: its selection headers must carry the initial pool key.
  const alternatePickKeys: Array<string | undefined> = [];
  const resolveSpy = spyOn(authContext, "resolveCodexAuthContext");
  try {
    await send();
    for (const call of resolveSpy.mock.calls) {
      const [headers, , , options] = call as Parameters<typeof authContext.resolveCodexAuthContext>;
      if (options?.excludeAccountId) alternatePickKeys.push(codexPoolAffinityKey(headers));
    }
  } finally { resolveSpy.mockRestore(); }
  expect(wires).toHaveLength(2);
  const alternate = account(wires[1]);
  expect(alternate).toBeTruthy();
  expect(alternate).not.toBe(account(wires[0]));
  const identity = variant === "local-metadata"
    ? bridgeIdentity(local, {}, metadataUuid)
    : bridgeIdentity(principal("fixture-principal"), { session_id: "fixture-alias" });
  const key = poolKey(identity);
  expect(alternatePickKeys).toEqual([key]);
  // The alternate account's conversation-state issuer is recorded under the initial selection key.
  expect(peekConversationStateIssuer(key)).toBe(alternate!.replace(/^account-/, ""));
  await send();
  expect(account(wires[2])).toBe(alternate);
  for (const wire of wires) expectNoSynthesizedPair(wire);
});
