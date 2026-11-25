import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown } from "../../src/combos";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

let now: number;
let cleanup: () => void;
let calls: string[];
let relayUrl: string;
let relay: (request: Request, body: { model: string }) => Response | Promise<Response>;
let metered: () => Response;

function sse(model: string, _frames: "ok"): Response {
  const response = { id: "resp_1", object: "response", status: "completed", model, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
    { headers: { "content-type": "text/event-stream" } });
}

function config(extraProviders: OcxConfig["providers"], targets: NonNullable<OcxConfig["combos"]>[string]["targets"]): OcxConfig {
  return {
    port: 0, defaultProvider: "relay", codexMainAccountHardLock: false,
    providers: {
      relay: { adapter: "openai-responses", authMode: "key", apiKey: "relay-key", baseUrl: "https://relay.example.test/backend-api/codex" },
      ...extraProviders,
    },
    combos: { luna: { strategy: "failover", allowMeteredTargets: true, targets } },
  };
}

async function post(cfg: OcxConfig, extra: Record<string, unknown> = {}) {
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/luna", input: "ping", stream: true, prompt_cache_key: "luna-order", ...extra }) }),
    cfg, { model: "", provider: "" }, { admission: { kind: "loopback", source: "loopback" } });
  return { status: response.status, text: await response.text() };
}

beforeEach(() => {
  const temp = createTempHome();
  const release = acquireOwnedSpendHome();
  clearComboSelectionState(); clearComboTargetCooldowns();
  now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  calls = [];
  relayUrl = "https://relay.example.test/backend-api/codex/v1/responses";
  relay = () => sse("gpt-6-luna", "ok");
  metered = () => sse("gpt-6-luna", "ok");
  const upstream = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.clone().json() as { model: string };
    if (request.url === relayUrl) { calls.push(`relay:${body.model}`); return relay(request, body); }
    if (request.url === "https://metered.example.test/v1/responses") { calls.push(`metered:${body.model}`); return metered(); }
    throw new Error(`unexpected upstream ${request.url}`);
  }, { preconnect() {} }));
  cleanup = () => { upstream.mockRestore(); clock.mockRestore(); clearComboSelectionState(); clearComboTargetCooldowns(); release(); temp.remove(); };
});
afterEach(() => cleanup());

