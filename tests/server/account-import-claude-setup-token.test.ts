import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAUTH_PROVIDERS, OAuthLoginRequiredError, refreshAnthropicAccountWithLock } from "../../src/oauth";
import { parseClaudeSetupTokenDocument } from "../../src/oauth/account-import/claude-setup-token-adapter";
import { importAccounts } from "../../src/oauth/account-import/service";
import {
  CLAUDE_SETUP_TOKEN_IMPORT_FORMAT,
  CLAUDE_SETUP_TOKEN_IMPORT_PROVIDER,
} from "../../src/oauth/account-import/types";
import { detectOAuthWarning } from "../../src/oauth/health";
import {
  credentialGeneration,
  getAccountCredential,
  getAccountSet,
  markAccountNeedsReauthIfGeneration,
  upsertCredentialByIdentity,
} from "../../src/oauth/store";
import { accountQuotaProbeSkip } from "../../src/providers/quota/account-cache";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const CANARY = "setup-token-canary-DO-NOT-LEAK";
const YEAR_MS = 365 * 24 * 3600_000;
const originalEnv = { HOME: process.env.HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
const originalFetch = globalThis.fetch;
let testHome = "";
let upstreamRequests = 0;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "setup-token-import-"));
  process.env.HOME = testHome;
  process.env.OPENCODEX_HOME = join(testHome, "ocx");
  process.env.CLAUDE_CONFIG_DIR = join(testHome, "claude");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "{}");
  upstreamRequests = 0;
  globalThis.fetch = (async () => { upstreamRequests += 1; return new Response(null, { status: 503 }); }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(testHome);
});

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { email: "user@example.com", setup_token: CANARY, expires_at: Date.now() + YEAR_MS, ...overrides };
}

function importSetupTokens(document: unknown) {
  return importAccounts({ provider: CLAUDE_SETUP_TOKEN_IMPORT_PROVIDER, format: CLAUDE_SETUP_TOKEN_IMPORT_FORMAT, document });
}

async function seedRenewableLogin(needsReauth: boolean) {
  await upsertCredentialByIdentity("anthropic", {
    access: "login-access", refresh: "login-refresh", expires: 1,
    email: "user@example.com", accountId: "account-uuid-a", plan: "max_20x", source: "oauth",
  });
  const slot = getAccountSet("anthropic")!.accounts[0]!;
  if (needsReauth) {
    expect(await markAccountNeedsReauthIfGeneration("anthropic", slot.id, credentialGeneration(slot.credential))).toBe("marked");
  }
  return slot.id;
}

describe("Claude setup-token import", () => {
  test("the document schema requires an email, a token and an expiry, and nothing else", () => {
    const expiresAt = Date.now() + YEAR_MS;
    expect(parseClaudeSetupTokenDocument([record({ email: "User@Example.com", expires_at: expiresAt })])).toEqual({
      ok: true,
      records: [{ index: 0, record: { email: "user@example.com", setupToken: CANARY, expiresAt } }],
    });
    const rejected = parseClaudeSetupTokenDocument([
      record({ refresh_token: "another-format-key" }),
      record({ expires_at: undefined }),
      record({ expires_at: "2027-01-01" }),
      record({ setup_token: "token with space" }),
    ]);
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.records.every(item => "code" in item && item.code === "invalid_record")).toBe(true);
  });

  test("a new account is stored as a non-renewing credential and no token reaches the result", async () => {
    const expiresAt = Date.now() + YEAR_MS;
    const imported = await importSetupTokens([record({ expires_at: expiresAt })]);
    expect(imported).toEqual({
      ok: true,
      result: {
        totalCount: 1, importedCount: 1, updatedCount: 0, failedCount: 0, unsupportedCount: 0,
        results: [{ index: 0, status: "imported", code: "imported" }],
      },
    });
    expect(JSON.stringify(imported)).not.toContain(CANARY);
    expect(upstreamRequests).toBe(0);
    const accounts = getAccountSet("anthropic")!.accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.credential).toEqual({
      access: CANARY, refresh: "", expires: expiresAt, email: "user@example.com", source: "manual",
    });
  });

  test("a login that needs a new sign-in is replaced on its own slot and becomes usable again", async () => {
    const slotId = await seedRenewableLogin(true);
    const imported = await importSetupTokens([record()]);
    expect(imported.ok && imported.result.results).toEqual([{ index: 0, status: "updated", code: "updated" }]);
    const accounts = getAccountSet("anthropic")!.accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.id).toBe(slotId);
    expect(accounts[0]!.needsReauth).toBeUndefined();
    expect(accounts[0]!.credential).toMatchObject({
      access: CANARY, refresh: "", accountId: "account-uuid-a", plan: "max_20x", source: "manual",
    });
  });

  test("a working renewable login is never replaced", async () => {
    const slotId = await seedRenewableLogin(false);
    const before = getAccountCredential("anthropic", slotId);
    const imported = await importSetupTokens([record()]);
    expect(imported.ok && imported.result.results).toEqual([{ index: 0, status: "failed", code: "persist_failed" }]);
    expect(getAccountCredential("anthropic", slotId)).toEqual(before);
    expect(getAccountSet("anthropic")!.accounts).toHaveLength(1);
  });

  test("an already expired token is refused and a second import replaces the first token", async () => {
    const expired = await importSetupTokens([record({ expires_at: Date.now() + 1_000 })]);
    expect(expired.ok && expired.result.results).toEqual([{ index: 0, status: "failed", code: "credential_rejected" }]);
    expect(getAccountSet("anthropic")).toBeNull();

    await importSetupTokens([record()]);
    const renewed = await importSetupTokens([record({ setup_token: "renewed-setup-token" })]);
    expect(renewed.ok && renewed.result.results).toEqual([{ index: 0, status: "updated", code: "updated" }]);
    const accounts = getAccountSet("anthropic")!.accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.credential.access).toBe("renewed-setup-token");
  });
});

describe("a pool account holding a setup token", () => {
  test("is healthy while unexpired and is never sent to the usage endpoint", async () => {
    await importSetupTokens([record()]);
    const account = getAccountSet("anthropic")!.accounts[0]!;
    expect(detectOAuthWarning("anthropic", account, true)).toBeUndefined();
    expect(detectOAuthWarning("anthropic", account, true, account.credential.expires + 1)).toBe("stale_credentials");
    expect(accountQuotaProbeSkip("anthropic", account.id)).toMatchObject({ quota: null, unavailable: true });
  });

  test("needs a new token at expiry instead of posting an empty refresh grant", async () => {
    await upsertCredentialByIdentity("anthropic", {
      access: CANARY, refresh: "", expires: 1, email: "user@example.com", source: "manual",
    });
    const account = getAccountSet("anthropic")!.accounts[0]!;
    let refreshCalls = 0;
    const definition = { ...OAUTH_PROVIDERS.anthropic!, refresh: async () => { refreshCalls += 1; throw new Error("refresh must not run"); } };
    await expect(refreshAnthropicAccountWithLock("anthropic", account.id, definition, account.credential))
      .rejects.toBeInstanceOf(OAuthLoginRequiredError);
    expect(refreshCalls).toBe(0);
    expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBe(true);
  });
});
