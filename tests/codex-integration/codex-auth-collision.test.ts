import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { checkAccountIdCollisionWithNativeMain as checkAccountIdCollision, CodexCollisionReadBusyError, CodexLoginRestartingError, warnCodexLoginFailed } from "../../src/codex/auth-api/login-collision";
import { handleCodexAuthLoginStart } from "../../src/codex/auth-api/login-flow";
import { resetLifecycleDrainStateForTests, setDraining } from "../../src/server/lifecycle";
import { saveConfig } from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-auth-collision-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_CODEX_HOME, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_CODEX_HOME;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

function seedAccount(id: string, email: string, chatgptAccountId: string, plan?: string): OcxConfig {
  const config: OcxConfig = {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccounts: [{ id, email, plan, isMain: false }],
  };
  saveConfig(config);
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId,
  });
  return config;
}

describe("codex auth account collision", async () => {
  test("treats a non-string plan as an unknown personal plan", async () => {
    saveConfig({
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [],
    } as OcxConfig);

    expect(await checkAccountIdCollision(
      "malformed-plan-account",
      "member@example.test",
      { toString: 1 },
    )).toEqual({ collision: false });
  });

  test("allows different team members that share a ChatGPT account id", async () => {
    seedAccount("team-member-a", "member-a@example.test", "shared-team-account");

    expect(await checkAccountIdCollision("shared-team-account", "member-b@example.test")).toEqual({
      collision: false,
    });
  });

  test("allows the same email and account id because personal and business subscriptions can coexist", async () => {
    seedAccount("team-member-a", "member-a@example.test", "shared-team-account");

    expect(await checkAccountIdCollision("shared-team-account", "MEMBER-A@example.test", "business")).toEqual({
      collision: false,
    });
  });

  test("rejects the same personal account within the personal bucket", async () => {
    seedAccount("team-member-a", "member-a@example.test", "shared-team-account");

    const result = await checkAccountIdCollision("shared-team-account", "MEMBER-A@example.test");
    expect(result.collision).toBe(true);
    if (result.collision) {
      expect(result.reason).toContain("Account is already in the pool");
    }
  });

  test("rejects the same workspace account within the workspace bucket", async () => {
    seedAccount("workspace-a", "member-a@example.test", "shared-team-account", "team");

    const result = await checkAccountIdCollision("shared-team-account", "MEMBER-A@example.test", "business");
    expect(result.collision).toBe(true);
    if (result.collision) {
      expect(result.reason).toContain("Account is already in the pool");
    }
  });

  test("allows pool registration matching the main Codex login account id", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "not-a-jwt",
        account_id: "main-chatgpt-account",
      },
    }));
    saveConfig({
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [],
    } as OcxConfig);

    const result = await checkAccountIdCollision("main-chatgpt-account", "main@example.test", "business");
    expect(result).toEqual({ collision: false });
  });

  test("excludeAccountId skips self so reauth of the same pool row is not a collision", async () => {
    seedAccount("pool-reauth", "member-a@example.test", "chatgpt-reauth-acct");

    const withoutExclude = await checkAccountIdCollision("chatgpt-reauth-acct", "member-a@example.test");
    expect(withoutExclude.collision).toBe(true);
    if (withoutExclude.collision) {
      expect(withoutExclude.reason).toContain("Account is already in the pool");
    }

    expect(await checkAccountIdCollision(
      "chatgpt-reauth-acct",
      "member-a@example.test",
      undefined,
      "pool-reauth",
    )).toEqual({ collision: false });
  });

  test("rejects pool registration matching the main Codex login in the same plan bucket and email", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "not-a-jwt",
        account_id: "main-chatgpt-account",
      },
    }));
    saveConfig({
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [],
    } as OcxConfig);

    const result = await checkAccountIdCollision("main-chatgpt-account", "main@example.test", undefined);
    expect(result.collision).toBe(true);
    if (result.collision) {
      expect(result.reason).toContain("native Codex main account");
    }
  });

  test("allows different workspace member sharing the main login chatgpt account id", async () => {
    const mainJwt = `header.${Buffer.from(JSON.stringify({
      "https://api.openai.com/profile": { email: "main@example.test" },
      "https://api.openai.com/auth": { chatgpt_plan_type: "team" },
    })).toString("base64url")}.sig`;

    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: {
        access_token: mainJwt,
        account_id: "shared-team-account",
      },
    }));
    saveConfig({
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [],
    } as OcxConfig);

    const result = await checkAccountIdCollision("shared-team-account", "other-colleague@example.test", "team");
    expect(result).toEqual({ collision: false });

    const dupResult = await checkAccountIdCollision("shared-team-account", "main@example.test", "team");
    expect(dupResult.collision).toBe(true);
    if (dupResult.collision) {
      expect(dupResult.reason).toContain("native Codex main account");
    }
  });

  test("excludeAccountId skips main account collision when __main__ is excluded", async () => {
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "not-a-jwt",
        account_id: "main-chatgpt-account",
      },
    }));
    saveConfig({
      port: 10100,
      providers: {},
      defaultProvider: "openai",
      codexAccounts: [],
    } as OcxConfig);

    expect(await checkAccountIdCollision(
      "main-chatgpt-account",
      "main@example.test",
      undefined,
      "__main__",
    )).toEqual({ collision: false });
  });
});

