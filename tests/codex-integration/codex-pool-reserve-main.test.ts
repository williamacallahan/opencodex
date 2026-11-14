import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { resetQuotaQueryBackoffForTests } from "../../src/codex/quota-query-backoff";
import { poolLunaReserveSelection } from "../../src/codex/pool-reserve";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { getEligiblePoolAccounts } from "../../src/codex/routing/selection";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const MAIN = "__main__";
const SEAT = "pool-reserve-main-seat";
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let now: number;
function config(): OcxConfig {
  return {
    port: 0, providers: { openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" } },
    codexMainAccountHardLock: false, accountPoolStrategy: "quota", autoSwitchThreshold: 0, activeCodexAccountId: SEAT,
    creditCodexAccountIds: [], codexAccounts: [{ id: SEAT, email: `${SEAT}@example.test`, isMain: false, plan: "pro" }],
  };
}
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME; previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-pool-reserve-main-"));
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  now = Date.now(); spyOn(Date, "now").mockImplementation(() => now);
  const acl = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => acl); setAsyncIcaclsRunnerForTests(async () => acl);
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); resetQuotaQueryBackoffForTests();
  clearAccountNeedsReauth(SEAT); clearAccountNeedsReauth(MAIN);
  saveCodexAccountCredential(SEAT, { accessToken: "fixture-access", refreshToken: "fixture-refresh",
    chatgptAccountId: "fixture-workspace", expiresAt: now + 86_400_000 });
});
afterEach(async () => {
  mock.restore(); clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState(); resetQuotaQueryBackoffForTests();
  await flushConfigDirHardeningForTests(); setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

/** The native `__main__` login has no stored row: its Reserve is its own per-request authorization, so pool Reserve selection never offers it. */
function candidates(mainLive: boolean) {
  const selection = poolLunaReserveSelection(config(), "gpt-6-luna", "shared",
    { isMainAccountTokenLive: () => mainLive }, undefined, undefined, now);
  return { selection, ids: getEligiblePoolAccounts(config(), undefined, now, selection.quotaScope, selection.options) };
}
function spendIncluded(id: string) { updateAccountQuota(id, 100, now + 86_400_000); }
function spendReserve(id: string) {
  setAccountQuotaFromParsed(id, { customWindows: [{ label: "Luna Reserve", percent: 100, resetAt: now + 604_800_000, observedAt: now }] });
}

test("__main__ without a credential is never a candidate, for Reserve or for included Luna", () => {
  spendIncluded(SEAT); updateAccountQuota(MAIN, 40, now + 86_400_000);
  const withReserve = candidates(false);
  expect(withReserve.selection.reserve).toBe(true);
  expect(withReserve.ids).toEqual([SEAT]);
  spendReserve(SEAT);
  const reserveSpent = candidates(false);
  expect(reserveSpent.selection.reserve).toBe(false);
  expect(reserveSpent.ids).toEqual([]);
});

test("__main__ with a credential never takes a Reserve turn: a depleted seat's Reserve is served first", () => {
  spendIncluded(SEAT); updateAccountQuota(MAIN, 40, now + 86_400_000);
  const { selection, ids } = candidates(true);
  expect(selection.reserve).toBe(true);
  expect(selection.quotaScope).toBe("reserve");
  expect(ids).toEqual([SEAT]);
});

test("__main__ with a credential and included usage serves Luna only once no seat can serve Reserve", () => {
  spendIncluded(SEAT); spendReserve(SEAT); updateAccountQuota(MAIN, 40, now + 86_400_000);
  const { selection, ids } = candidates(true);
  expect(selection.reserve).toBe(false);
  expect(ids).toEqual([MAIN]);
  updateAccountQuota(MAIN, 100, now + 86_400_000);
  expect(candidates(true).ids).toEqual([]);
});
