import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown, pickComboTarget, pickComboTargetWithWait } from "../../src/combos";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { NATIVE_GPT6_ASTRA_MINOR_MODEL } from "../../src/codex/catalog/native-models";
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

test("a reset window makes the pool target selectable without clearing its cooldown on a pick", () => {
  spendWholePool();
  coolComboTarget("sol", POOL, { retryAfter: "86400", status: 429 });
  setAccountQuotaFromParsed("pool-reset", { weeklyPercent: 0, weeklyResetAt: weekAhead() });
  expect(pickComboTarget(config(), "sol")?.target.provider).toBe("openai");
  expect(isComboTargetInCooldown("sol", POOL)).toBe(true);
});

test("a Luna pool quota cooldown releases when a spent account can try Reserve", () => {
  const pool = { ...POOL, model: "gpt-6-luna" };
  const cfg = config();
  cfg.providers.relay = { ...cfg.providers.relay!, models: [pool.model] };
  cfg.combos = { luna: { strategy: "failover", targets: [pool, { ...RELAY, model: pool.model }] } };
  const now = Date.now();
  spendWholePool();
  coolComboTarget("luna", pool, { retryAfter: "86400", status: 429 });
  for (const id of ACCOUNTS) {
    setAccountQuotaFromParsed(id, { customWindows: [{ label: "Luna Reserve", percent: 100, resetAt: weekAhead(), observedAt: now }] });
  }
  expect(pickComboTarget(cfg, "luna")?.target.provider).toBe("relay");

  setAccountQuotaFromParsed("pool-reset", { customWindows: [] });
  expect(pickComboTarget(cfg, "luna")?.target.provider).toBe("openai");
});

test("a server-error cooldown on the pool target is not lifted by pool capacity", () => {
  coolComboTarget("sol", POOL, { status: 502 });
  expect(pickComboTarget(config(), "sol")?.target.provider).toBe("relay");
});

test("a direct-mode openai row keeps its cooldown: the caller's own login serves it, not the pool", () => {
  const cfg = config();
  cfg.providers.openai = { ...cfg.providers.openai!, codexAccountMode: "direct" };
  coolComboTarget("sol", POOL, { retryAfter: "86400", status: 429 });
  expect(pickComboTarget(cfg, "sol")?.target.provider).toBe("relay");
});

test("an account-gated model keeps its cooldown even while other pool accounts are eligible", () => {
  const gated = { provider: "openai", model: NATIVE_GPT6_ASTRA_MINOR_MODEL };
  const cfg = config();
  cfg.combos = { minor: { strategy: "failover", targets: [gated, RELAY] } };
  coolComboTarget("minor", gated, { retryAfter: "86400", status: 429 });
  expect(pickComboTarget(cfg, "minor")?.target.provider).toBe("relay");
});

test("a released pool target spends no cooled-sibling reprobe", async () => {
  const cfg = config();
  cfg.combos = { sol: { strategy: "failover", targets: [POOL, RELAY], cooldownReprobe: { enabled: true } } };
  coolComboTarget("sol", POOL, { retryAfter: "86400", status: 429 });
  coolComboTarget("sol", RELAY, { status: 502 });
  const pick = await pickComboTargetWithWait(cfg, "sol", { waitForCooldownMs: 0 });
  expect(pick?.target.provider).toBe("openai");
  expect(Object.keys(pick?.cooldownReprobeTargets ?? {})).toEqual([]);
});