// Physical collision admission must fail closed on uncertainty and release every claim.
test("malformed native auth gives a retryable collision-read refusal", async () => {
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), "{");
  await expect(checkAccountIdCollision("candidate")).rejects.toBeInstanceOf(CodexCollisionReadBusyError);
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({ tokens: {
    access_token: "fake-native", account_id: "different",
  } }));
  expect(await checkAccountIdCollision("candidate")).toEqual({ collision: false });
});

test("valid API-key-only native login has no ChatGPT collision identity", async () => {
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({ auth_mode: "api_key", OPENAI_API_KEY: "fake-api-key" }));
  expect(await checkAccountIdCollision("candidate")).toEqual({ collision: false });
});

test("conflicting native account claims are retryable rather than collision evidence", async () => {
  const token = `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: "token-account" })).toString("base64url")}.fake`;
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({ tokens: {
    access_token: token, account_id: "envelope-account",
  } }));
  await expect(checkAccountIdCollision("candidate")).rejects.toBeInstanceOf(CodexCollisionReadBusyError);
});

test("each busy collision cause carries its closed token", async () => {
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), "{");
  await expect(checkAccountIdCollision("candidate")).rejects.toMatchObject({ cause: "auth-unreadable" });
  const token = `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: "token-account" })).toString("base64url")}.fake`;
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({ tokens: { access_token: token, account_id: "envelope-account" } }));
  await expect(checkAccountIdCollision("candidate")).rejects.toMatchObject({ cause: "auth-inconsistent" });
});

describe("hub draining during login", () => {
  afterEach(() => resetLifecycleDrainStateForTests());

  test("a collision check during drain says the hub restarted, not busy", async () => {
    setDraining(true);
    const error = await checkAccountIdCollision("candidate").catch(e => e);
    expect(error).toBeInstanceOf(CodexLoginRestartingError);
    expect(error).not.toBeInstanceOf(CodexCollisionReadBusyError);
    expect(error.message).toBe("OpenCodex restarted during this login; start it again.");
  });

  test("login start during drain answers 503 server_restarting with Retry-After before any flow opens", async () => {
    setDraining(true);
    const response = await handleCodexAuthLoginStart(new Request("http://localhost/api/codex-auth/login", {
      method: "POST", body: JSON.stringify({ openBrowser: false }),
    }), {} as OcxConfig);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(response.headers.get("X-OpenCodex-Restarting")).toBe("1");
    expect(await response.json()).toEqual({ error: {
      type: "server_error", code: "server_restarting",
      message: "OpenCodex is restarting; start the login again when it is back.",
    } });
  });
});

describe("login failure log line", () => {
  const lines = (error: unknown): string[] => {
    const out: string[] = [];
    const warn = console.warn;
    console.warn = ((line: string) => { out.push(String(line)); }) as typeof console.warn;
    try { warnCodexLoginFailed("chatgpt", error); } finally { console.warn = warn; }
    return out;
  };

  test("prints one closed-token line per cause and nothing identifying", () => {
    for (const cause of ["claim-busy", "claim-unavailable", "codex-home-unreadable", "auth-unreadable", "auth-inconsistent"] as const) {
      expect(lines(new CodexCollisionReadBusyError(cause))).toEqual([`[opencodex] level=warn codex login failed provider=chatgpt cause=${cause}`]);
    }
    expect(lines(new CodexLoginRestartingError())).toEqual(["[opencodex] level=warn codex login failed provider=chatgpt cause=restarting"]);
    const leaky = lines(new Error("user@example.com acct_123 sk-secret flow-9"));
    expect(leaky).toEqual(["[opencodex] level=warn codex login failed provider=chatgpt cause=other"]);
  });
});
