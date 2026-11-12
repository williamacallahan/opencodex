import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAccountQuota,
  clearCodexQuotaPrimeState,
  clearMainAccountInfoCache,
  primeCodexPoolQuotas,
  setAccountQuotaFromParsed,
} from "../../src/codex/auth-api";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { resetPoolQuotaAttemptsForTests } from "../../src/codex/auth-api/pool-quota-probe";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { clearThreadAccountMap } from "../../src/codex/routing";
import { setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests, flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const MIN = 60_000;
let TEST_DIR = "";
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;
const originalFetch = globalThis.fetch;

function makeConfig(ids: string[], overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward", codexAccountMode: "pool" } },
    defaultProvider: "openai",
    codexAccounts: ids.map(id => ({ id, email: `${id}@example.test`, plan: "plus", isMain: false })),
    ...overrides,
  } as OcxConfig;
}

function saveCredential(id: string): void {
  saveCodexAccountCredential(id, { accessToken: `access-${id}`, refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 60 * MIN, chatgptAccountId: `acct-${id}` });
}

/** Stores an exhausted weekly window (reset in three days) as of the current mocked clock. */
function storeExhausted(id: string, extra: { reserve?: boolean; credits?: number } = {}): void {
  const now = Date.now();
  setAccountQuotaFromParsed(id, {
    weeklyPercent: 100, weeklyResetAt: now + 3 * 24 * 60 * MIN, weeklyObservedAt: now,
    ...(extra.credits !== undefined ? { credits: { hasCredits: true, balance: 5, allowed: true, observedAt: now - extra.credits } } : {}),
    ...(extra.reserve ? { customWindows: [{ label: "Luna Reserve", percent: 10, resetAt: now + 3 * 24 * 60 * MIN, observedAt: now }] } : {}),
  });
}

function storeActive(id: string): void {
  setAccountQuotaFromParsed(id, { weeklyPercent: 20, weeklyResetAt: Date.now() + 3 * 24 * 60 * MIN, weeklyObservedAt: Date.now() });
}

function usageBody(percent: number): Response {
  return Response.json({ plan_type: "plus", rate_limit: { secondary_window: {
    used_percent: percent, limit_window_seconds: 604_800, reset_at: Math.floor((Date.now() + 3 * 24 * 60 * MIN) / 1000) } } });
}

