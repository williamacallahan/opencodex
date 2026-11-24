/**
 * The `agy` pass-through lane through the real public listener. Google is a loopback capture server
 * named by the operator's provider row; every credential is synthetic and any `fetch` to another
 * origin fails the case. Requests reach the hub through `node:http`, which, like agy, sends no
 * `Accept` header unless told to, so header preservation is observable end to end.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getRequestLogEntries } from "../../src/server/request-log";
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
    const response = await post("streamGenerateContent?alt=sse", generate, { "x-user-id": "claude-oc:session-1", "x-lgw-cache-key": "claude-oc:conversation-1", "x-lgw-client-host": "laptop-1", "x-lgw-client-address": "192.0.2.66" });
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
    // The launcher's attribution is recorded on the hub's row and never sent to Google.
    const row = getRequestLogEntries().find(entry => entry.workload === "claude-oc:session-1");
    expect(row?.clientHost).toBe("laptop-1");
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
    // Google answered both callers with the same project, so both accounts now own it; a new caller
    // naming it may go to either owner, never to an account that does not own it.
    const owners = [owner, served];
    reply = captured => { served = captured.headers.get("authorization")!; return Response.json({}); };
    await post("fetchUserInfo", '{"project":"learned-project"}', { authorization: "Bearer a-third-caller" });
    expect(owners).toContain(served);
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

  test("a days-old agy observation stays on the Accounts tab but never reaches routing or the quota pool", async () => {
    await launch();
    const { getCachedProviderAccountQuota, observedAntigravityAccountQuota, recordPassiveAccountQuota } = await import("../../src/providers/quota/account-cache");
    const { antigravityLoginIdentity } = await import("../../src/providers/antigravity-quota-identity");
    const [fresh, old] = getAccountSet("google-antigravity")!.accounts;
    const record = (row: typeof fresh, age: number) => recordPassiveAccountQuota("google-antigravity", row!.id,
      { customWindows: [{ label: "Gem", percent: 100 }], updatedAt: Date.now() - age }, Number.MAX_SAFE_INTEGER,
      antigravityLoginIdentity(row!.id, row!.credential));
    record(fresh, 60_000);
    record(old, 2 * 24 * 60 * 60_000);
    expect(observedAntigravityAccountQuota(fresh!.id)?.customWindows?.[0]?.percent).toBe(100);
    expect(getCachedProviderAccountQuota("google-antigravity", fresh!.id)?.customWindows?.[0]?.percent).toBe(100);
    expect(observedAntigravityAccountQuota(old!.id)?.customWindows?.[0]?.percent).toBe(100);
    expect(getCachedProviderAccountQuota("google-antigravity", old!.id)).toBeNull();
  });

  test("new callers whose first call names a shared project spread across its owners", async () => {
    await launch();
    const { mergeAccountCredential } = await import("../../src/oauth/store");
    for (const row of getAccountSet("google-antigravity")!.accounts) {
      await mergeAccountCredential("google-antigravity", row.id, { ...row.credential, projectId: "shared-project" });
    }
    const served: string[] = [];
    reply = captured => { served.push(captured.headers.get("authorization")!); return new Response(sse, { headers: { "content-type": "text/event-stream" } }); };
    // A restart or agy refreshing its own token makes a caller new; it must not pile onto one owner.
    for (const caller of ["refreshed-a", "refreshed-b", "refreshed-c"]) {
      expect((await post("streamGenerateContent?alt=sse", '{"project":"shared-project"}', { authorization: `Bearer ${caller}` })).status).toBe(200);
    }
    expect(new Set(served).size).toBe(3);
    // Each caller then stays on the account it was given.
    const given = served[0];
    served.length = 0;
    for (let request = 0; request < 2; request++) {
      expect((await post("streamGenerateContent?alt=sse", '{"project":"shared-project"}', { authorization: "Bearer refreshed-a" })).status).toBe(200);
    }
    expect(served).toEqual([given!, given!]);
  });

  test("at a turn boundary a caller moves to a clearly less-used account of its project, and every follow-up lands there", async () => {
    await launch();
    const { mergeAccountCredential } = await import("../../src/oauth/store");
    const { recordPassiveAccountQuota } = await import("../../src/providers/quota/account-cache");
    const { antigravityLoginIdentity } = await import("../../src/providers/antigravity-quota-identity");
    for (const row of getAccountSet("google-antigravity")!.accounts) {
      await mergeAccountCredential("google-antigravity", row.id, { ...row.credential, projectId: "shared-project" });
    }
    const rows = getAccountSet("google-antigravity")!.accounts;
    const bearer = (index: number) => `Bearer ${rows[index]!.credential.access}`;
    const usage = (percents: number[]) => rows.forEach((row, index) => recordPassiveAccountQuota("google-antigravity", row.id,
      { customWindows: [{ label: "Gem (Weekly)", percent: percents[index]! }], updatedAt: Date.now() }, Number.MAX_SAFE_INTEGER,
      antigravityLoginIdentity(row.id, row.credential)));
    reply = () => Response.json({ cloudaicompanionProject: "shared-project" });
    // Each request must succeed and reach Google itself; the account is read from that request.
    const send = async (method: string, body: string) => {
      const before = calls.length;
      expect((await post(method, body, { authorization: "Bearer one-signin" })).status).toBe(200);
      expect(calls).toHaveLength(before + 1);
      return calls.at(-1)!.headers.get("authorization");
    };
    const turn = () => send("loadCodeAssist", "{}");
    // A new caller starts on the least-used account.
    usage([60, 5, 40]);
    expect(await turn()).toBe(bearer(1));
    // Its account fills up; at the next turn it moves to the clearly emptier one.
    usage([60, 70, 40]);
    expect(await turn()).toBe(bearer(2));
    // agy keeps its cached project and open trajectory; both follow the caller to the new account.
    reply = () => new Response(sse, { headers: { "content-type": "text/event-stream" } });
    expect(await send("streamGenerateContent?alt=sse", '{"project":"shared-project"}')).toBe(bearer(2));
    reply = () => Response.json({});
    expect(await send("writeTrajectoryAcls", '{"trajectoryId":"t"}')).toBe(bearer(2));
    // Within the margin it stays, so two close accounts do not trade it every turn.
    usage([36, 70, 40]);
    expect(await turn()).toBe(bearer(2));
  });

  test("the Accounts tab shows which account sent agy's requests to Google, and nothing for a refused one", async () => {
    await launch();
    const { managementFetch } = await import("../helpers/management-auth");
    const { agyServing } = await import("../../src/server/agy-passthrough-accounts");
    const { mergeAccountCredential } = await import("../../src/oauth/store");
    const roster = async () => (await (await managementFetch(`http://127.0.0.1:${proxy!.port}/api/oauth/accounts?provider=google-antigravity`)).json() as
      { accounts: Array<{ id: string; agyServing?: { active: boolean; lastAt: number } | null }> }).accounts;
    expect((await roster()).map(row => row.agyServing)).toEqual([null, null, null]);
    // A request refused before any send leaves every account unmarked.
    const two = getAccountSet("google-antigravity")!.accounts.find(row => row.credential.projectId === "synthetic-project-two")!;
    await setAccountPaused("google-antigravity", two.id, true);
    expect((await post("streamGenerateContent", generate)).status).toBe(503);
    expect(calls).toHaveLength(0);
    expect((await roster()).map(row => row.agyServing)).toEqual([null, null, null]);
    reply = () => Response.json({});
    expect((await post("loadCodeAssist", "{}")).status).toBe(200);
    expect(calls).toHaveLength(1);
    const served = getAccountSet("google-antigravity")!.accounts.find(row => `Bearer ${row.credential.access}` === calls[0]!.headers.get("authorization"))!;
    const rows = await roster();
    expect(rows.find(row => row.id === served.id)?.agyServing).toEqual({ active: true, lastAt: expect.any(Number) });
    expect(rows.filter(row => row.id !== served.id).map(row => row.agyServing)).toEqual([null, null]);
    expect(agyServing(served.id, Date.now() + 11 * 60_000)?.active).toBe(false);
    // Another Google sign-in in that slot has sent nothing yet.
    await mergeAccountCredential("google-antigravity", served.id, { ...served.credential, refresh: "synthetic-refresh-other", accountId: "synthetic-other" });
    expect((await roster()).find(row => row.id === served.id)?.agyServing).toBeNull();
  });

  test("a cooling account's caller moves to an owner of its project before an emptier account of another project", async () => {
    await launch();
    const { mergeAccountCredential } = await import("../../src/oauth/store");
    const { recordPassiveAccountQuota } = await import("../../src/providers/quota/account-cache");
    const { antigravityLoginIdentity } = await import("../../src/providers/antigravity-quota-identity");
    const [one, two] = getAccountSet("google-antigravity")!.accounts;
    for (const row of [one!, two!]) await mergeAccountCredential("google-antigravity", row.id, { ...row.credential, projectId: "shared-project" });
    const rows = getAccountSet("google-antigravity")!.accounts;
    rows.forEach((row, index) => recordPassiveAccountQuota("google-antigravity", row.id,
      { customWindows: [{ label: "Gem (Weekly)", percent: [0, 30, 0][index]! }], updatedAt: Date.now() }, Number.MAX_SAFE_INTEGER,
      antigravityLoginIdentity(row.id, row.credential)));
    let status = 200;
    reply = () => status === 200 ? Response.json({}) : new Response("{}", { status, headers: { "retry-after": "30" } });
    expect((await post("loadCodeAssist", "{}", { authorization: "Bearer one-signin" })).status).toBe(200);
    expect(calls.at(-1)!.headers.get("authorization")).toBe(`Bearer ${rows[0]!.credential.access}`);
    // The first account hits its limit; the third is emptier but owns another project.
    status = 429;
    expect((await post("loadCodeAssist", "{}", { authorization: "Bearer one-signin" })).status).toBe(429);
    status = 200;
    expect((await post("loadCodeAssist", "{}", { authorization: "Bearer one-signin" })).status).toBe(200);
    expect(calls.at(-1)!.headers.get("authorization")).toBe(`Bearer ${rows[1]!.credential.access}`);
  });

  test("a turn never moves a caller to an emptier account that does not own its project", async () => {
    await launch();
    const { recordPassiveAccountQuota } = await import("../../src/providers/quota/account-cache");
    const { antigravityLoginIdentity } = await import("../../src/providers/antigravity-quota-identity");
    const rows = getAccountSet("google-antigravity")!.accounts;
    const usage = (percents: number[]) => rows.forEach((row, index) => recordPassiveAccountQuota("google-antigravity", row.id,
      { customWindows: [{ label: "Gem (Weekly)", percent: percents[index]! }], updatedAt: Date.now() }, Number.MAX_SAFE_INTEGER,
      antigravityLoginIdentity(row.id, row.credential)));
    reply = () => Response.json({});
    usage([60, 5, 40]);
    expect((await post("loadCodeAssist", "{}", { authorization: "Bearer one-signin" })).status).toBe(200);
    expect(calls.at(-1)!.headers.get("authorization")).toBe(tokens["synthetic-project-two"]);
    // Every account owns a different project, so moving would leave agy's cached project on the wrong token.
    usage([0, 90, 0]);
    expect((await post("loadCodeAssist", "{}", { authorization: "Bearer one-signin" })).status).toBe(200);
    expect(calls.at(-1)!.headers.get("authorization")).toBe(tokens["synthetic-project-two"]);
  });

  test("a project Google returned to one sign-in is forgotten when another sign-in replaces that slot", async () => {
    await launch();
    const { mergeAccountCredential } = await import("../../src/oauth/store");
    reply = () => Response.json({ cloudaicompanionProject: "learned-project" });
    expect((await post("loadCodeAssist", "{}")).status).toBe(200);
    const served = calls.at(-1)!.headers.get("authorization");
    const slot = () => getAccountSet("google-antigravity")!.accounts.find(row => `Bearer ${row.credential.access}` === served)!;
    for (let attempt = 0; attempt < 50 && slot().credential.projectId !== "learned-project"; attempt++) await Bun.sleep(10);
    // A different Google sign-in now holds the slot, with its own project.
    await mergeAccountCredential("google-antigravity", slot().id, { ...slot().credential, refresh: "synthetic-refresh-other",
      accountId: "synthetic-other", projectId: "other-signin-project" });
    const before = calls.length;
    expect((await post("streamGenerateContent", '{"project":"learned-project"}', { authorization: "Bearer someone-new" })).status).toBe(400);
    expect(calls).toHaveLength(before);
  });

  test("a model-list reply never replaces an account's family reading, however old", async () => {
    await launch();
    const { observedAntigravityAccountQuota, recordPassiveAccountQuota } = await import("../../src/providers/quota/account-cache");
    const { antigravityLoginIdentity } = await import("../../src/providers/antigravity-quota-identity");
    const two = getAccountSet("google-antigravity")!.accounts.find(row => row.credential.projectId === "synthetic-project-two")!;
    recordPassiveAccountQuota("google-antigravity", two.id, { customWindows: [{ label: "Gem (Weekly)", percent: 40 }],
      updatedAt: Date.now() - 2 * 60 * 60_000 }, Number.MAX_SAFE_INTEGER, antigravityLoginIdentity(two.id, two.credential));
    reply = () => Response.json({ models: { "gemini-3.8-flash": { quotaInfo: { remainingFraction: 0.1 } } } });
    expect((await post("fetchAvailableModels", '{"project":"synthetic-project-two"}')).status).toBe(200);
    await Bun.sleep(50);
    expect(observedAntigravityAccountQuota(two.id)?.customWindows).toEqual([{ label: "Gem (Weekly)", percent: 40 }]);
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
    const before = calls.length;
    expect((await post("writeTrajectoryAcls", '{"trajectoryId":"t"}')).status).toBe(200);
    expect(served).toBe(cooled);
    expect((await post("loadCodeAssist", "{}")).status).toBe(200);
    expect(served).not.toBe(cooled);
    expect(calls).toHaveLength(before + 2);
  });

  for (const [label, message, quarantined] of [
    ["Google's verification demand marks the account needs-reauth(verify) and moves its callers", "Please verify your account to continue using Antigravity.", true],
    ["any other 403 passes through and leaves the account in the pool", "Permission denied on model gemini-3.8-pro for this tier.", false],
  ] as const) {
    test(label, async () => {
      await launch();
      let served = "";
      const denied = JSON.stringify({ error: { code: 403, message, status: "PERMISSION_DENIED" } });
      reply = captured => { served = captured.headers.get("authorization")!; return Response.json({}); };
      expect((await post("loadCodeAssist", "{}")).status).toBe(200);
      const refused = served;
      const project = Object.keys(tokens).find(id => tokens[id] === refused)!;
      const refusedRow = () => getAccountSet("google-antigravity")!.accounts.find(row => row.credential.projectId === project)!;
      reply = captured => {
        served = captured.headers.get("authorization")!;
        return new Response(denied, { status: 403, headers: { "content-type": "application/json" } });
      };
      const answer = await post("streamGenerateContent", JSON.stringify({ project, request: {} }));
      expect(answer.status).toBe(403);
      expect(answer.text).toBe(denied);
      for (let wait = 0; wait < 50 && refusedRow().needsReauth !== true; wait++) await Bun.sleep(10);
      expect(refusedRow().needsReauth === true).toBe(quarantined);
      if (quarantined) expect(refusedRow().needsReauthReason).toBe("verify_account");
      reply = captured => { served = captured.headers.get("authorization")!; return Response.json({}); };
      expect((await post("loadCodeAssist", "{}")).status).toBe(200);
      expect(served === refused).toBe(!quarantined);
      if (!quarantined) return;
      for (const caller of ["first", "second", "third"]) {
        expect((await post("loadCodeAssist", "{}", { authorization: `Bearer new-caller-${caller}` })).status).toBe(200);
        expect(served).not.toBe(refused);
      }
    });
  }

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

  test("chooseAgyAccount resolves project-scoped and project-less calls in a single auth.json read", async () => {
    await launch();
    const fs = await import("node:fs");
    const { chooseAgyAccount } = await import("../../src/server/agy-passthrough-accounts");
    const authPath = join(home, "auth.json");
    const readSpy = spyOn(fs, "readFileSync");
    try {
      const countAuthReads = () => readSpy.mock.calls.filter(([target]) => String(target) === authPath).length;
      const beforeProject = countAuthReads();
      const projectChoice = chooseAgyAccount({ project: "synthetic-project-one", callerKey: "caller-single-read", mayRotate: false });
      expect(projectChoice.kind).toBe("account");
      expect(countAuthReads() - beforeProject).toBeLessThanOrEqual(1);

      const beforeProjectless = countAuthReads();
      const projectlessChoice = chooseAgyAccount({ project: undefined, callerKey: "caller-single-read", mayRotate: true });
      expect(projectlessChoice.kind).toBe("account");
      expect(countAuthReads() - beforeProjectless).toBeLessThanOrEqual(1);
    } finally {
      readSpy.mockRestore();
    }
  });

  test("Antigravity observations and passthrough balancing ignore Claude usage and rank by highest Gemini usage", async () => {
    await launch();
    const { mergeAccountCredential } = await import("../../src/oauth/store");
    const { observedAntigravityAccountQuota, recordPassiveAccountQuota } = await import("../../src/providers/quota/account-cache");
    const { fetchObservedAntigravityQuota } = await import("../../src/providers/quota/vendor-probes-oauth");
    const { antigravityLoginIdentity } = await import("../../src/providers/antigravity-quota-identity");
    const { chooseAgyAccount } = await import("../../src/server/agy-passthrough-accounts");
    const accounts = getAccountSet("google-antigravity")!.accounts;
    const [acctA, acctB] = accounts as [typeof accounts[number], typeof accounts[number]];
    for (const row of [acctA, acctB]) {
      await mergeAccountCredential("google-antigravity", row.id, { ...row.credential, projectId: "shared-gemini-project" });
    }
    const now = Date.now();
    // Account A is low on Gemini (20%), high on Claude (95%); Account B is high on Argon/Gemini (42%), low on Claude (5%).
    recordPassiveAccountQuota("google-antigravity", acctA.id, {
      customWindows: [
        { label: "Gem", percent: 20 },
        { label: "Gem (Weekly)", percent: 36.67 },
        { label: "Cla", percent: 95 },
        { label: "Cla (Weekly)", percent: 51.12 },
      ],
      updatedAt: now - 10_000,
    }, Number.MAX_SAFE_INTEGER, antigravityLoginIdentity(acctA.id, acctA.credential));
    recordPassiveAccountQuota("google-antigravity", acctB.id, {
      customWindows: [
        { label: "Gem", percent: 25 },
        { label: "Argon (Weekly)", modelId: "gemini-4-argon", percent: 42 },
        { label: "Cla (Weekly)", percent: 5 },
      ],
      updatedAt: now,
    }, Number.MAX_SAFE_INTEGER, antigravityLoginIdentity(acctB.id, acctB.credential));

    const obsA = observedAntigravityAccountQuota(acctA.id);
    expect(obsA?.customWindows?.map(w => w.label)).toEqual(["Gem", "Gem (Weekly)"]);
    const providerRow = fetchObservedAntigravityQuota("google-antigravity");
    expect(providerRow?.quota.customWindows?.some(w => w.label.startsWith("Cla"))).toBe(false);
    // All remaining accounts (C, etc.) should rank above or before A if unmeasured; isolate A vs B by removing others or measuring usage directly on shared owners with others high:
    for (const rest of accounts.slice(2)) {
      await mergeAccountCredential("google-antigravity", rest.id, { ...rest.credential, projectId: "other-project" });
    }
    const chosen = chooseAgyAccount({ project: "shared-gemini-project", callerKey: "gemini-usage-test", mayRotate: true }, now);
    expect(chosen).toMatchObject({ kind: "account", accountId: acctA.id });
  });
});
