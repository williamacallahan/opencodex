/**
 * The `agy` pass-through lane through the real public listener. Google is a loopback capture server
 * named by the operator's provider row; every credential is synthetic and any `fetch` to another
 * origin fails the case. Requests reach the hub through `node:http`, which, like agy, sends no
 * `Accept` header unless told to, so header preservation is observable end to end.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setAccountPaused } from "../../src/oauth/store";
import { clearPoolRotationState } from "../../src/oauth/pool-kernel";
import { resetAgyAccountState } from "../../src/server/agy-passthrough-accounts";
import { clearAccountQuotaCache } from "../../src/providers/quota";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Captured = { path: string; query: string; headers: Headers; bytes: Uint8Array };
type Answer = { status: number; headers: Record<string, string | string[] | undefined>; text: string };
const hubKey = `ocx_data_${"a".repeat(40)}`;
const otherKey = `ocx_data_${"b".repeat(40)}`;
const agyAgent = "antigravity/cli/1.5.12 (aidev_client; os_type=darwin; arch=arm64; cl=1; auth_method=consumer)";
const generate = String.raw`{"project":"synthetic-project-two","requestId":"agent-x","request":{"contents":[{"role":"user","parts":[{"text":"café a"}]}],"sessionId":"s"},"model":"gemini-3.8-flash-low","userAgent":"antigravity","requestType":"agent","future":{"n":9007199254740993,"dup":1,"dup":2}}`;
const sse = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}}\r\n\r\n';

describe("agy pass-through public HTTP lane", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedCodexHome: string | undefined;
  let savedFetch: typeof fetch;
  let release: (() => void) | undefined;
  let proxy: ReturnType<typeof import("../../src/server").startServer> | undefined;
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let calls: Captured[];
  let reply: (captured: Captured) => Response;
  let unexpected: number;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    savedHome = process.env.OPENCODEX_HOME;
    savedCodexHome = process.env.CODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-agy-passthrough-"));
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    release = acquireOwnedSpendHome();
    calls = []; unexpected = 0;
    reply = () => new Response(sse, { headers: { "content-type": "text/event-stream", "x-google-fixture": "kept" } });
    clearGenericFailoverHealth(); clearPoolRotationState(); resetAgyAccountState(); clearAccountQuotaCache();
    for (const slot of ["one", "two", "three"]) {
      await saveCredential("google-antigravity", { access: `synthetic-pool-${slot}`, refresh: `synthetic-refresh-${slot}`,
        expires: Date.now() + 3_600_000, accountId: `synthetic-${slot}`, projectId: `synthetic-project-${slot}` });
    }
    tokens = Object.fromEntries(getAccountSet("google-antigravity")!.accounts.map(row => [row.credential.projectId!, `Bearer ${row.credential.access}`]));
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const url = new URL(req.url);
      const captured = { path: url.pathname, query: url.search, headers: req.headers, bytes: new Uint8Array(await req.arrayBuffer()) };
      calls.push(captured);
      return reply(captured);
    } });
    savedFetch = globalThis.fetch;
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === upstream?.url.origin || (proxy && url.origin === `http://127.0.0.1:${proxy.port}`)) return savedFetch(input, init);
      unexpected++;
      throw new Error("agy fixture blocked unexpected network");
    }, { preconnect() {} }) as typeof fetch;
  });

  afterEach(async () => {
    try {
      await proxy?.stop(true); proxy = undefined;
      await upstream?.stop(true); upstream = undefined;
      await drainAndRemoveFixtureRoots({ roots: [], restoreEnvironment() {} });
      expect(unexpected).toBe(0);
    } finally {
      globalThis.fetch = savedFetch;
      clearGenericFailoverHealth(); clearPoolRotationState(); resetAgyAccountState(); clearAccountQuotaCache();
      release?.(); release = undefined;
      if (savedHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = savedHome;
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodexHome;
      removeTreeWithRetry(home);
    }
  });

  async function launch(options: { allowedProviders?: string[]; nativeHarnessOnly?: boolean } = {}) {
    const config: OcxConfig = {
      port: 0, hostname: "0.0.0.0", defaultProvider: "google-antigravity", nativeHarnessOnly: options.nativeHarnessOnly ?? true,
      apiKeys: [
        { id: "agy", name: "fixture-agy", key: hubKey, createdAt: "2026-01-01T00:00:00.000Z", ...(options.allowedProviders ? { allowedProviders: options.allowedProviders } : {}) },
        { id: "other", name: "fixture-other", key: otherKey, createdAt: "2026-01-01T00:00:00.000Z", allowedProviders: ["anthropic"] },
      ],
      providers: {
        "google-antigravity": { adapter: "google", authMode: "oauth", baseUrl: upstream!.url.origin, allowPrivateNetwork: true, googleMode: "cloud-code-assist", models: ["gemini-3.8-flash"], liveModels: false },
        anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", models: ["claude-sonnet-4-5"], liveModels: false },
      },
      clientIntegrations: { codex: false }, checkForUpdates: false, syncResumeHistory: false,
    } as OcxConfig;
    saveConfig(config);
    proxy = (await import("../../src/server")).startServer(0);
  }

  function post(method: string, body: string, headers: Record<string, string> = {}, key = hubKey, path = `/agy/${key}/v1internal:${method}`): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const outgoing = request({ host: "127.0.0.1", port: proxy!.port, path, method: "POST", headers: {
        "content-type": "application/json", "accept-encoding": "gzip", "user-agent": agyAgent, authorization: "Bearer caller-own-token",
        "x-forwarded-for": "203.0.113.9", "x-request-id": "envoy-generated", "x-envoy-attempt-count": "1",
        "x-opencodex-api-key": hubKey, cookie: "c=1", "x-future-client": "opaque", ...headers,
      } }, message => {
        let text = "";
        message.setEncoding("utf8");
        message.on("data", chunk => { text += chunk; });
        message.on("end", () => resolve({ status: message.statusCode ?? 0, headers: message.headers, text }));
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }

  test("forwards agy's bytes, path, query and headers unchanged except the pooled bearer", async () => {
    await launch();
    const response = await post("streamGenerateContent?alt=sse", generate);
    expect(response.status).toBe(200);
    expect(response.text).toBe(sse);
    expect(response.headers["x-google-fixture"]).toBe("kept");
    expect(calls).toHaveLength(1);
    const sent = calls[0]!;
    expect(sent.bytes).toEqual(new TextEncoder().encode(generate));
    expect(sent.path).toBe("/v1internal:streamGenerateContent");
    expect(sent.query).toBe("?alt=sse");
    expect(sent.headers.get("authorization")).toBe(tokens["synthetic-project-two"]);
    expect(sent.headers.get("user-agent")).toBe(agyAgent);
    expect(sent.headers.get("accept-encoding")).toBe("gzip");
    expect(sent.headers.get("x-future-client")).toBe("opaque");
    // Exactly agy's end-to-end headers: nothing added (no Accept), and nothing the hub's proxies added.
    expect([...sent.headers.keys()].sort()).toEqual(
      ["accept-encoding", "authorization", "connection", "content-length", "content-type", "host", "user-agent", "x-future-client"]);
  });

  test("keeps project-less calls on the caller's account and learns and stores the project Google returns", async () => {
    await launch();
    let served = "";
    reply = captured => {
      served = captured.headers.get("authorization")!;
      return Response.json({ cloudaicompanionProject: "learned-project", currentTier: { id: "standard-tier" } });
    };
    const first = await post("loadCodeAssist", '{"metadata":{"ideType":"ANTIGRAVITY"}}');
    expect(first.status).toBe(200);
    expect(JSON.parse(first.text)).toEqual({ cloudaicompanionProject: "learned-project", currentTier: { id: "standard-tier" } });
    const owner = served;
    await post("loadCodeAssist", '{"metadata":{"ideType":"ANTIGRAVITY"}}');
    expect(served).toBe(owner);
    await post("loadCodeAssist", '{"metadata":{}}', { authorization: "Bearer another-caller" });
    expect(served).not.toBe(owner);
    reply = captured => { served = captured.headers.get("authorization")!; return Response.json({}); };
    await post("fetchUserInfo", '{"project":"learned-project"}', { authorization: "Bearer a-third-caller" });
    expect(served).toBe(owner);
    const stored = () => getAccountSet("google-antigravity")!.accounts.find(row => `Bearer ${row.credential.access}` === owner)?.credential.projectId;
    for (let attempt = 0; attempt < 50 && stored() !== "learned-project"; attempt++) await Bun.sleep(10);
    expect(stored()).toBe("learned-project");
  });

  test("records each account's quota from Google's answers to agy's own quota calls, which reach agy unchanged", async () => {
    await launch();
    const { readPassiveProviderAccountQuotas } = await import("../../src/providers/quota/account-cache");
    const { fetchObservedAntigravityQuota } = await import("../../src/providers/quota/vendor-probes-oauth");
    const accountFor = (project: string) => getAccountSet("google-antigravity")!.accounts.find(row => row.credential.projectId === project)!.id;
    const observed = async (accountId: string, ready: (quota: unknown) => boolean = () => true) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const row = readPassiveProviderAccountQuotas("google-antigravity").find(entry => entry.accountId === accountId);
        if (row?.quota && ready(row.quota)) return row.quota;
        await Bun.sleep(10);
      }
      return undefined;
    };
    const summary = { groups: [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.6 }] }] };
    const models = (fraction: number) => ({ models: { "gemini-3.8-flash": { quotaInfo: { remainingFraction: fraction } } } });
    // Provider-wide family windows only; per-model detail rows carry a modelId.
    const percents = (quota: unknown) => ((quota as { customWindows?: Array<{ percent: number; modelId?: string }> }).customWindows ?? [])
      .filter(window => window.modelId === undefined).map(window => Math.round(window.percent));

    const modelPercents = (quota: unknown) => ((quota as { customWindows?: Array<{ percent: number; modelId?: string }> }).customWindows ?? [])
      .filter(window => window.modelId !== undefined).map(window => Math.round(window.percent));

    reply = () => Response.json(summary);
    const answer = await post("retrieveUserQuotaSummary", '{"project":"synthetic-project-two"}');
    expect(JSON.parse(answer.text)).toEqual(summary);
    const two = accountFor("synthetic-project-two");
    expect(percents(await observed(two))).toEqual([40]);

    // A per-model reading in the same session does not replace that account's fresher summary, and
    // on its own it is kept as per-model rows only: one model's counter is not a family window.
    reply = () => Response.json(models(0.1));
    await post("fetchAvailableModels", '{"project":"synthetic-project-two"}');
    reply = () => Response.json(models(0.75));
    await post("fetchAvailableModels", '{"project":"synthetic-project-three"}');
    const three = accountFor("synthetic-project-three");
    const threeQuota = await observed(three);
    expect([percents(threeQuota), modelPercents(threeQuota)]).toEqual([[], [25]]);
    expect(percents(await observed(two))).toEqual([40]);

    // The pool's provider row prefers the freshest observation that has family windows.
    const row = fetchObservedAntigravityQuota("google-antigravity");
    expect(row?.observed).toBe(true);
    expect(percents(row?.quota)).toEqual([40]);
    expect(calls.map(call => call.path)).toEqual([
      "/v1internal:retrieveUserQuotaSummary", "/v1internal:fetchAvailableModels", "/v1internal:fetchAvailableModels",
    ]);
  });

  test("an observation never moves to another sign-in, and a row with no agy sign-in is not an observation", async () => {
    await launch();
    const { readPassiveProviderAccountQuotas, recordPassiveAccountQuota } = await import("../../src/providers/quota/account-cache");
    const { mergeAccountCredential } = await import("../../src/oauth/store");
    const account = () => getAccountSet("google-antigravity")!.accounts.find(row => row.credential.projectId === "synthetic-project-one")!;
    const id = account().id;
    const observedIds = () => readPassiveProviderAccountQuotas("google-antigravity").map(row => row.accountId);

    // A probe-era row with no sign-in attached is not shown.
    recordPassiveAccountQuota("google-antigravity", id, { customWindows: [{ label: "Gem", percent: 90 }], updatedAt: Date.now() }, Number.MAX_SAFE_INTEGER);
    expect(observedIds()).toEqual([]);

    // The answer arrives after another login took the slot: it is not written for the new login.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    reply = () => new Response(new ReadableStream({ async start(controller) {
      await held;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ groups: [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.5 }] }] })));
      controller.close();
    } }), { headers: { "content-type": "application/json" } });
    const pending = post("retrieveUserQuotaSummary", '{"project":"synthetic-project-one"}');
    for (let attempt = 0; attempt < 50 && calls.length === 0; attempt++) await Bun.sleep(10);
    await mergeAccountCredential("google-antigravity", id, { ...account().credential, refresh: "synthetic-refresh-other-login", accountId: "synthetic-other-login" });
    release();
    expect((await pending).status).toBe(200);
    await Bun.sleep(50);
    expect(observedIds()).toEqual([]);
  });

  test("when Google hands several accounts the same project, a caller keeps its own account", async () => {
    await launch();
    const { mergeAccountCredential } = await import("../../src/oauth/store");
    let served = "";
    reply = captured => { served = captured.headers.get("authorization")!; return Response.json({ cloudaicompanionProject: "shared-project" }); };
    // The rotation hands a second caller the pool's second account.
    await post("loadCodeAssist", "{}", { authorization: "Bearer first-caller" });
    await post("loadCodeAssist", "{}", { authorization: "Bearer second-caller" });
    const own = served;
    expect(own).not.toBe(tokens["synthetic-project-one"]);
    // Every pooled account now owns the same project, the first one in the roster included.
    for (const row of getAccountSet("google-antigravity")!.accounts) {
      await mergeAccountCredential("google-antigravity", row.id, { ...row.credential, projectId: "shared-project" });
    }
    reply = captured => { served = captured.headers.get("authorization")!; return new Response(sse, { headers: { "content-type": "text/event-stream" } }); };
    expect((await post("streamGenerateContent?alt=sse", '{"project":"shared-project"}', { authorization: "Bearer second-caller" })).status).toBe(200);
    expect(served).toBe(own);
  });

  test("a 429 passes through unchanged; only loadCodeAssist moves the caller, trajectory writes stay put", async () => {
    await launch();
    let served = "";
    reply = captured => {
      served = captured.headers.get("authorization")!;
      return new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', { status: 429, headers: { "retry-after": "30", "content-type": "application/json" } });
    };
    const limited = await post("loadCodeAssist", "{}");
    expect(limited.status).toBe(429);
    expect(limited.text).toBe('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');
    const cooled = served;
    reply = captured => { served = captured.headers.get("authorization")!; return Response.json({}); };
    await post("writeTrajectoryAcls", '{"trajectoryId":"t"}');
    expect(served).toBe(cooled);
    await post("loadCodeAssist", "{}");
    expect(served).not.toBe(cooled);
  });

  test("refuses before any upstream call when the key, client, project, account or switch does not qualify", async () => {
    await launch({ allowedProviders: ["google-antigravity"] });
    const refusals: Array<[Promise<Answer>, number]> = [
      [post("loadCodeAssist", "{}", {}, "not-a-hub-key"), 401],
      [post("loadCodeAssist", "{}", {}, otherKey), 403],
      [post("loadCodeAssist", "{}", { "user-agent": "curl/8.7.1" }), 403],
      [post("loadCodeAssist", "{}", { "user-agent": "antigravity/ide/2.5.5 (aidev_client)" }), 403],
      [post("loadCodeAssist", "{}", { authorization: "" }), 403],
      [post("loadCodeAssist", "{}", { origin: "https://example.invalid" }), 403],
      [post("streamGenerateContent", '{"project":"someone-elses-project"}'), 400],
      [post("streamGenerateContent", '{"request":{}}'), 400],
      [post("models", "{}", {}, hubKey, `/agy/${hubKey}/v1/models`), 404],
    ];
    for (const [pending, status] of refusals) {
      const response = await pending;
      expect(response.status).toBe(status);
      expect(JSON.parse(response.text).error.message).toStartWith("opencodex: ");
    }
    const two = getAccountSet("google-antigravity")!.accounts.find(row => row.credential.projectId === "synthetic-project-two")!;
    await setAccountPaused("google-antigravity", two.id, true);
    expect((await post("streamGenerateContent", generate)).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test("serves nothing while nativeHarnessOnly is off", async () => {
    await launch({ nativeHarnessOnly: false });
    expect((await post("loadCodeAssist", "{}")).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test("nativeHarnessOnly refuses a translated Responses turn on the Antigravity pool before any upstream call", async () => {
    await launch();
    const response = await fetch(new URL("/v1/responses", `http://127.0.0.1:${proxy!.port}`), {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencodex-api-key": hubKey },
      body: JSON.stringify({ model: "google-antigravity/gemini-3.8-flash", input: "synthetic", stream: false }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("only the agy harness");
    expect(calls).toHaveLength(0);
  });

  for (const nativeHarnessOnly of [true, false]) {
    test(`the provider list names the one client each subscription provider serves (switch ${nativeHarnessOnly ? "on" : "off"})`, async () => {
      await launch({ nativeHarnessOnly });
      const admin = readFileSync(join(home, "admin-api-token"), "utf8").trim();
      const response = await fetch(new URL("/api/providers", `http://127.0.0.1:${proxy!.port}`), { headers: { "x-opencodex-api-key": admin } });
      expect(response.status).toBe(200);
      const rows = await response.json() as Array<{ name: string; nativeHarness?: string }>;
      const harness = Object.fromEntries(rows.map(row => [row.name, row.nativeHarness]));
      expect(harness).toEqual(nativeHarnessOnly
        ? { "google-antigravity": "agy", anthropic: "claude-code" }
        : { "google-antigravity": undefined, anthropic: undefined });
    });
  }
});