describe("Luna relay cooldown", () => {
  test.each([
    ["seat reset and body advice", undefined, 60_000],
    ["short Retry-After", "1", 1_000],
    ["weekly Retry-After", "604800", 300_000],
  ] as const)("relay quota: %s holds only Luna until its relay deadline", async (_, retryAfter, delay) => {
    const luna = { provider: "relay", model: "gpt-6-luna" };
    const sol = { provider: "relay", model: "gpt-6.2-sol" };
    const cfg = config({}, [luna, sol]);
    if (retryAfter === "1") {
      // This relay uses a different URL shape and pools only its Luna model.
      cfg.providers.relay!.baseUrl = "https://relay.example.test/v1";
      cfg.providers.relay!.modelCapabilities = { [luna.model]: { upstreamSeatPool: true } };
      relayUrl = "https://relay.example.test/v1/responses";
    }
    cfg.providers.relay!.upstreamWebsocket = false;
    cfg.combos!.luna!.waitForCooldownMs = 0;
    relay = (_, body) => body.model === sol.model ? sse(sol.model, "ok") : Response.json({ error: {
      code: retryAfter === undefined ? "usage_limit_reached" : "insufficient_quota", message: "Weekly quota exhausted. Try again in 144 hours.",
    } }, { status: 502, headers: { "x-should-retry": "false", "x-codex-secondary-reset-at": String((now + 604_800_000) / 1000),
      ...(retryAfter ? { "retry-after": retryAfter } : {}) } });
    await post(cfg);
    expect(isComboTargetInCooldown("luna", luna, now + delay - 1)).toBe(true);
    expect(isComboTargetInCooldown("luna", sol)).toBe(false);
    now += delay;
    calls.length = 0;
    relay = (_, body) => sse(body.model, "ok");
    expect((await post(cfg)).text).toContain("response.completed");
    expect(calls).toEqual(["relay:gpt-6-luna"]);
  });

  test.each([true, false])("a zero-output billing prelude does not turn seat reset prose into a relay header (stream: %s)", async stream => {
    const luna = { provider: "relay", model: "gpt-6-luna" };
    const cfg = config({}, [luna]);
    cfg.combos!.luna!.waitForCooldownMs = 0;
    cfg.providers.relay!.upstreamWebsocket = false;
    relay = () => new Response(`data: ${JSON.stringify({ type: "error", status: 502, error: {
      code: "usage_limit_exceeded", message: "The usage limit has been reached. Try again in 144 hours.",
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    await post(cfg, { stream });
    expect(isComboTargetInCooldown("luna", luna, now + 59_999)).toBe(true);
    now += 60_000;
    relay = () => sse(luna.model, "ok");
    expect((await post(cfg)).text).toContain("response.completed");
  });

  test("a non-relay Responses target keeps its full quota Retry-After for the same Luna model", async () => {
    const luna = { provider: "direct", model: "gpt-6-luna" };
    const cfg = config({ direct: { adapter: "openai-responses", baseUrl: "https://metered.example.test/v1", apiKey: "direct-key" } }, [luna]);
    cfg.combos!.luna!.waitForCooldownMs = 0;
    metered = () => Response.json({ error: { code: "insufficient_quota", message: "Weekly quota exhausted" } },
      { status: 502, headers: { "retry-after": "86400", "x-should-retry": "false" } });
    expect((await post(cfg)).status).toBe(502);
    expect(isComboTargetInCooldown("luna", luna, now + 86_399_999)).toBe(true);
    expect(isComboTargetInCooldown("luna", luna, now + 86_400_000)).toBe(false);
  });

  test.each([
    ["120", 120_000], ["86400", 300_000], ["invalid", 7_000], [undefined, 7_000],
  ] as const)("relay overload honors its wire Retry-After (%s), not a seat's reset prose", async (retryAfter, delay) => {
    const luna = { provider: "relay", model: "gpt-6-luna" };
    const cfg = config({}, [luna]);
    cfg.providers.relay!.upstreamWebsocket = false;
    Object.assign(cfg.combos!.luna!, { cooldownMs: 7_000, waitForCooldownMs: 0 });
    relay = () => Response.json({ error: { code: "server_is_overloaded", message: "Gateway busy. Try again in 144 hours." } },
      { status: 503, headers: { "x-should-retry": "false", ...(retryAfter && { "retry-after": retryAfter }) } });
    expect((await post(cfg)).status).toBe(503);
    expect(isComboTargetInCooldown("luna", luna, now + delay - 1)).toBe(true);
    expect(isComboTargetInCooldown("luna", luna, now + delay)).toBe(false);
  });

  test.each([503, 404])("a slow %i body cannot shorten a newer live relay hold", async status => {
    const luna = { provider: "relay", model: "gpt-6-luna" };
    const cfg = config({}, [luna]);
    cfg.providers.relay!.upstreamWebsocket = false;
    cfg.combos!.luna!.waitForCooldownMs = 0;
    const readStarted = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    relay = () => new Response(new ReadableStream({ async pull(controller) {
      readStarted.resolve(); await resume.promise;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { code: status === 503 ? "server_is_overloaded" : "model_not_found" } }))); controller.close();
    } }), { status, headers: status === 503 ? { "retry-after": "120", "x-should-retry": "false" } : undefined });
    const earlier = post(cfg);
    await readStarted.promise;
    coolComboTarget("luna", luna, { now, status: 503, retryAfter: "300" });
    resume.resolve();
    expect((await earlier).status).toBe(status);
    expect(isComboTargetInCooldown("luna", luna, now + 299_999)).toBe(true);
    expect(isComboTargetInCooldown("luna", luna, now + 300_000)).toBe(false);
  });

  test("a single relay waits for the preserved hold and retries only once", async () => {
    const luna = { provider: "relay", model: "gpt-6-luna" };
    const cfg = config({}, [luna]);
    cfg.providers.relay!.upstreamWebsocket = false;
    Object.assign(cfg.combos!.luna!, { cooldownMs: 10, waitForCooldownMs: 1_000 });
    const sends: number[] = [];
    relay = () => {
      sends.push(performance.now());
      if (sends.length === 1) coolComboTarget("luna", luna, { now, cooldownMs: 120, status: 503 });
      return Response.json({ error: { message: `relay attempt ${calls.length}` } }, { status: 503, headers: { "x-should-retry": "false" } });
    };
    const result = await post(cfg);
    expect(result.status).toBe(503);
    expect(result.text).toContain("relay attempt 2");
    expect(sends).toHaveLength(2);
    expect(sends[1]! - sends[0]!).toBeGreaterThanOrEqual(119);
  });

  test("a failed relay probe cannot spend its reservation twice on a retained hold", async () => {
    const luna = { provider: "relay", model: "gpt-6-luna" };
    const cfg = config({}, [luna]);
    cfg.providers.relay!.upstreamWebsocket = false;
    Object.assign(cfg.combos!.luna!, { cooldownReprobe: { enabled: true, intervalMs: 1_000 }, waitForCooldownMs: 1_000 });
    coolComboTarget("luna", luna, { now, status: 503, retryAfter: "300" });
    relay = () => calls.length === 1 ? Response.json({ error: { message: "probe declined" } }, {
      status: 503, headers: { "x-should-retry": "false", "retry-after": "1" },
    }) : sse(luna.model, "ok");
    const result = await post(cfg);
    expect(result.status).toBe(503);
    expect(result.text).toContain("probe declined");
    expect(calls).toEqual(["relay:gpt-6-luna"]);
    expect(isComboTargetInCooldown("luna", luna, now + 299_999)).toBe(true);
  });

});
