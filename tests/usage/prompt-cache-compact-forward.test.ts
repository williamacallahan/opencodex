/** Native compact stamps the configured provider at its physical send, so a namespaced forward send reads the registry. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth } from "../../src/codex/auth-api";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearUpstreamHostHealth } from "../../src/codex/upstream-host-health";
import { clearPoolRecoveryState } from "../../src/routing/probe-lease";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { addFinalRequestLog, beginRequestAttempt, type RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ACCOUNT = "work";
const HOME_KEYS = ["HOME", "OPENCODEX_HOME", "CODEX_HOME"] as const;
const RealFetch = globalThis.fetch;
let home = "";
let previousHomes: Array<string | undefined> = [];
let releaseSpendHome: (() => void) | undefined;

function clearPoolState(): void {
  clearAccountNeedsReauth(ACCOUNT);
  clearCodexUpstreamHealth();
  clearUpstreamHostHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearPoolRecoveryState();
  clearAccountQuota();
}

beforeEach(() => {
  previousHomes = HOME_KEYS.map(key => process.env[key]);
  home = mkdtempSync(join(tmpdir(), "ocx-compact-cache-forward-"));
  for (const key of HOME_KEYS) process.env[key] = home;
  releaseSpendHome = acquireOwnedSpendHome();
  clearPoolState();
  setAccountQuotaFromParsed(ACCOUNT, { weeklyPercent: 10 });
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify({
    [ACCOUNT]: {
      credential: { accessToken: "work-access", refreshToken: "work-grant", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "acc-work" },
      generation: 1,
      refreshGrantFingerprint: createHash("sha256").update("codex-refresh-grant:work-grant").digest("hex"),
    },
  }));
  globalThis.fetch = (async () => Response.json({ id: "cmp_1", object: "response.compaction", output: [] })) as typeof fetch;
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = RealFetch;
  clearPoolState();
  for (const [index, key] of HOME_KEYS.entries()) {
    if (previousHomes[index] === undefined) delete process.env[key];
    else process.env[key] = previousHomes[index];
  }
  removeTreeWithRetry(home);
});

const forwardConfig = (): OcxConfig => ({
  port: 0,
  defaultProvider: "openai",
  providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } },
  activeCodexAccountId: ACCOUNT,
  autoSwitchThreshold: 0,
  accountPoolStrategy: "round-robin",
  codexAccounts: [{ id: ACCOUNT, label: ACCOUNT }],
  codexAccountNamespaces: { work: ACCOUNT },
}) as OcxConfig;

const keyConfig = (): OcxConfig => ({
  port: 0,
  defaultProvider: "openai-apikey",
  providers: { "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key", apiKey: "fixture-key-alpha" } },
}) as OcxConfig;

async function compact(config: OcxConfig, model: string): Promise<RequestLogContext> {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  logCtx.activeAttempt = beginRequestAttempt(1, "", "", "openai-responses");
  const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: [{ role: "user", content: "compact this" }] }),
  }), config, logCtx);
  expect(response.status).toBe(200);
  await response.text();
  return logCtx;
}

/** The same cold, eligible prompt the namespace test uses: 166045 input tokens, none cached. */
function outcomeLine(logCtx: RequestLogContext): string {
  logCtx.usageWireParsed = true;
  logCtx.usage = { inputTokens: 166045, outputTokens: 1, cachedInputTokens: 0 };
  const info = console.info; const lines: string[] = [];
  console.info = ((line: string) => { lines.push(String(line)); }) as typeof console.info;
  try { addFinalRequestLog("req-compact-forward-1", Date.now(), logCtx, 200, undefined, () => {}); }
  finally { console.info = info; }
  return lines.filter(line => line.includes("event=prompt_cache.outcome"))[0]!;
}

test("a forward compact under an account namespace reports the first-party counter", async () => {
  const logCtx = await compact(forwardConfig(), "work/gpt-5.5");
  expect(logCtx.provider).toBe("openai-work");
  expect(logCtx.sentProvider).toBe("openai");
  expect(outcomeLine(logCtx)).toContain("telemetry=reported cache_eligible=true");
});

test("a key compact records exactly one attempt identity", async () => {
  const logCtx = await compact(keyConfig(), "openai-apikey/test");
  expect(logCtx.sentProvider).toBe("openai-apikey");
  expect(logCtx.activeAttempt?.sendCount).toBe(1);
});
