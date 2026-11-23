import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_MAX_RESERVE_REFUSAL_BACKOFF_MS, computeReserveRefusalCooldown } from "../../src/codex/routing/cooldown-math";
import {
  clearCodexAccountCooldown,
  flushCodexHealthCooldowns,
  getCodexAccountCooldownUntil,
  noteScopedCodexSuccess,
  reloadCodexHealthCooldownsForTests,
  scopedHealthFor,
} from "../../src/codex/routing/health-store";
import {
  clearCodexCooldownRecoveryProbeState,
  runCodexCooldownRecoveryProbes,
} from "../../src/codex/auth-api";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota } from "../../src/codex/quota";
import {
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  claimDueCodexQuotaRecoveryProbes,
  clearCodexUpstreamHealth,
  codexQuotaScopeForModel,
  getCodexQuotaHealthSnapshot,
  recordCodexUpstreamOutcome,
  tryAcquireCodexQuotaScopeProbeLease,
  type CodexQuotaScope,
} from "../../src/codex/routing";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const START = 1_800_000_000_000;
const DUE = START + CODEX_QUOTA_PROBE_INTERVAL_MS + 2;
const MODELS = {
  shared: "gpt-5.6-sol",
  reserve: "gpt-reserve",
} satisfies Record<CodexQuotaScope, string>;

// Added-account state deliberately exercises the generic worker's claim filter.
// It does not represent an allowed added-account Reserve dispatch.
function makeConfig(): OcxConfig {
  return {
    port: 0,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    defaultProvider: "openai",
    activeCodexAccountId: "reserve-fixture",
    accountPoolStrategy: "fill-first",
    codexAccounts: [{ id: "reserve-fixture", email: "reserve@example.test", plan: "team", isMain: false }],
  } as OcxConfig;
}

function cool(config: OcxConfig, scope: CodexQuotaScope, now = START): void {
  recordCodexUpstreamOutcome(config, "reserve-fixture", 429, {
    modelId: MODELS[scope],
    resetAt: now + 60 * 60_000,
    fixedAccount: true,
    now,
  });
}

