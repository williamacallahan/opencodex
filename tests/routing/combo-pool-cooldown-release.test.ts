import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown, pickComboTarget } from "../../src/combos";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const POOL = { provider: "openai", model: "gpt-6.2-sol" };
const RELAY = { provider: "relay", model: "gpt-6.2-sol" };
const ACCOUNTS = ["pool-spent", "pool-reset"];
const weekAhead = () => Math.floor(Date.now() / 1000) + 6 * 86_400;
let home: string;
const previous = { opencodex: process.env.OPENCODEX_HOME, codex: process.env.CODEX_HOME };

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "relay",
    providers: {
      openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
      relay: { adapter: "openai-responses", baseUrl: "https://relay.example/backend-api/codex", apiKey: "k", models: ["gpt-6.2-sol"], liveModels: false },
    },
    codexAccounts: ACCOUNTS.map(id => ({ id, email: `${id}@example.test`, isMain: false })),
    combos: { sol: { strategy: "failover", targets: [POOL, RELAY] } },
  };
}

/** Every pool account at a full weekly window that resets next week. */
function spendWholePool(): void {
  for (const id of ACCOUNTS) setAccountQuotaFromParsed(id, { weeklyPercent: 100, weeklyResetAt: weekAhead() });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-pool-cooldown-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  clearComboTargetCooldowns();
  clearComboSelectionState();
  clearCodexUpstreamHealth();
  for (const id of ACCOUNTS) {
    saveCodexAccountCredential(id, {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: `acct-${id}`,
    });
  }
});
afterEach(() => {
  clearComboTargetCooldowns();
  for (const id of ACCOUNTS) clearAccountQuota(id);
  for (const [key, value] of [["OPENCODEX_HOME", previous.opencodex], ["CODEX_HOME", previous.codex]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(home);
});

test("a day-long pool quota cooldown holds while every pool account is spent", () => {
  spendWholePool();
  coolComboTarget("sol", POOL, { retryAfter: "86400", status: 429 });
  expect(pickComboTarget(config(), "sol")?.target.provider).toBe("relay");
  expect(isComboTargetInCooldown("sol", POOL)).toBe(true);
});

test("the pool target returns as soon as one pool account's window resets", () => {
  spendWholePool();
  coolComboTarget("sol", POOL, { retryAfter: "86400", status: 429 });
  setAccountQuotaFromParsed("pool-reset", { weeklyPercent: 0, weeklyResetAt: weekAhead() });
  expect(pickComboTarget(config(), "sol")?.target.provider).toBe("openai");
  expect(isComboTargetInCooldown("sol", POOL)).toBe(false);
});

test("a server-error cooldown on the pool target is not lifted by pool capacity", () => {
  coolComboTarget("sol", POOL, { status: 502 });
  expect(pickComboTarget(config(), "sol")?.target.provider).toBe("relay");
});
