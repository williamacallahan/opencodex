import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../../src/codex/auth-api";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexQuotaHealthSnapshot } from "../../src/codex/routing";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown } from "../../src/combos";
import { handleResponses } from "../../src/server/responses";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { clearPoolRecoveryState } from "../../src/routing/probe-lease";
import { getRequestLogEntries, type RequestLogContext } from "../../src/server/request-log";
import { configureSharedSpendLedger, sharedSpendLedger, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import { createServeOptions } from "../../src/server/index/serve-options";
import type { OcxConfig } from "../../src/types";
import { BOUNDED_WS_RUNTIME } from "../helpers/ws-upstream-fixtures";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #8107 end to end: a failover combo whose native Codex target declines with a zero-output
 * `server_is_overloaded` must move on to its next target. The Codex WebSocket metadata channel
 * writes a `codex.rate_limits` frame ahead of `response.created`, and the combo preflight used to
 * treat that frame as output and commit the native child, so the overload reached the client in a
 * 200 stream and the second target was never dispatched.
 */

const WORK = "work";
const FALLBACK_URL = "https://combo-fixture.invalid/v1/responses";
const HOME_KEYS = ["HOME", "OPENCODEX_HOME", "CODEX_HOME"] as const;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;

type Listener = (event: unknown) => void;
const reasoning = { type: "reasoning", id: "rs_inspected", encrypted_content: "fixture-owner-cipher", summary: [] };
type TokenCounts = { input_tokens: number; output_tokens: number };
type FirstFrame = { afterCreated?: boolean; beforeError?: () => void; usage?: TokenCounts; response?: { id: string; usage?: TokenCounts }; status: number; code?: string | number; request?: { innererror: { code: string } }; detail?: string; error?: string | { code?: string; type?: string; message: string; innererror?: { code: string } } };
type Step = FirstFrame | "generic-hard-failure" | "held-hard-failure" | "issue-reasoning" | "first-quota" | "first-conflict" | "quota-then-refuse" | "quota-output-then-refuse" | "reserve-started-then-refuse"
  | "first-model-missing" | "first-model-missing-underscore" | "wrapped-quota" | "conflicting-wrapper" | "foreign-wrapper" | "missing-status" | "unknown-status";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static plan: Step[] = [];
  url: string;
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    const step = FakeWebSocket.plan[FakeWebSocket.instances.length] ?? "quota-then-refuse";
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.run(step));
  }

  run(step: Step) {
    this.emit("open", {});
    const id = `resp_${FakeWebSocket.instances.indexOf(this)}`;
    if (typeof step === "object") {
      const { afterCreated, beforeError, ...error } = step;
      if (afterCreated) this.frame({ type: "response.created", response: { id, status: "in_progress", output: [] } });
      beforeError?.();
      this.frame({ type: "error", ...error });
      return;
    }
    if (step === "held-hard-failure" || step === "generic-hard-failure") {
      this.frame({ type: "response.failed", code: "origin_rejected", headers: { "x-fixture-private": "not-for-client" }, response: { id, status: "failed", output: [], usage: { input_tokens: 7, output_tokens: 0 },
        error: { code: step === "generic-hard-failure" ? "server_error" : "overloaded_error", message: "Reserve refused", param: "input" } } });
      return;
    }
    if (step === "first-model-missing" || step === "first-model-missing-underscore") {
      this.frame({ type: "error", status: 400, error: { code: "model_not_found",
        type: step === "first-model-missing" ? "origin-rejected" : "origin_rejected", message: "Model unavailable" } });
      return;
    }
    if (step === "first-quota" || step === "first-conflict") {
      this.frame({ type: "error", status: 429, headers: { "retry-after": "120" },
        ...(step === "first-conflict" && { code: "origin_rejected" }),
        error: { code: "usage_limit_reached", message: "Limit reached" } });
      return;
    }
    this.frame({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, window_minutes: 10080 } } });
    this.frame({ type: "response.created", response: { id, status: "in_progress", output: [] } });
    this.frame({ type: "response.in_progress", response: { id, status: "in_progress", output: [] } });
    if (step === "issue-reasoning") {
      this.frame({ type: "response.output_item.done", response_id: id, output_index: 0, item: reasoning });
      this.frame({ type: "response.completed", response: { id, model: "gpt-6-luna", status: "completed", output: [reasoning] } });
      return;
    }
    if (step !== "quota-then-refuse" && step !== "reserve-started-then-refuse") {
      this.frame({ type: "response.output_item.added", response_id: id, output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] } });
    }
    if (step === "wrapped-quota" || step === "conflicting-wrapper" || step === "foreign-wrapper") {
      this.frame({ type: "error", response_id: step === "foreign-wrapper" ? "resp_other" : id, status_code: 429,
        headers: { "retry-after": "120" }, ...(step === "conflicting-wrapper" && { code: "origin_rejected" }),
        error: { type: "usage_limit_reached", message: "Limit reached" } });
    } else if (step === "missing-status" || step === "unknown-status") {
      this.frame({ type: "response.done", response: { id, ...(step === "unknown-status" && { status: "future" }),
        error: { code: "insufficient_quota", message: "Limit reached" } } });
    } else if (step === "reserve-started-then-refuse") {
      this.frame({ type: "response.failed", response: { id, status: "failed", output: [],
        error: { code: "usage_limit_reached", message: "Limit reached" } } });
    } else {
      this.frame({ type: "error", status: 503,
        error: { type: "server_error", code: "server_is_overloaded", message: "Our servers are currently overloaded; invalid_prompt rate is unchanged." } });
    }
  }

  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  frame(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  send(data: string) { this.sent.push(data); }

  close() { this.closed = true; }
}