describe("Reserve quota scope", () => {
  let directory: string;
  let previousHome: string | undefined;
  let previousCodexHome: string | undefined;
  let previousFetch: typeof fetch;
  let calls: number;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    previousFetch = globalThis.fetch;
    directory = mkdtempSync(join(tmpdir(), "ocx-reserve-quota-scope-"));
    process.env.OPENCODEX_HOME = directory;
    process.env.CODEX_HOME = join(directory, "codex");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearCodexCooldownRecoveryProbeState();
    saveCodexAccountCredential("reserve-fixture", {
      accessToken: "reserve-quota-fixture-access",
      refreshToken: "reserve-quota-fixture-refresh",
      expiresAt: Date.now() + 60 * 60_000,
      chatgptAccountId: "reserve-quota-fixture-account",
    });
    calls = 0;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls += 1;
      expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
      expect(new Headers(init?.headers).get("x-openai-codex-luna-reserve")).toBe("1");
      return Response.json({
        plan_type: "team",
        rate_limit: { secondary_window: { used_percent: 10, reset_at: 1_900_000_000 } },
      });
    }, { preconnect: previousFetch.preconnect });
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    // Cancels the quota writer's pending persistence timer before restoring homes.
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearCodexCooldownRecoveryProbeState();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(directory);
  });

  test("maps only the exact Reserve wire model into its independent scope", () => {
    expect(codexQuotaScopeForModel("gpt-reserve")).toBe("reserve");
    expect(codexQuotaScopeForModel(" GPT-RESERVE ")).toBe("reserve");
    expect(codexQuotaScopeForModel("gpt-reserve-preview")).toBe("shared");
    expect(codexQuotaScopeForModel("main/gpt-reserve")).toBe("shared");
    expect(codexQuotaScopeForModel("gpt-5.3-codex-spark")).toBe("shared");
    expect(codexQuotaScopeForModel("gpt-5.6-luna")).toBe("shared");
    expect(codexQuotaScopeForModel(undefined)).toBeUndefined();
  });

  test("shared reset-derived limits do not imply Reserve exhaustion", () => {
    const config = makeConfig();
    cool(config, "shared");
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", START + 1)).toBeNull();
    cool(config, "reserve", START + 1);
    for (const scope of ["shared", "reserve"] as const) {
      expect(getCodexQuotaHealthSnapshot("reserve-fixture", scope, START + 2)).toMatchObject({
        quotaScope: scope,
        cooldownSource: "reset-derived",
      });
    }
  });

  test("Reserve exhaustion leaves shared quota usable", () => {
    const config = makeConfig();
    cool(config, "reserve");
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "shared", START + 1)).toBeNull();
  });

  test.each(["retry-after", "default"] as const)("%s remains account-wide and wins over Reserve scope", source => {
    const config = makeConfig();
    cool(config, "reserve");
    recordCodexUpstreamOutcome(config, "reserve-fixture", 429, {
      modelId: "gpt-reserve",
      fixedAccount: true,
      now: START + 1,
      ...(source === "retry-after" ? { retryAfter: "60", resetAt: START + 60 * 60_000 } : {}),
    });
    for (const scope of ["shared", "reserve"] as const) {
      expect(getCodexQuotaHealthSnapshot("reserve-fixture", scope, START + 2)).toEqual({
        cooldownUntil: START + 60_001,
        cooldownSource: source,
      });
    }
    // Expiring the shorter global throttle reveals, rather than erases, Reserve's cooldown.
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", START + 60_002))
      .toMatchObject({ quotaScope: "reserve", cooldownSource: "reset-derived" });
  });

  test("ordinary unleased native success does not clear Reserve health", () => {
    const config = makeConfig();
    cool(config, "reserve");
    const before = getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", START + 1);
    expect(before).not.toBeNull();
    for (const modelId of ["gpt-5.6-luna", "gpt-5.3-codex-spark", undefined]) {
      recordCodexUpstreamOutcome(config, "reserve-fixture", 200, { modelId, now: START + 2 });
      expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", START + 3)).toEqual(before);
    }
  });

  test("a leased Reserve success leaves shared cooldown and its lease intact", () => {
    // State-machine fixture only; this does not claim an added account can dispatch Reserve.
    const config = makeConfig();
    cool(config, "reserve");
    cool(config, "shared");
    const sharedLease = tryAcquireCodexQuotaScopeProbeLease("reserve-fixture", "shared", DUE);
    const reserveLease = tryAcquireCodexQuotaScopeProbeLease("reserve-fixture", "reserve", DUE);
    expect(sharedLease).toBeTruthy();
    expect(reserveLease).toBeTruthy();
    const shared = getCodexQuotaHealthSnapshot("reserve-fixture", "shared", DUE);
    recordCodexUpstreamOutcome(config, "reserve-fixture", 200, {
      modelId: "gpt-reserve", probeQuotaScope: "reserve", probeLeaseId: reserveLease!, now: DUE + 1,
    });
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", DUE + 1)).toBeNull();
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "shared", DUE + 1)).toEqual(shared);
    expect(tryAcquireCodexQuotaScopeProbeLease("reserve-fixture", "shared", DUE + 1)).toBeNull();
  });

  test("generic recovery never claims a Reserve-only cooldown or reads upstream", async () => {
    const config = makeConfig();
    cool(config, "reserve");
    expect(claimDueCodexQuotaRecoveryProbes(config, 4, DUE)).toEqual([]);
    await runCodexCooldownRecoveryProbes(config, DUE);
    expect(calls).toBe(0);
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", DUE + 1)).not.toBeNull();
  });

  test("generic recovery still clears an unscoped legacy reset without clearing Reserve", async () => {
    const config = makeConfig();
    cool(config, "reserve");
    recordCodexUpstreamOutcome(config, "reserve-fixture", 429, {
      resetAt: START + 60 * 60_000,
      fixedAccount: true,
      now: START + 1,
    });
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "shared", DUE))
      .toMatchObject({ cooldownSource: "reset-derived" });
    await runCodexCooldownRecoveryProbes(config, DUE);
    expect(calls).toBe(1);
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "shared", DUE + 1)).toBeNull();
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", DUE + 1))
      .toMatchObject({ quotaScope: "reserve", cooldownSource: "reset-derived" });
  });

  test.each([false, true])("shared WHAM recovery preserves Reserve, older Reserve=%s", async reserveFirst => {
    const config = makeConfig();
    cool(config, reserveFirst ? "reserve" : "shared");
    cool(config, reserveFirst ? "shared" : "reserve", START + 1);
    const before = getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", DUE);
    expect(before).not.toBeNull();
    await runCodexCooldownRecoveryProbes(config, DUE);
    expect(calls).toBe(1);
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "shared", DUE + 1)).toBeNull();
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", DUE + 1)).toEqual(before);
  });

  test("consecutive Reserve refusals back off with deterministic jitter and reset on success or manual clear", () => {
    const config = makeConfig();
    const t0 = Date.now();
    // 1st refusal stays on the 60s baseline.
    recordCodexUpstreamOutcome(config, "reserve-fixture", 429, { modelId: "gpt-reserve", poolReserve: true, now: t0 });
    const first = getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", t0 + 1);
    expect(first?.cooldownUntil).toBe(t0 + 60_000);
    expect(scopedHealthFor("reserve-fixture", "reserve")?.reserveRefusalStreak).toBe(1);

    // 2nd..5th consecutive refusals climb 5m -> 10m -> 20m -> 30m (+0..15% deterministic jitter).
    const tiers = [5 * 60_000, 10 * 60_000, 20 * 60_000, CODEX_MAX_RESERVE_REFUSAL_BACKOFF_MS];
    let t = t0;
    for (const baseMs of tiers) {
      t += CODEX_MAX_RESERVE_REFUSAL_BACKOFF_MS * 2;
      recordCodexUpstreamOutcome(config, "reserve-fixture", 429, { modelId: "gpt-reserve", poolReserve: true, now: t });
      const snap = getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", t + 1);
      expect(snap?.cooldownUntil).toBeGreaterThanOrEqual(t + baseMs);
      expect(snap?.cooldownUntil).toBeLessThanOrEqual(t + Math.round(baseMs * 1.15));
    }

    // Distinct accounts produce different jittered deadlines at the same tier.
    const alpha = computeReserveRefusalCooldown({ now: t0 }, 2, "acct-alpha").until;
    const beta = computeReserveRefusalCooldown({ now: t0 }, 2, "acct-beta").until;
    expect(alpha).not.toBe(beta);

    // Explicit Retry-After overrides exponential backoff.
    const explicit = computeReserveRefusalCooldown({ now: t0, retryAfter: "45" }, 4, "acct-alpha");
    expect(explicit).toEqual({ until: t0 + 45_000, source: "retry-after" });

    // Real Reserve completion resets streak back to 60s.
    t += CODEX_MAX_RESERVE_REFUSAL_BACKOFF_MS * 2;
    noteScopedCodexSuccess("reserve-fixture", "reserve", t, undefined);
    expect(scopedHealthFor("reserve-fixture", "reserve")?.reserveRefusalStreak).toBeUndefined();
    recordCodexUpstreamOutcome(config, "reserve-fixture", 429, { modelId: "gpt-reserve", poolReserve: true, now: t + 10 });
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", t + 11)?.cooldownUntil).toBe(t + 10 + 60_000);

    // Manual cooldown clear also resets the refusal streak.
    recordCodexUpstreamOutcome(config, "reserve-fixture", 429, { modelId: "gpt-reserve", poolReserve: true, now: t + 120_000 });
    expect(scopedHealthFor("reserve-fixture", "reserve")?.reserveRefusalStreak).toBe(2);
    expect(clearCodexAccountCooldown("reserve-fixture", t + 120_001)).toBe(true);
    expect(scopedHealthFor("reserve-fixture", "reserve")?.reserveRefusalStreak).toBeUndefined();
  });

  test("unexpired Reserve streak and account cooldown persist across reload and delete on recovery", () => {
    const config = makeConfig();
    const now = Date.now();
    // 2 consecutive Reserve refusals on reserve-fixture -> streak 2, 5m+ cooldown.
    recordCodexUpstreamOutcome(config, "reserve-fixture", 429, { modelId: "gpt-reserve", poolReserve: true, now });
    recordCodexUpstreamOutcome(config, "reserve-fixture", 429, { modelId: "gpt-reserve", poolReserve: true, now: now + 1000 });
    const persistedUntil = getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", now + 2000)?.cooldownUntil;
    expect(persistedUntil).toBeGreaterThanOrEqual(now + 1000 + 5 * 60_000);

    // Account-wide Retry-After cooldown on second account.
    recordCodexUpstreamOutcome(config, "other-seat", 429, { retryAfter: "600", fixedAccount: true, now });
    expect(flushCodexHealthCooldowns()).toBe(true);

    const storePath = join(directory, "codex-health-cooldowns.json");
    expect(existsSync(storePath)).toBe(true);
    const raw = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).length).toBeGreaterThanOrEqual(2);

    // Simulate process restart by dropping in-memory maps & reload watermark.
    reloadCodexHealthCooldownsForTests();
    const reloaded = getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", now + 2000);
    expect(reloaded?.cooldownUntil).toBe(persistedUntil);
    expect(scopedHealthFor("reserve-fixture", "reserve")?.reserveRefusalStreak).toBe(2);
    expect(getCodexAccountCooldownUntil("other-seat", now + 2000)).toBe(now + 600_000);

    // Next refusal after restart continues from streak=2 onto the 10m+ tier.
    recordCodexUpstreamOutcome(config, "reserve-fixture", 429, { modelId: "gpt-reserve", poolReserve: true, now: now + 3000 });
    const thirdUntil = getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", now + 3001)?.cooldownUntil;
    expect(thirdUntil).toBeGreaterThanOrEqual(now + 3000 + 10 * 60_000);

    // Clearing cooldown removes the disk entry so reload stays clear.
    expect(clearCodexAccountCooldown("reserve-fixture", now + 4000)).toBe(true);
    expect(flushCodexHealthCooldowns()).toBe(true);
    reloadCodexHealthCooldownsForTests();
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", now + 4001)).toBeNull();
    expect(scopedHealthFor("reserve-fixture", "reserve")).toBeUndefined();
  });
});