describe("quota refresh sweep and credit renewal hold exhausted seats", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-exhausted-hold-"));
    const aclSuccess = { success: true, exitCode: 0, timedOut: false, stdout: "" };
    setIcaclsRunnerForTests(() => aclSuccess);
    setAsyncIcaclsRunnerForTests(async () => aclSuccess);
    mkdirSync(join(TEST_DIR, "codex"), { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.CODEX_HOME = join(TEST_DIR, "codex");
    clearAccountQuota();
    clearThreadAccountMap();
    clearCodexQuotaPrimeState();
    clearMainAccountInfoCache();
    resetPoolQuotaAttemptsForTests();
    resetMainCodexAccountIdentityTrackingForTests();
    resetLifecycleDrainStateForTests();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    clearAccountQuota();
    clearThreadAccountMap();
    clearCodexQuotaPrimeState();
    clearMainAccountInfoCache();
    resetPoolQuotaAttemptsForTests();
    resetMainCodexAccountIdentityTrackingForTests();
    resetLifecycleDrainStateForTests();
    await flushConfigDirHardeningForTests();
    await flushWindowsSecretAclReapsBeforeRemoval(TEST_DIR);
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  });

  /** Seeds readings taken five minutes ago, then POSTs the refresh route now; returns the account ids WHAM read. */
  async function refreshRead(
    exhaustedIds: string[], options: { reserveIds?: string[]; principal?: "gui-session"; query?: string; body?: string } = {},
  ): Promise<string[]> {
    const now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now - 5 * MIN);
    const config = makeConfig([...exhaustedIds, "active"], { dashboardRoutingEnabled: undefined });
    try {
      saveConfig(config);
      setLiveStateStoreConfig(config);
      for (const id of [...exhaustedIds, "active"]) saveCredential(id);
      for (const id of exhaustedIds) storeExhausted(id, { reserve: options.reserveIds?.includes(id) });
      storeActive("active");
      const read: string[] = [];
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toContain("/backend-api/wham/usage");
        read.push(new Headers(init?.headers).get("chatgpt-account-id")!.replace("acct-", ""));
        return usageBody(100);
      }) as typeof fetch;
      clock.mockImplementation(() => now);
      const req = new Request(`http://localhost/api/codex-auth/accounts/refresh${options.query ?? ""}`, {
        method: "POST",
        ...(options.body ? { body: options.body, headers: { "Content-Type": "application/json" } } : {}),
      });
      const response = await handleCodexAuthAPI(req, new URL(req.url), config, undefined, options.principal);
      expect(response?.status).toBe(200);
      const accounts = (await response!.json()).accounts as Array<{ id: string }>;
      expect(accounts.map(account => account.id).filter(id => id !== "__main__").sort()).toEqual([...exhaustedIds, "active"].sort());
      return read.sort();
    } finally { clock.mockRestore(); }
  }

  const EXHAUSTED = ["x1", "x2", "x3"];

  test("the sidecar's admin-token refresh reads only the active account", async () => {
    expect(await refreshRead(EXHAUSTED)).toEqual(["active"]);
  });

  test("an explicit force flag in the query or body reads every account", async () => {
    expect(await refreshRead(EXHAUSTED, { query: "?force=1" })).toEqual(["active", ...EXHAUSTED]);
    clearAccountQuota(); resetPoolQuotaAttemptsForTests();
    expect(await refreshRead(EXHAUSTED, { body: JSON.stringify({ force: true }) })).toEqual(["active", ...EXHAUSTED]);
  });

  test("a dashboard session refresh reads every account", async () => {
    expect(await refreshRead(EXHAUSTED, { principal: "gui-session" })).toEqual(["active", ...EXHAUSTED]);
  });

  test("an exhausted account holding a Luna Reserve window is read on the ordinary cadence", async () => {
    expect(await refreshRead(["x1", "x2"], { reserveIds: ["x2"] })).toEqual(["active", "x2"]);
  });

  describe("credit renewal", () => {
    /** Renewal sweep now for an account with or without a known reset whose credits were observed `ageMs` ago; returns WHAM request count. */
    async function renewalRequests(knownReset: boolean, ageMs: number): Promise<number> {
      const now = Date.now();
      const config = makeConfig(["p1"], { creditCodexAccountIds: ["p1"] });
      saveCredential("p1");
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      try {
        const seeded = now - ageMs;
        setAccountQuotaFromParsed("p1", {
          // Without a known reset the seat has no proven hold, so it keeps the ordinary renewal age.
          ...(knownReset ? { weeklyPercent: 100, weeklyResetAt: now + 3 * 24 * 60 * MIN, weeklyObservedAt: seeded }
            : { shortPercent: 100, shortObservedAt: now }),
          credits: { hasCredits: true, balance: 5, allowed: true, observedAt: seeded },
        });
        let requests = 0;
        globalThis.fetch = (async () => { requests++; return usageBody(100); }) as typeof fetch;
        await primeCodexPoolQuotas(config, "credit-renewal");
        return requests;
      } finally { clock.mockRestore(); }
    }

    test("an exhausted account renewed 5 minutes ago is not read", async () => {
      expect(await renewalRequests(true, 5 * MIN)).toBe(0);
    });

    test("an exhausted account renewed 16 minutes ago is read once", async () => {
      expect(await renewalRequests(true, 16 * MIN)).toBe(1);
    });

    test("an account with no known reset keeps the 3 minute renewal age", async () => {
      expect(await renewalRequests(false, 4 * MIN)).toBe(1);
    });
  });
});