const RealWebSocket = globalThis.WebSocket;
const RealFetch = globalThis.fetch;
let home = "";
let previousHomes: Array<string | undefined> = [];
let savedProxyEnv: Record<string, string | undefined> = {};
let releaseSpendHome: (() => void) | undefined;
let fallbackSends = 0;

function writeSeats(...ids: string[]): void {
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify(Object.fromEntries(ids.map(id => [id, {
    credential: { accessToken: `${id}-access`, refreshToken: `${id}-grant`,
      expiresAt: Date.now() + 3_600_000, chatgptAccountId: `acc-${id}` },
    generation: 1,
    refreshGrantFingerprint: createHash("sha256").update(`codex-refresh-grant:${id}-grant`).digest("hex"),
  }]))));
}

function clearState(): void {
  clearAccountNeedsReauth(WORK);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearAccountQuota();
  clearPoolRecoveryState();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearComboRecallForTests();
}

beforeEach(() => {
  savedProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  previousHomes = HOME_KEYS.map(key => process.env[key]);
  home = mkdtempSync(join(tmpdir(), "ocx-combo-codex-overload-"));
  for (const key of HOME_KEYS) process.env[key] = home;
  releaseSpendHome = acquireOwnedSpendHome();
  clearState();
  setAccountQuotaFromParsed(WORK, { weeklyPercent: 10 });
  writeSeats(WORK);
  FakeWebSocket.instances = [];
  FakeWebSocket.plan = [];
  fallbackSends = 0;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  // The native target must ride the WebSocket; only the keyed second target may use HTTP.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== FALLBACK_URL && url !== "https://combo-fixture.invalid/backend-api/codex/v1/responses") throw new Error(`unexpected HTTP send to ${url}`);
    fallbackSends += 1;
    const completed = { type: "response.completed",
      response: { id: "resp_fallback", status: "completed", model: "fallback-model", output: [] } };
    return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.WebSocket = RealWebSocket;
  globalThis.fetch = RealFetch;
  codexWsPool.dispose();
  clearState();
  for (const [index, key] of HOME_KEYS.entries()) {
    if (previousHomes[index] === undefined) delete process.env[key];
    else process.env[key] = previousHomes[index];
  }
  for (const key of PROXY_ENV_KEYS) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
  removeTreeWithRetry(home);
});

function comboConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
      fallback: {
        adapter: "openai-responses",
        baseUrl: "https://combo-fixture.invalid/v1",
        authMode: "key",
        apiKey: "synthetic-fixture",
        upstreamWebsocket: false,
      },
    },
    activeCodexAccountId: WORK,
    autoSwitchThreshold: 0,
    codexAccounts: [{ id: WORK, label: WORK }],
    combos: {
      overload: {
        alias: "chain/overload",
        strategy: "failover",
        waitForCooldownMs: 0,
        targets: [{ provider: "openai", model: "gpt-5.5" }, { provider: "fallback", model: "fallback-model" }],
      },
    },
  } as OcxConfig;
}

async function send(config = comboConfig(), input: unknown = "hello", thread?: string, model = "chain/overload") {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const request = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(thread && { "thread-id": thread }) },
    body: JSON.stringify({ model, input, stream: true, store: false, prompt_cache_key: thread }),
  });
  const response = await handleResponses(request, config, logCtx, {
    admission: { kind: "loopback", source: "loopback" },
    codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME,
    sendBudget: createRequestExecutionBudget(),
  });
  const body = await response.text().catch(error => `<body error: ${String(error)}>`);
  return { response, body, logCtx };
}

function sendWithSpendLedger(config: OcxConfig) {
  config.spend = { pool: { maxTokens: 1_000_000 } };
  configureSharedSpendLedger(spendPolicyFromConfig(config.spend, undefined, Object.keys(config.providers)));
  const options = createServeOptions({ config, deps: {}, managementApiDeps: {},
    ingressForServer: () => "public", packageTreeIntegrity: { status: () => ({ ok: true }) },
    runAdmittedHttpTurn: (_request: Request, _policy: unknown, run: () => Promise<Response>) => run(),
  } as unknown as Parameters<typeof createServeOptions>[0]);
  return options.fetch(new Request("http://localhost/v1/responses", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chain/overload", input: "hello", stream: true, max_output_tokens: 32 }),
  }), { timeout() {}, requestIP: () => null } as unknown as Parameters<typeof options.fetch>[1]);
}

function strictReserveConfig() {
  const cfg = comboConfig();
  for (const target of cfg.combos!.overload!.targets) target.model = "gpt-6-luna";
  cfg.providers.fallback!.baseUrl = "https://combo-fixture.invalid/backend-api/codex";
  cfg.codexAccounts![0]!.plan = "pro";
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  setAccountQuotaFromParsed(WORK, { weeklyPercent: 100, weeklyResetAt: resetAt,
    customWindows: [{ label: "Luna Reserve", percent: 10, observedAt: Date.now(), resetAt }] });
  return cfg;
}

