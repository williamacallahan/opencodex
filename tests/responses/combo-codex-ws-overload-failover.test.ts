import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth } from "../../src/codex/auth-api";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexQuotaHealthSnapshot } from "../../src/codex/routing";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown } from "../../src/combos";
import { handleResponses } from "../../src/server/responses";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { clearPoolRecoveryState } from "../../src/routing/probe-lease";
import type { RequestLogContext } from "../../src/server/request-log";
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
type FirstFrame = { status: number; code?: string | number; request?: { innererror: { code: string } }; error: { code: string; message: string; innererror?: { code: string } } };
type Step = FirstFrame | "issue-reasoning" | "first-quota" | "first-conflict" | "quota-then-refuse" | "quota-output-then-refuse" | "reserve-started-then-refuse"
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
      this.frame({ type: "error", ...step });
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
        error: { type: "server_error", code: "server_is_overloaded", message: "Our servers are currently overloaded." } });
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

describe("a failover combo moves past a native Codex overload that preceded any output (#8107)", () => {
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

  test.each(["root", "innererror"])("strict Reserve stops before the relay on a hard first-frame overload: %s", async source => {
    const cfg = comboConfig();
    for (const target of cfg.combos!.overload!.targets) target.model = "gpt-6-luna";
    cfg.providers.fallback!.baseUrl = "https://combo-fixture.invalid/backend-api/codex";
    cfg.codexAccounts![0]!.plan = "pro";
    const resetAt = Math.floor(Date.now() / 1000) + 3600;
    setAccountQuotaFromParsed(WORK, { weeklyPercent: 100, weeklyResetAt: resetAt,
      customWindows: [{ label: "Luna Reserve", percent: 10, observedAt: Date.now(), resetAt }] });
    const stop = { code: "origin_rejected" };
    FakeWebSocket.plan = [{ status: 503, ...(source === "root" && stop), error: { code: "server_is_overloaded",
      message: "Our servers are currently overloaded.", ...(source === "innererror" && { innererror: stop }) } }];
    const { body, logCtx } = await send(cfg);
    expect(logCtx.routeDecision?.selected.reason).toBe("luna-reserve-first");
    expect(FakeWebSocket.instances.flatMap(ws => ws.sent).map(frame => JSON.parse(frame).model)).toEqual(["gpt-reserve"]);
    expect(fallbackSends).toBe(0);
    expect(logCtx.attempts?.map(a => a.status)).toEqual([503]);
    expect(body).toContain("server_is_overloaded");
    expect(body).not.toContain("origin_rejected");
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
    expect(result.logCtx.routeDecision?.selected.reason).toBe("luna-owner-encrypted-reasoning");
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
    expect(body).toContain("server_is_overloaded");
  });
});
