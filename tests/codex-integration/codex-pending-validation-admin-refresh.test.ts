import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountQuota, clearCodexQuotaPrimeState, clearMainAccountInfoCache } from "../../src/codex/auth-api";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { PENDING_VALIDATION_RETRY_BACKOFF_MS, resetPoolQuotaAttemptsForTests } from "../../src/codex/auth-api/pool-quota-probe";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { isCodexAccountUsable } from "../../src/codex/account-usability";
import { clearThreadAccountMap } from "../../src/codex/routing";
import { setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import { loadConfig, saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests, flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { handleManagementAPI } from "../../src/server/management-api";
import { invalidateStartupHealthCache } from "../../src/server/startup-health-cache";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { startupHealthFixture } from "../helpers/startup-health";
import type { OcxConfig } from "../../src/types";
import type { ManagementPrincipal } from "../../src/server/management-auth";

const ACCOUNT_ID = "pending-seat";
let TEST_DIR = "";
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;
const originalFetch = globalThis.fetch;

function resetProcessState(): void {
  clearAccountQuota();
  clearThreadAccountMap();
  clearCodexQuotaPrimeState();
  clearMainAccountInfoCache();
  resetPoolQuotaAttemptsForTests();
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  invalidateStartupHealthCache();
}

/** A pool whose one account signed in while a quota window read exhausted. */
function pendingPool(standingConsent: boolean): OcxConfig {
  const config = {
    port: 10100,
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward", codexAccountMode: "pool" } },
    defaultProvider: "openai",
    codexAccounts: [{ id: ACCOUNT_ID, email: "pending@example.test", plan: "pro", isMain: false }],
    ...(standingConsent ? { codexPendingValidationByAdminRefresh: true } : {}),
  } as OcxConfig;
  saveConfig(config);
  setLiveStateStoreConfig(config);
  saveCodexAccountCredential(ACCOUNT_ID, { accessToken: "pending-access", refreshToken: "pending-refresh",
    expiresAt: Date.now() + 24 * 3600_000, chatgptAccountId: "acct-pending" }, { validationPending: true });
  return config;
}

/** Fakes the usage read and the warm-up; returns the count of warm-ups sent upstream. */
function fakeUpstream(usage: () => Response, warmup: () => Response): { warmups: number } {
  const sent = { warmups: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/wham/usage")) return usage();
    if (String(input).endsWith("/codex/responses")) { sent.warmups++; return warmup(); }
    throw new Error("unexpected request");
  }) as typeof fetch;
  return sent;
}

const weeklyUsage = (percent: number) => () => Response.json({ plan_type: "pro",
  rate_limit: { secondary_window: { used_percent: percent, limit_window_seconds: 604_800 } } });
const completedWarmup = () => new Response('data: {"type":"response.completed"}\n\n');

async function refresh(config: OcxConfig, principal: ManagementPrincipal): Promise<void> {
  const req = new Request("http://localhost/api/codex-auth/accounts/refresh", { method: "POST" });
  expect((await handleCodexAuthAPI(req, new URL(req.url), config, undefined, principal))?.status).toBe(200);
}

describe("standing admin-token consent for pending Codex account validation", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-pending-validation-"));
    const aclSuccess = { success: true, exitCode: 0, timedOut: false, stdout: "" };
    setIcaclsRunnerForTests(() => aclSuccess);
    setAsyncIcaclsRunnerForTests(async () => aclSuccess);
    mkdirSync(join(TEST_DIR, "codex"), { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.CODEX_HOME = join(TEST_DIR, "codex");
    resetProcessState();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    resetProcessState();
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

  test("with the setting off an admin-token refresh sends no warm-up", async () => {
    const config = pendingPool(false);
    const sent = fakeUpstream(weeklyUsage(12), completedWarmup);
    await refresh(config, "admin-token");
    expect(sent.warmups).toBe(0);
    expect(readCodexAccountRecord(ACCOUNT_ID)?.codexValidationPending).toBe(true);
    expect(isCodexAccountUsable(config, ACCOUNT_ID)).toBe(false);
  });

  test("with the setting on one admin-token refresh validates a pending account that has headroom", async () => {
    const config = pendingPool(true);
    const sent = fakeUpstream(weeklyUsage(42), completedWarmup);
    await refresh(config, "admin-token");
    expect(sent.warmups).toBe(1);
    expect(readCodexAccountRecord(ACCOUNT_ID)?.codexValidationPending).toBeUndefined();
    expect(isCodexAccountUsable(config, ACCOUNT_ID)).toBe(true);
  });

  test("a warm-up that succeeds for a credential replaced mid-test is not logged as completed", async () => {
    const config = pendingPool(true);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      fakeUpstream(weeklyUsage(42), () => {
        saveCodexAccountCredential(ACCOUNT_ID, { accessToken: "replaced-access", refreshToken: "replaced-refresh",
          expiresAt: Date.now() + 24 * 3600_000, chatgptAccountId: "acct-pending" }, { validationPending: true });
        return completedWarmup();
      });
      await refresh(config, "admin-token");
      const validationLines = warn.mock.calls.map(call => String(call[0])).filter(line => line.includes("pool validation account="));
      expect(readCodexAccountRecord(ACCOUNT_ID)?.codexValidationPending).toBe(true);
      expect(validationLines.some(line => line.endsWith(" completed"))).toBe(false);
      expect(validationLines.some(line => line.endsWith("unrecorded reason=credential_changed"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("the setting grants nothing to a principal other than the admin token", async () => {
    const config = pendingPool(true);
    const sent = fakeUpstream(weeklyUsage(12), completedWarmup);
    await refresh(config, "local-read-capability");
    expect(sent.warmups).toBe(0);
    expect(readCodexAccountRecord(ACCOUNT_ID)?.codexValidationPending).toBe(true);
  });

  test("a failed warm-up is re-sent by admin-token refreshes only after the backoff, and by a dashboard session at once", async () => {
    const config = pendingPool(true);
    const start = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => start);
    try {
      let warmup = () => new Response("upstream unavailable", { status: 500 });
      const sent = fakeUpstream(weeklyUsage(12), () => warmup());
      // The first failure is recorded by a clock running five minutes ahead.
      clock.mockImplementation(() => start + 5 * 60_000);
      await refresh(config, "admin-token");
      expect(sent.warmups).toBe(1);
      expect(readCodexAccountRecord(ACCOUNT_ID)?.codexValidationPending).toBe(true);

      // Stepped back, the clock reads earlier than that failure: the future time holds nothing.
      clock.mockImplementation(() => start);
      await refresh(config, "admin-token");
      expect(sent.warmups).toBe(2);

      clock.mockImplementation(() => start + PENDING_VALIDATION_RETRY_BACKOFF_MS - 1);
      await refresh(config, "admin-token");
      expect(sent.warmups).toBe(2);

      await refresh(config, "gui-session");
      expect(sent.warmups).toBe(3);

      // The dashboard attempt failed too, so the backoff now runs from that attempt.
      clock.mockImplementation(() => start + 2 * PENDING_VALIDATION_RETRY_BACKOFF_MS - 2);
      await refresh(config, "admin-token");
      expect(sent.warmups).toBe(3);

      warmup = completedWarmup;
      clock.mockImplementation(() => start + 2 * PENDING_VALIDATION_RETRY_BACKOFF_MS - 1);
      await refresh(config, "admin-token");
      expect(sent.warmups).toBe(4);
      expect(readCodexAccountRecord(ACCOUNT_ID)?.codexValidationPending).toBeUndefined();
      expect(readCodexAccountRecord(ACCOUNT_ID)?.lastCodexValidationAttemptFailedAt).toBeUndefined();
    } finally { clock.mockRestore(); }
  });

  test("a warm-up refused with HTTP 403 is not re-sent by admin-token refreshes at any age, only by a dashboard session", async () => {
    const config = pendingPool(true);
    const start = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => start);
    try {
      const sent = fakeUpstream(weeklyUsage(12), () => new Response("forbidden", { status: 403 }));
      await refresh(config, "admin-token");
      expect(sent.warmups).toBe(1);
      expect(readCodexAccountRecord(ACCOUNT_ID)).toMatchObject({ codexValidationPending: true, lastCodexValidationError: "http_status:403" });
      clock.mockImplementation(() => start + 10 * PENDING_VALIDATION_RETRY_BACKOFF_MS);
      await refresh(config, "admin-token");
      expect(sent.warmups).toBe(1);
      await refresh(config, "gui-session");
      expect(sent.warmups).toBe(2);
    } finally { clock.mockRestore(); }
  });

  test("a repeated skip is logged once per account until the outcome changes or a failure intervenes", async () => {
    const config = pendingPool(true);
    const incomplete = () => Response.json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } } });
    let usage: () => Response = incomplete;
    fakeUpstream(() => usage(), () => new Response("upstream unavailable", { status: 500 }));
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await refresh(config, "admin-token");
      await refresh(config, "admin-token");
      usage = weeklyUsage(100);
      await refresh(config, "gui-session");
      await refresh(config, "gui-session");
      usage = weeklyUsage(12);
      await refresh(config, "gui-session");
      usage = weeklyUsage(100);
      await refresh(config, "gui-session");
      const prefix = `[codex] pool validation account=\u2026${ACCOUNT_ID.slice(-4)} `;
      expect(warnings.mock.calls.map(call => String(call[0])).filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length))).toEqual([
        "skipped reason=usage_incomplete",
        "skipped reason=usage_exhausted window=weekly",
        "failed reason=http_status:500",
        "skipped reason=usage_exhausted window=weekly",
      ]);
    } finally { warnings.mockRestore(); }
  });

  test.each([
    { name: "an exhausted weekly window", usage: weeklyUsage(100), reason: "skipped reason=usage_exhausted window=weekly" },
    { name: "an exhausted short window", reason: "skipped reason=usage_exhausted window=short", usage: () => Response.json({ plan_type: "pro", rate_limit: {
      primary_window: { used_percent: 100, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604_800 } } }) },
    { name: "a reading without the plan's governing window", reason: "skipped reason=usage_incomplete", usage: () => Response.json({ plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } } }) },
  ])("$name skips the warm-up and names its own reason", async ({ usage, reason }) => {
    const config = pendingPool(true);
    const sent = fakeUpstream(usage, completedWarmup);
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await refresh(config, "admin-token");
      expect(warnings.mock.calls.map(call => String(call[0])).filter(line => line.includes("pool validation")))
        .toEqual([`[codex] pool validation account=…${ACCOUNT_ID.slice(-4)} ${reason}`]);
    } finally { warnings.mockRestore(); }
    expect(sent.warmups).toBe(0);
    expect(readCodexAccountRecord(ACCOUNT_ID)?.codexValidationPending).toBe(true);
  });

  test("GET /api/settings reports the setting; a caller without a dashboard session can turn it off but not on", async () => {
    const config = pendingPool(false);
    const settings = async (body?: unknown) => {
      const req = new Request("http://127.0.0.1:10100/api/settings", {
        method: body === undefined ? "GET" : "PUT",
        headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const response = await handleManagementAPI(req, new URL(req.url), config, { getCachedStartupHealth: async () => startupHealthFixture() }, "admin-token");
      return { status: response!.status, body: await response!.json() as { codexPendingValidationByAdminRefresh?: boolean; code?: string } };
    };
    expect((await settings()).body.codexPendingValidationByAdminRefresh).toBe(false);
    expect((await settings({ codexPendingValidationByAdminRefresh: "yes" })).status).toBe(400);
    const refused = await settings({ codexPendingValidationByAdminRefresh: true });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("agent_consent_required");
    expect(config.codexPendingValidationByAdminRefresh).toBeUndefined();
    expect(loadConfig().codexPendingValidationByAdminRefresh).toBeUndefined();

    // What `ocx config set codexPendingValidationByAdminRefresh true` leaves for the next start.
    config.codexPendingValidationByAdminRefresh = true;
    saveConfig(config);
    expect((await settings()).body.codexPendingValidationByAdminRefresh).toBe(true);
    expect((await settings({ codexPendingValidationByAdminRefresh: false })).body.codexPendingValidationByAdminRefresh).toBe(false);
    expect(Object.hasOwn(loadConfig(), "codexPendingValidationByAdminRefresh")).toBe(false);
  });
});