describe("a failover combo moves past a native Codex overload that preceded any output (#8107)", () => {
  test.each(["chain/overload", "openai/gpt-5.5"])('masks every public diagnostic on %s', async model => {
    const cfg = model === "chain/overload" ? strictReserveConfig() : comboConfig();
    const marker = `${WORK}-access`;
    FakeWebSocket.plan = [{ status: 503, code: "invalid_prompt", error: { code: "server_is_overloaded", message: `Fixture diagnostic: ${marker}` } }];
    const { body } = await send(cfg, "hello", undefined, model);
    expect(body).toContain("Fixture diagnostic:");
    expect(body.includes(marker)).toBe(false);
  });

  test.each([{ code: "server_is_overloaded" }, { type: "overloaded_error" }])("policy precedence: a zero-output overload %j quoting a refusal reaches the combo fallback", async verdict => {
    const message = 'Queue full while recording "This request was flagged for possible cybersecurity risk."';
    FakeWebSocket.plan = [{ status: 503, error: { ...verdict, message } }];
    const { response, body, logCtx } = await send();
    expect(response.status).toBe(200);
    expect(body).toContain("resp_fallback");
    expect(logCtx.attempts?.[0]?.status).toBe(503);
    expect(fallbackSends).toBe(1);
  });

  test.each(["openai/gpt-5.5", "chain/overload"])("policy precedence: %s stops on a bare safety refusal in a generic server error", async model => {
    const message = "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
    FakeWebSocket.plan = [{ status: 503, error: { code: "server_error", message } }, "issue-reasoning"];
    const { body } = await send(comboConfig(), "hello", undefined, model);
    const terminal = body.split("event: response.failed\n")[1]?.split("\n")[0]?.replace(/^data: /, "");
    expect(JSON.parse(terminal ?? "null")?.response).toMatchObject({ error: { code: "invalid_prompt", message }, retryable: false });
    expect(FakeWebSocket.instances.flatMap(socket => socket.sent)).toHaveLength(1);
    expect(fallbackSends).toBe(0);
  });

  test("a nonfatal bare diagnostic is masked without changing its overload verdict", async () => {
    const marker = `${WORK}-access`;
    const refusal = { status: 503, error: { code: "server_is_overloaded", message: `Fixture diagnostic: invalid_prompt metric, ${marker}` } };
    FakeWebSocket.plan = [refusal, refusal, refusal];
    const { body } = await send(comboConfig(), "hello", undefined, "openai/gpt-5.5");
    expect(body).toContain("Fixture diagnostic:");
    expect(body).toContain("event: error\n");
    expect(body).toContain("server_is_overloaded");
    expect(body.includes(marker)).toBe(false);
  });

  test.each(["held-hard-failure", "generic-hard-failure"] as const)("an ordinary combo stops on %s without selecting fallback", async step => {
    FakeWebSocket.plan = [step];
    const { body, response, logCtx } = await send();
    expect(fallbackSends).toBe(0);
    expect(logCtx.attempts?.map(attempt => attempt.status)).toEqual([step === "held-hard-failure" ? 503 : 400]);
    expect(response.status).toBe(200);
    expect(body).toContain('"code":"invalid_prompt"');
    expect(body).toContain("Reserve refused");
  });

  test("an alternate seat's rejected credential becomes unavailable without a replay", async () => {
    const cfg = comboConfig();
    writeSeats(WORK, "backup");
    cfg.codexAccounts!.push({ id: "backup", label: "backup" });
    setAccountQuotaFromParsed("backup", { weeklyPercent: 50 });
    const marker = "backup-access";
    FakeWebSocket.plan = ["first-quota", { status: 401, code: "origin_rejected", error: { code: "token_invalidated", message: `Alternate rejected: ${marker}` } }];
    const fixtureFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => new URL(input instanceof Request ? input.url : String(input)).hostname === "auth.openai.com"
      ? Response.json({ error: "invalid_grant" }, { status: 400 }) : fixtureFetch(input, init)) as typeof fetch;
    try {
      const { response, body } = await send(cfg, "hello", undefined, "openai/gpt-6-luna");
      expect(response.status).toBe(401);
      expect(JSON.parse(body).error.message).toContain("Alternate rejected");
      expect(body.includes(marker)).toBe(false);
      expect(fallbackSends).toBe(0);
      expect(FakeWebSocket.instances.flatMap(ws => ws.sent)).toHaveLength(2);
      expect(isAccountNeedsReauth(WORK)).toBe(false);
      expect(isAccountNeedsReauth("backup")).toBe(true);
    } finally { clearAccountNeedsReauth("backup"); }
  });
  test("a rate-limit frame ahead of the preamble does not commit the native target", async () => {
    FakeWebSocket.plan = ["quota-then-refuse"];
    const { response, body, logCtx } = await send();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(fallbackSends).toBe(1);
    expect(response.status).toBe(200);
    expect(body).toContain("resp_fallback");
    expect(body).not.toContain("server_is_overloaded");
    // The refused native target's metadata never reaches the client of the replacement.
    expect(body).not.toContain("codex.rate_limits");
    // The pooled attempt's provider label carries an account suffix, so match its status instead.
    // The serving attempt settles its status asynchronously after the relay, so only its identity
    // is asserted here.
    expect(logCtx.attempts).toHaveLength(2);
    expect(logCtx.attempts?.[0]?.status).toBe(503);
    expect(logCtx.attempts?.[1]?.provider).toBe("fallback");
  });

  test("Reserve accepted before an empty quota terminal does not replay through the combo", async () => {
    FakeWebSocket.plan = ["reserve-started-then-refuse"];
    const config = comboConfig();
    const target = config.combos!.overload!.targets[0]!;
    target.model = "gpt-6-luna";
    coolComboTarget("overload", target, { status: 429, retryAfter: "86400" });
    config.codexAccounts![0]!.plan = "pro";
    const now = Date.now();
    setAccountQuotaFromParsed(WORK, { weeklyPercent: 100, weeklyResetAt: Math.floor(now / 1000) + 3_600,
      customWindows: [{ label: "Luna Reserve", percent: 10, observedAt: now, resetAt: Math.floor(now / 1000) + 3_600 }] });
    const { response, body } = await send(config);
    expect(FakeWebSocket.instances.flatMap(socket => socket.sent).map(frame => JSON.parse(frame).model)).toEqual(["gpt-reserve"]);
    expect(fallbackSends).toBe(0);
    expect(response.status).toBe(200);
    expect(body).toContain("response.failed");
    expect(body).not.toContain("resp_fallback");
    expect(isComboTargetInCooldown("overload", target)).toBe(true);
  });

  test("non-strict Reserve stops before an ordinary fallback on a hard first frame", async () => {
    const cfg = comboConfig();
    cfg.combos!.overload!.targets[0]!.model = "gpt-6-luna";
    cfg.codexAccounts![0]!.plan = "pro";
    const resetAt = Math.floor(Date.now() / 1000) + 3600;
    setAccountQuotaFromParsed(WORK, { weeklyPercent: 100, weeklyResetAt: resetAt,
      customWindows: [{ label: "Luna Reserve", percent: 10, observedAt: Date.now(), resetAt }] });
    FakeWebSocket.plan = [{ status: 503, code: "origin_rejected", error: { code: "server_is_overloaded", message: "Reserve refused" } }];
    const { body } = await send(cfg);
    expect(FakeWebSocket.instances.flatMap(ws => ws.sent).map(frame => JSON.parse(frame).model)).toEqual(["gpt-reserve"]);
    expect(fallbackSends).toBe(0);
    expect(body).toContain("Reserve refused");
  });

  test.each(["root", "innererror", "held-hard-failure"])("strict Reserve stops before the relay on a hard first-frame overload: %s", async source => {
    const cfg = strictReserveConfig();
    const stop = { code: "origin_rejected" };
    FakeWebSocket.plan = source === "held-hard-failure" ? [source] : [{ status: 503, ...(source === "root" && stop), error: { code: "server_is_overloaded",
      message: "Our servers are currently overloaded.", ...(source === "innererror" && { innererror: stop }) } }];
    const { response, body, logCtx } = await send(cfg);
    expect(response.status).toBe(200);
    if (source === "held-hard-failure") {
      expect(body).toContain('"id":"resp_0"');
      expect(body).toContain('"param":"input"');
      expect(body).not.toContain("not-for-client");
    }
    expect(logCtx.routeDecision?.selected.reason).toBe("luna-reserve-first");
    expect(FakeWebSocket.instances.flatMap(ws => ws.sent).map(frame => JSON.parse(frame).model)).toEqual(["gpt-reserve"]);
    expect(fallbackSends).toBe(0);
    expect(logCtx.attempts?.map(a => a.status)).toEqual([503]);
    const terminals = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
      .filter(event => event.type === "error" || event.type === "response.failed");
    expect(terminals.map(event => [event.type, event.response?.error?.code])).toEqual([["response.failed", "invalid_prompt"]]);
    expect(body).not.toContain("origin_rejected");
    expect(body).not.toContain("server_is_overloaded");
  });

  test.each(["wrapped-quota", "conflicting-wrapper", "foreign-wrapper", "missing-status", "unknown-status"] as const)(
    "committed Luna WebSocket quota evidence: %s", async terminal => {
      FakeWebSocket.plan = [terminal];
      const cfg = comboConfig();
      cfg.combos!.overload!.targets[0]!.model = "gpt-6-luna";
      const { body } = await send(cfg);
      expect(body).toContain("response.output_item.added");
      expect(fallbackSends).toBe(0);
      const cooldown = getCodexQuotaHealthSnapshot(WORK, "shared");
      if (terminal === "wrapped-quota") {
        expect(cooldown?.cooldownSource).toBe("retry-after");
        expect(cooldown?.confirmedCapacity).toBe(true);
      } else {
        expect(cooldown?.confirmedCapacity).toBeUndefined();
      }
    });

  test.each(["wrapped-quota", "unknown-status"] as const)("a verified ciphertext turn retains its WebSocket verdict: %s", async terminal => {
    FakeWebSocket.plan = ["issue-reasoning", terminal];
    const cfg = comboConfig();
    cfg.combos!.overload!.targets[0]!.model = "gpt-6-luna";
    const thread = `inspected-${terminal}`;
    expect((await send(cfg, "start", thread)).body).toContain(reasoning.encrypted_content);
    codexWsPool.dispose();
    const result = await send(cfg, [reasoning, { role: "user", content: "continue" }], thread);
    // A self-contained store:false turn is portable, so the issuing seat is a pin rather than a bound owner.
    expect(result.logCtx.routeDecision?.selected.reason).toBe("combo-conversation-pin");
    expect(FakeWebSocket.instances[1]?.sent.join("")).toContain(reasoning.encrypted_content);
    expect(result.body).toContain("response.output_item.added");
    expect(fallbackSends).toBe(0);
    const cooldown = getCodexQuotaHealthSnapshot(WORK, "shared");
    if (terminal === "wrapped-quota") {
      expect(cooldown?.confirmedCapacity).toBe(true);
      expect(cooldown?.cooldownSource).toBe("retry-after");
    } else expect(cooldown?.confirmedCapacity).toBeUndefined();
  });

  test.each([
    ["chain/overload", "first-conflict"], ["chain/overload", "first-quota"],
    ["openai/gpt-6-luna", "first-conflict"], ["openai/gpt-6-luna", "first-quota"],
  ] as const)("%s honors the first-frame 429 verdict: %s", async (model, terminal) => {
    FakeWebSocket.plan = [terminal];
    const cfg = comboConfig();
    cfg.combos!.overload!.targets = [{ provider: "openai", model: "gpt-6-luna" }];
    const { response } = await send(cfg, "hello", undefined, model);
    expect(response.status).toBe(429);
    const cooldown = getCodexQuotaHealthSnapshot(WORK, "shared");
    expect(cooldown?.cooldownSource).toBe("retry-after");
    expect(cooldown?.confirmedCapacity).toBe(terminal === "first-quota" ? true : undefined);
  });

  test.each([
    ["first-conflict", false], ["first-conflict", true], ["first-quota", true],
  ] as const)("unbound first-frame %s with alternate seat %s", async (refusal, alternate) => {
    const cfg = comboConfig();
    cfg.combos!.overload!.targets[0]!.model = "gpt-6-luna";
    if (alternate) {
      writeSeats(WORK, "backup");
      cfg.codexAccounts!.push({ id: "backup", label: "backup" });
      setAccountQuotaFromParsed("backup", { weeklyPercent: 50 });
    }
    FakeWebSocket.plan = [refusal, "issue-reasoning"];
    const result = await send(cfg);
    const cooldown = getCodexQuotaHealthSnapshot(WORK, "shared");
    expect(cooldown?.cooldownSource).toBe("retry-after");
    if (refusal === "first-conflict") {
      expect(cooldown?.confirmedCapacity).toBeUndefined();
      expect(result.response.status).toBe(429);
      expect(FakeWebSocket.instances.flatMap(ws => ws.sent)).toHaveLength(1);
    } else {
      expect(result.body).toContain(reasoning.encrypted_content);
      expect(FakeWebSocket.instances.flatMap(ws => ws.sent)).toHaveLength(2);
      expect(cooldown?.confirmedCapacity).toBe(true);
    }
    expect(fallbackSends).toBe(0);
  });

  test.each(["first-conflict", "first-quota", "first-model-missing-underscore"] as const)("a routing profile honors the native verdict: %s", async terminal => {
    const cfg = comboConfig();
    cfg.routingProfiles = { ordered: { candidates: cfg.combos!.overload!.targets } };
    FakeWebSocket.plan = [terminal];
    const { response, body, logCtx } = await send(cfg, "hello", undefined, "policy/ordered");
    expect(logCtx.routeDecision?.selected.provider).toBe("openai");
    expect(FakeWebSocket.instances.flatMap(ws => ws.sent)).toHaveLength(1);
    expect(fallbackSends).toBe(terminal === "first-conflict" ? 0 : 1);
    expect(response.status).toBe(terminal === "first-conflict" ? 429 : 200);
    expect(body).toContain(terminal === "first-conflict" ? "Limit reached" : "resp_fallback");
  });

  test.each(["token_invalidated", "invalid_api_key", "refresh_token_reused"])('a hard 401 maintains a rejected credential without replaying: %s', async code => {
    FakeWebSocket.plan = [{ status: 401, code: "origin_rejected", error: { code, message: "Fixture refusal" } }];
    const fixtureFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input)).hostname !== "auth.openai.com") return fixtureFetch(input, init);
      return code === "invalid_api_key"
        ? Response.json({ access_token: "fixture-replacement", refresh_token: "fixture-grant", expires_in: 3600 })
        : Response.json({ error: "invalid_grant" }, { status: 400 });
    }) as typeof fetch;
    const { body, response } = await send();
    expect(response.status).toBe(401);
    expect(body).toContain("Fixture refusal");
    expect(fallbackSends).toBe(0);
    expect(FakeWebSocket.instances.flatMap(ws => ws.sent)).toHaveLength(1);
    if (code === "invalid_api_key") {
      expect((await Bun.file(join(home, "codex-accounts.json")).json())[WORK].credential.accessToken).toBe("fixture-replacement");
    } else expect(isAccountNeedsReauth(WORK)).toBe(true);
  });

  test("a replay whose replacement bearer is explicitly rejected retires that bearer", async () => {
    const error = { code: "token_invalidated", message: "Replacement rejected" };
    FakeWebSocket.plan = [{ status: 401, error }, { status: 401, code: "origin_rejected", error }];
    const fixtureFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => new URL(input instanceof Request ? input.url : String(input)).hostname === "auth.openai.com"
      ? Response.json({ access_token: "fixture-replacement", refresh_token: "fixture-grant", expires_in: 3600 })
      : fixtureFetch(input, init)) as typeof fetch;
    const { response, body } = await send();
    expect(response.status).toBe(401);
    expect(body).toContain("Replacement rejected");
    expect(FakeWebSocket.instances.flatMap(ws => ws.sent)).toHaveLength(2);
    expect(fallbackSends).toBe(0);
    expect(isAccountNeedsReauth(WORK)).toBe(true);
  });

  test("a restored strict refusal writes one final HTTP request row and settles spend", async () => {
    FakeWebSocket.plan = ["held-hard-failure"];
    const response = await sendWithSpendLedger(strictReserveConfig());
    expect(await response.text()).toContain("Reserve refused");
    const rows = getRequestLogEntries().filter(row => row.requestId === response.headers.get("x-opencodex-request-id"));
    expect(rows.map(row => row.status)).toEqual([503]);
    expect(rows[0]?.spend).toMatchObject({ sends: 1, settled: 1, unresolved: 0 });
    expect(sharedSpendLedger().snapshot("pool", "openai")).toMatchObject({ reserved: 0, settled: 7, unresolved: 0 });
  });

  test.each([
    [401, "invalid_authentication", "openai/gpt-5.5", false],
    [403, "token_invalidated", "chain/overload", false],
    [403, "token_invalidated", "chain/overload", true],
  ] as const)("committed credential rejection: %i %s on %s (replaced=%s)", async (status, code, model, replaced) => {
    FakeWebSocket.plan = [{ afterCreated: true, status, error: { code, message: "Fixture bearer rejected" },
      beforeError: () => {
        if (replaced) saveCodexAccountCredential(WORK, { accessToken: "fixture-new-access", refreshToken: "fixture-new-grant",
          expiresAt: Date.now() + 3_600_000, chatgptAccountId: `acc-${WORK}` });
      },
    }];
    const { body, logCtx } = await send(comboConfig(), "hello", undefined, model);
    expect(isAccountNeedsReauth(WORK)).toBe(!replaced);
    expect(FakeWebSocket.instances.flatMap(ws => ws.sent)).toHaveLength(1);
    expect(fallbackSends).toBe(0);
    expect(logCtx.terminalHttpStatus).toBe(status);
    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.failed");
    expect(body).toContain('"retryable":false');
  });

  test.each([401, 403])("a committed origin %i without credential evidence leaves the seat selectable", async status => {
    FakeWebSocket.plan = [{ afterCreated: true, status, code: "origin_rejected", error: { message: "Turn declined" } }, "issue-reasoning"];
    const direct = () => send(comboConfig(), "hello", undefined, "openai/gpt-5.5");
    const refused = await direct();
    expect(refused.body).toContain("event: response.failed");
    expect(refused.logCtx.terminalHttpStatus).toBe(status);
    expect((await direct()).body).toContain("event: response.completed");
  });

  test.each([
    [false, 403, "token_invalidated"], [true, 403, "token_invalidated"], [true, 401, "invalid_authentication"],
  ] as const)("after created=%s, a hard %i with %s retires its seat", async (afterCreated, status, code) => {
    FakeWebSocket.plan = [{ afterCreated, status, code: "origin_rejected", error: { code, message: "Fixture refusal" } }, "issue-reasoning"];
    const direct = () => send(comboConfig(), "hello", undefined, "openai/gpt-5.5");
    expect((await direct()).body).toContain("Fixture refusal");
    expect((await direct()).body).toContain("needs reauthentication");
    expect(FakeWebSocket.instances.flatMap(ws => ws.sent)).toHaveLength(1);
  });

  test.each(["upstream_server_error", "invalid_request_error"])("policy precedence: a direct %s preserves the cyber refusal on the wire", async code => {
    const message = "This request was flagged for possible cybersecurity risk.";
    FakeWebSocket.plan = [{ status: 503, error: { code, message } }, "issue-reasoning"];
    const { body } = await send(comboConfig(), "hello", undefined, "openai/gpt-5.5");
    const terminal = body.split("event: response.failed\n")[1]?.split("\n")[0]?.replace(/^data: /, "");
    expect(JSON.parse(terminal ?? "null")?.response).toMatchObject({ error: { code: "cyber_policy", message }, retryable: false });
    expect(FakeWebSocket.instances.flatMap(socket => socket.sent)).toHaveLength(1);
  });

  test.each([
    ["detail", "This request was flagged for possible cybersecurity risk.", "cyber_policy"],
    ["error", "This request was blocked by our safety systems.", "invalid_prompt"],
  ] as const)("policy precedence: a WebSocket string %s stops the turn", async (field, message, code) => {
    FakeWebSocket.plan = [{ status: 503, [field]: message }, "issue-reasoning"];
    const { body } = await send();
    const terminal = body.split("event: response.failed\n")[1]?.split("\n")[0]?.replace(/^data: /, "");
    expect(JSON.parse(terminal ?? "null")?.response).toMatchObject({ error: { code, message }, retryable: false });
    expect(FakeWebSocket.instances.flatMap(socket => socket.sent)).toHaveLength(1);
    expect(fallbackSends).toBe(0);
  });

  test("a direct wrapped 503 carrying only safety refusal copy is never resent", async () => {
    const message = "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
    FakeWebSocket.plan = [{ status: 503, error: { message } }, "issue-reasoning"];
    const { body } = await send(comboConfig(), "hello", undefined, "openai/gpt-5.5");
    expect(body).toContain('"code":"invalid_prompt"');
    expect(body).toContain(message);
    expect(FakeWebSocket.instances.flatMap(ws => ws.sent)).toHaveLength(1);
  });

  test.each([
    [false, undefined], [true, undefined], [true, { id: "resp_0" }],
    [true, { id: "resp_0", usage: { input_tokens: 17, output_tokens: 3 } }],
  ] as const)("a hard 403 preserves usage (after created=%s, nested response=%j)", async (afterCreated, response) => {
    const usage = { input_tokens: 13, output_tokens: 2 };
    FakeWebSocket.plan = [{ afterCreated, response, status: 403, code: "origin_rejected", usage, error: { message: "Turn declined" } }];
    const result = await send(comboConfig(), "hello", undefined, "openai/gpt-5.5");
    const expected = response && "usage" in response ? response.usage : usage;
    if (afterCreated) expect(result.logCtx.usage).toMatchObject({ inputTokens: expected.input_tokens, outputTokens: expected.output_tokens });
    else {
      expect(result.response.status).toBe(403);
      expect(JSON.parse(result.body).usage).toEqual(expected);
    }
  });

  test("terminal send accounting settles a first-frame hard 403 from its reported usage", async () => {
    FakeWebSocket.plan = [{ status: 403, code: "origin_rejected", usage: { input_tokens: 13, output_tokens: 2 }, error: { message: "Turn declined" } }];
    const response = await sendWithSpendLedger(comboConfig());
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Turn declined");
    const row = getRequestLogEntries().find(row => row.requestId === response.headers.get("x-opencodex-request-id"));
    expect(row?.attempts).toMatchObject([{ status: 403, sendCount: 1, usage: { inputTokens: 13, outputTokens: 2 } }]);
    expect(fallbackSends).toBe(0);
    expect(sharedSpendLedger().snapshot("pool", "openai")).toMatchObject({ reserved: 0, settled: 15, unresolved: 0 });
  });

  test.each([
    ["fallback/fallback-model", "openai-responses"], ["chain/overload", "openai-responses"], ["chain/overload", "openai-chat"],
  ] as const)("HTTP error diagnostics mask the sending credential on %s (%s)", async (model, adapter) => {
    const config = comboConfig();
    config.providers.fallback!.adapter = adapter;
    config.combos!.overload!.targets.shift();
    const synthetic = "orchard-sample";
    config.providers.fallback!.apiKey = synthetic;
    globalThis.fetch = (async () => Response.json({ error: { message: `Fixture diagnosis: ${synthetic}` } }, {
      status: 403, statusText: `Denied ${synthetic}`, headers: { "x-fixture-note": `From ${synthetic}`, "x-trace": "trace-42" },
    })) as typeof fetch;
    const { response, body } = await send(config, "hello", undefined, model);
    expect(response.status).toBe(403);
    expect(body).toContain("Fixture diagnosis:");
    expect({ body: body.includes(synthetic), statusText: response.statusText.includes(synthetic),
      headers: [...response.headers.values()].some(header => header.includes(synthetic)) }).toEqual({ body: false, statusText: false, headers: false });
    if (model === "fallback/fallback-model") expect(response.headers.get("x-trace")).toBe("trace-42");
  });

  test("terminal send accounting leaves a same-key retry unresolved when only the first send reported usage", async () => {
    const config = comboConfig();
    config.combos!.overload!.targets.shift();
    config.providers.fallback!.retryOn429 = { attempts: 1, intervalMs: 1 };
    let sends = 0;
    let firstBooking = 0;
    globalThis.fetch = (async () => {
      if (++sends === 1) {
        firstBooking = sharedSpendLedger().snapshot("pool", "fallback").reserved;
        return Response.json({ error: { message: "busy" }, usage: { input_tokens: 13, output_tokens: 2 } }, { status: 429, headers: { "retry-after": "0" } });
      }
      return Response.json({ error: { message: "forbidden" } }, { status: 403 });
    }) as typeof fetch;
    const response = await sendWithSpendLedger(config);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("forbidden");
    expect(sends).toBe(2);
    expect(firstBooking).toBeGreaterThan(0);
    expect(sharedSpendLedger().snapshot("pool", "fallback")).toMatchObject({ reserved: 0, settled: 0, unresolved: 2 * firstBooking });
  });

  test.each([false, true])("terminal send accounting does not charge a fallback for the returned quota refusal (fallback reports usage=%s)", async reportsUsage => {
    const config = comboConfig();
    config.providers.primary = { ...config.providers.fallback!, baseUrl: "https://primary.invalid/v1" };
    config.combos!.overload!.targets[0]!.provider = "primary";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
      if (host === "primary.invalid") return Response.json({ error: { message: "weekly usage limit reached" }, usage: { input_tokens: 13, output_tokens: 2 } }, { status: 429 });
      if (host !== "combo-fixture.invalid") throw new Error(`unexpected host ${host}`);
      return Response.json({ error: { message: "forbidden" }, ...(reportsUsage && { usage: { input_tokens: 3, output_tokens: 1 } }) }, { status: 403 });
    }) as typeof fetch;
    const response = await sendWithSpendLedger(config);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("weekly usage limit reached");
    const row = getRequestLogEntries().find(row => row.requestId === response.headers.get("x-opencodex-request-id"));
    expect(row?.attempts).toMatchObject([{ status: 429, sendCount: 1, usage: { inputTokens: 13, outputTokens: 2 } }, { status: 403, sendCount: 1 }]);
    const primary = sharedSpendLedger().snapshot("pool", "primary");
    expect(primary.settled).toBe(0);
    expect(primary.unresolved).toBeGreaterThan(0);
    const fallback = sharedSpendLedger().snapshot("pool", "fallback");
    expect(fallback.settled).toBe(reportsUsage ? 4 : 0);
    expect(fallback.unresolved > 0).toBe(!reportsUsage);
  });

  test("a first-frame refusal omits malformed usage instead of reporting a charge", async () => {
    FakeWebSocket.plan = [{ status: 403, code: "origin_rejected", usage: { input_tokens: -1, output_tokens: 2 }, error: { message: "Turn declined" } }];
    const { response, body } = await send(comboConfig(), "hello", undefined, "openai/gpt-5.5");
    expect(response.status).toBe(403);
    expect(JSON.parse(body)).not.toHaveProperty("usage");
  });

  test("a direct held error keeps the client fatal code on its terminal", async () => {
    FakeWebSocket.plan = [{ status: 503, code: "invalid_prompt", error: { code: "overloaded_error", message: "Fixture refusal" } }];
    const { body, logCtx } = await send(comboConfig(), "hello", undefined, "openai/gpt-5.5");
    expect(logCtx.terminalHttpStatus).toBe(503);
    const terminal = body.split("event: response.failed\n")[1]?.split("\n")[0]?.replace(/^data: /, "");
    expect(JSON.parse(terminal ?? "null")?.response).toMatchObject({ error: { code: "invalid_prompt", message: "Fixture refusal" }, retryable: false });
  });

  test.each([401, 503])("native dispatch returns a first-frame hard refusal without resending: %i", async status => {
    let refreshes = 0;
    const fixtureFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input)).hostname !== "auth.openai.com") return fixtureFetch(input, init);
      refreshes++;
      return Response.json({ access_token: "refreshed-fixture", refresh_token: "fixture-grant", expires_in: 3600 });
    }) as typeof fetch;
    FakeWebSocket.plan = [{ status, code: "origin_rejected", error: { code: status === 503 ? "server_is_overloaded" : "authentication_error", message: "Fixture refusal" } }, "issue-reasoning"];
    const cfg = comboConfig();
    const direct = () => send(cfg, "hello", "hard-stop-thread", "openai/gpt-5.5");
    const { response, body } = await direct();
    expect(FakeWebSocket.instances.flatMap(ws => ws.sent)).toHaveLength(1);
    expect(refreshes).toBe(0);
    expect(response.status).toBe(status === 503 ? 200 : 401);
    expect(body).toContain("Fixture refusal");
    expect(body).not.toContain("origin_rejected");
    if (status === 401) expect((await direct()).body).toContain("response.completed");
  });

  for (const model of ["chain/overload", "policy/ordered"]) {
    test.each(["nested innererror", "competing root code", "request echo", "numeric wrapper"] as const)(`${model} distinguishes routing evidence from display and echo: %s`, async conflict => {
      const shouldHop = conflict === "request echo" || conflict === "numeric wrapper";
      const cfg = comboConfig();
      cfg.routingProfiles = { ordered: { candidates: cfg.combos!.overload!.targets } };
      FakeWebSocket.plan = [{ status: 400, ...(conflict === "request echo" && { request: { innererror: { code: "origin_rejected" } } }), ...(conflict === "competing root code" && { code: "invalid_request_error" }), ...(conflict === "numeric wrapper" && { code: 400 }),
        error: { code: "model_not_found", message: "Model unavailable", ...(conflict === "nested innererror" && { innererror: { code: "origin_rejected" } }) } }];
      const { response, body } = await send(cfg, "hello", undefined, model);
      expect(response.status).toBe(shouldHop ? 200 : 400);
      expect(body).toContain(shouldHop ? "resp_fallback" : "model_not_found");
      if (conflict === "competing root code") {
        // Combo formats any 400 as invalid_request_error; the projected upstream diagnostic is separate.
        const delivered = JSON.parse(body);
        expect(delivered).not.toHaveProperty("code");
        expect(delivered.error.message).not.toContain("invalid_request_error");
      }
      expect(fallbackSends).toBe(shouldHop ? 1 : 0);
    });
  }

  test.each(["first-model-missing", "first-model-missing-underscore"] as const)("a non-Luna combo honors a model_not_found code over a diagnostic type: %s", async step => {
    FakeWebSocket.plan = [step];
    const { response, body } = await send();
    expect(response.status).toBe(200);
    expect(body).toContain("resp_fallback");
    expect(fallbackSends).toBe(1);
  });

  test("output after the rate-limit frame still commits the native target", async () => {
    FakeWebSocket.plan = ["quota-output-then-refuse"];
    const { response, body } = await send();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(fallbackSends).toBe(0);
    expect(response.status).toBe(200);
    expect(body).toContain("response.output_item.added");
    expect(body).toContain('"code":"server_is_overloaded"');
    expect(body).not.toContain('"code":"invalid_prompt"');
  });
});
