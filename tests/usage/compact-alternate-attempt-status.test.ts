/** A forward pool compact that moves to another account seals the first account's attempt with the status it answered. */
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
const OTHER = "other";
const HOME_KEYS = ["HOME", "OPENCODEX_HOME", "CODEX_HOME"] as const;
const RealFetch = globalThis.fetch;
let home = "";
let previousHomes: Array<string | undefined> = [];
let releaseSpendHome: (() => void) | undefined;

function clearPoolState(): void {
  for (const id of [ACCOUNT, OTHER]) clearAccountNeedsReauth(id);
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
  for (const id of [ACCOUNT, OTHER]) setAccountQuotaFromParsed(id, { weeklyPercent: 10 });
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify(Object.fromEntries([ACCOUNT, OTHER].map(id => [id, {
    credential: { accessToken: `${id}-access`, refreshToken: `${id}-grant`, expiresAt: Date.now() + 3_600_000, chatgptAccountId: `acc-${id}` },
    generation: 1,
    refreshGrantFingerprint: createHash("sha256").update(`codex-refresh-grant:${id}-grant`).digest("hex"),
  }]))));
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


const poolConfig = (): OcxConfig => ({
  port: 0,
  defaultProvider: "openai",
  providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } },
  activeCodexAccountId: ACCOUNT,
  autoSwitchThreshold: 0,
  accountPoolStrategy: "round-robin",
  codexAccounts: [ACCOUNT, OTHER].map(id => ({ id, label: id })),
}) as OcxConfig;

const answers: Array<() => Response> = [];
const sends: Array<string | null> = [];
function upstream(...next: Array<() => Response>): void {
  answers.splice(0, answers.length, ...next);
  sends.length = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sends.push(new Headers(init?.headers).get("authorization"));
    return (answers[sends.length - 1] ?? answers.at(-1)!)();
  }) as typeof fetch;
}
const compacted = (): Response => Response.json({ id: "cmp_1", object: "response.compaction", output: [] });
const quota429 = (): Response => Response.json({ error: { message: "quota exceeded" } }, { status: 429, headers: { "retry-after": "600" } });
const overloaded = (): Response => Response.json({ error: { type: "server_error", code: "server_is_overloaded", message: "overloaded" } }, { status: 503 });

async function movedCompact(): Promise<RequestLogContext> {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  logCtx.activeAttempt = beginRequestAttempt(1, "", "", "openai-responses");
  const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", input: [{ role: "user", content: "compact this" }] }),
  }), poolConfig(), logCtx);
  expect(response.status).toBe(200);
  await response.text();
  addFinalRequestLog("req-compact-move-1", Date.now(), logCtx, 200, undefined, () => {});
  return logCtx;
}

test("a quota 429 on A moves to B and persists A as 429 with its recovery, B as 200", async () => {
  upstream(quota429, compacted);
  const logCtx = await movedCompact();
  expect(sends).toEqual(["Bearer work-access", "Bearer other-access"]);
  const [first, second] = logCtx.attempts!;
  expect(first).toMatchObject({ status: 429, sendCount: 1, recoveryKinds: [] });
  expect(second).toMatchObject({ status: 200, sendCount: 1, recoveryKinds: ["oauth-account-429"] });
});

test("a transient 5xx that survives A's ladder persists A as 503, B as 200", async () => {
  upstream(overloaded, overloaded, overloaded, compacted);
  const logCtx = await movedCompact();
  const [first, second] = logCtx.attempts!;
  expect(first!.status).toBe(503);
  expect(second).toMatchObject({ status: 200, recoveryKinds: ["transient-5xx"] });
});
