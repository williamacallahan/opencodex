import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFinalRequestLog } from "../../src/server";
import { admissionFields, markDashboardProxyPeer, resolveResponsesApiAuth } from "../../src/server/auth-cors";
import { clearRequestLogsForTests, getRequestLogEntries, hydrateRequestLogsFromDisk } from "../../src/server/request-log";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { computeRequestAttribution } from "../../src/server/request-attribution";
import { resolveAudioClient } from "../../src/server/audio-client";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import type { UsageAttributionBreakdown } from "../../src/usage/attribution-breakdown";
import { appendUsageEntry, normalizeUsageEntryForTest, readUsageEntries, resetUsageReadCacheForTests } from "../../src/usage/log";
import { ManagementRequest } from "../helpers/management-auth";
import { log } from "../helpers/request-log-entry";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const loopbackConfig: OcxConfig = { port: 0, hostname: "127.0.0.1", defaultProvider: "test", providers: {} };
/** The local reverse proxy at 127.0.0.1 is the one hop whose forwarding headers are believed. */
const trustedLocalProxy = { dashboardTrustedProxy: { origin: "https://hub.example", proxyAddresses: ["127.0.0.1"] } };
const previousHome = process.env.OPENCODEX_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-attribution-"));
  process.env.OPENCODEX_HOME = home;
  clearRequestLogsForTests();
});

afterEach(() => {
  closeRequestHistoryIndex();
  clearRequestLogsForTests();
  resetUsageReadCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function admittedRow(headers: Record<string, string>, peer: string | undefined, proxy: Pick<OcxConfig, "dashboardTrustedProxy"> = trustedLocalProxy) {
  const req = new Request("http://127.0.0.1:10100/v1/responses", { method: "POST", headers });
  markDashboardProxyPeer(req, peer, proxy);
  const admission = resolveResponsesApiAuth(req, loopbackConfig);
  if (!admission) throw new Error("loopback admission refused");
  addFinalRequestLog("attribution-row", 1, { model: "gpt-test", provider: "mock", ...admissionFields(admission) }, 200, { closeReason: "non_stream" });
  return { persisted: readUsageEntries().at(-1), live: getRequestLogEntries()[0] };
}

describe("request attribution on log rows", () => {
  test("a declared launcher behind the local proxy is persisted with its harness, address, workload, conversation, and host", () => {
    const { persisted, live } = admittedRow({
      "user-agent": "claude-cli/2.1.0 (external, cli)",
      "x-user-id": "claude-oc:session-1",
      "x-lgw-cache-key": "claude-oc:conversation-1",
      "x-lgw-client-host": "laptop-1",
      "x-forwarded-for": "203.0.113.9, 198.51.100.4",
      authorization: "Bearer caller-secret-token",
      cookie: "session=caller-cookie",
    }, "127.0.0.1");
    const expected = {
      userAgent: "claude-cli/2.1.0 (external, cli)",
      peerAddress: "127.0.0.1",
      forwardedFor: "203.0.113.9, 198.51.100.4",
      // Only the entry the local proxy appended is trusted; the leftmost one is caller-written.
      clientAddress: "198.51.100.4",
      workload: "claude-oc:session-1",
      conversationKey: "claude-oc:conversation-1",
      clientHost: "laptop-1",
    };
    expect(persisted).toMatchObject(expected);
    expect(live).toMatchObject(expected);
    for (const row of [persisted, live]) {
      expect(JSON.stringify(row)).not.toContain("caller-secret-token");
      expect(JSON.stringify(row)).not.toContain("caller-cookie");
    }
  });

  test("an undeclared caller gets the hub-derived workload and invalid declarations are dropped", () => {
    const { persisted } = admittedRow({
      "user-agent": "codex_cli_rs/0.1.0",
      "x-user-id": "Someone-Else:chosen",
      "x-lgw-client-host": "laptop.example",
      "x-forwarded-for": "not-an-address, 192.0.2.1:443",
    }, "::ffff:127.0.0.1");
    expect(persisted?.workload).toBe("codex:via-opencodex");
    expect(persisted?.peerAddress).toBe("127.0.0.1");
    expect(persisted?.clientAddress).toBe("127.0.0.1");
    expect(persisted).not.toHaveProperty("forwardedFor");
    expect(persisted).not.toHaveProperty("clientHost");
    expect(persisted).not.toHaveProperty("conversationKey");
  });

  test("any launcher may declare its workload, but a declared hub operation counts as undeclared", () => {
    expect(admittedRow({ "user-agent": "opencode/1.0", "x-user-id": "vibe-oc:session-7" }, "127.0.0.1").persisted?.workload).toBe("vibe-oc:session-7");
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    const forged = admittedRow({ "user-agent": "opencode/1.0", "x-user-id": "amp:session:via-opencodex", "x-lgw-cache-key": "amp:x:via-opencodex" }, "127.0.0.1");
    expect(forged.live?.workload).toBe("opencode:via-opencodex");
    expect(forged.live).not.toHaveProperty("conversationKey");
  });

  test("a caller that is not the configured proxy cannot name its own address, from loopback, a LAN or anywhere else", () => {
    for (const peer of ["127.0.0.1", "192.168.1.20", "192.0.2.20"]) {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      const { persisted } = admittedRow({ "x-forwarded-for": "198.51.100.4", "x-real-ip": "203.0.113.9" }, peer, {});
      expect(persisted).toMatchObject({ peerAddress: peer, clientAddress: peer });
      expect(persisted).not.toHaveProperty("forwardedFor");
    }
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    expect(admittedRow({ "x-real-ip": "203.0.113.9" }, "127.0.0.1").persisted?.clientAddress).toBe("203.0.113.9");
  });

  test("each harness's own session header names its row when the caller declares no workload", () => {
    const session = "6f1c2a4e-0b3d-4c5e-8f70-1a2b3c4d5e6f";
    const thread = "7a2d3b5f-1c4e-4d6f-9a81-2b3c4d5e6f70";
    const cases: Array<[Record<string, string>, string, string, string | undefined]> = [
      [{ "user-agent": "claude-cli/2.1.0 (external, cli)", "x-claude-code-session-id": session, "x-claude-code-agent-id": "agent-7" }, "claude_code", `claude-code:${session}`, "agent-7"],
      [{ "user-agent": "codex_cli_rs/0.1.0", originator: "codex_cli_rs", session_id: session, "thread-id": thread, "x-codex-installation-id": "install-secret" }, "codex_cli", `codex-cli:${session}`, thread],
      [{ "user-agent": "pi/0.9.1 (darwin; arm64)", "session-id": session, "x-client-request-id": "req-1" }, "pi", `pi:${session}`, undefined],
      [{ "user-agent": "OpenAI/JS 5.1.0", "x-amp-thread-id": `T-${session}` }, "amp", `amp:T-${session}`, undefined],
      [{ "user-agent": "opencode/1.0", "x-opencode-session": "ses_0a1b2c3d", "x-parent-session-id": "ses_parent" }, "opencode", "opencode:ses_0a1b2c3d", undefined],
    ];
    for (const [headers, client, workload, agent] of cases) {
      clearRequestLogsForTests();
      resetUsageReadCacheForTests();
      const { persisted, live } = admittedRow(headers, "127.0.0.1");
      for (const row of [persisted, live]) {
        expect(row).toMatchObject({ client, harnessSessionId: workload.slice(workload.indexOf(":") + 1), workload, workloadSource: "harness" });
        if (agent) expect(row?.harnessAgentId).toBe(agent);
        else expect(row).not.toHaveProperty("harnessAgentId");
        expect(JSON.stringify(row)).not.toContain("install-secret");
      }
    }
  });

  test("an audio or live-call admission carries the request's client like every other route", () => {
    const req = new Request("http://127.0.0.1:10100/v1/audio/transcriptions", { method: "POST",
      headers: { "user-agent": "pi/0.9.1", "session-id": "s-2", "x-opencodex-api-key": "ocx_data_audiofixture" } });
    const audio = resolveAudioClient(req, { ...loopbackConfig, apiKeys: [{ id: "audio", name: "audio", key: "ocx_data_audiofixture", createdAt: "2026-01-01T00:00:00.000Z" }] });
    if (!audio || audio instanceof Response) throw new Error("loopback audio admission refused");
    expect(audio.admission.attribution).toMatchObject({ client: "pi", harnessSessionId: "s-2", workload: "pi:s-2" });
  });

  test("a declared workload wins over the native session, and an invalid native id is dropped rather than cut", () => {
    const declared = admittedRow({ "user-agent": "claude-cli/2.1.0 (external, cli)", "x-user-id": "claude-oc:session-1", "x-claude-code-session-id": "s-1" }, "127.0.0.1");
    expect(declared.persisted).toMatchObject({ workload: "claude-oc:session-1", workloadSource: "declared", harnessSessionId: "s-1" });
    clearRequestLogsForTests();
    resetUsageReadCacheForTests();
    const invalid = admittedRow({ "user-agent": "pi/0.9.1", "session-id": `bad id ${"x".repeat(200)}` }, "127.0.0.1");
    expect(invalid.persisted).toMatchObject({ client: "pi", workload: "pi:via-opencodex", workloadSource: "hub" });
    expect(invalid.persisted).not.toHaveProperty("harnessSessionId");
    expect(computeRequestAttribution(new Request("http://127.0.0.1:10100/agy/key/v1internal:generateContent", { method: "POST" }), "127.0.0.1"))
      .toMatchObject({ client: "antigravity_cli", workloadSource: "hub" });
  });

  test("rows written before attribution read back unchanged, and hand-edited values are re-bounded", () => {
    expect(hydrateRequestLogsFromDisk(() => [log({ requestId: "legacy" })])).toBe(1);
    const legacy = getRequestLogEntries()[0];
    for (const field of ["userAgent", "peerAddress", "forwardedFor", "clientAddress", "workload", "conversationKey", "clientHost"]) {
      expect(legacy).not.toHaveProperty(field);
    }
    const edited = normalizeUsageEntryForTest({
      ...log({ requestId: "edited" }), clientAddress: "not-an-address", clientHost: "two words", userAgent: "x".repeat(600),
    });
    expect(edited).not.toHaveProperty("clientAddress");
    expect(edited).not.toHaveProperty("clientHost");
    expect(edited.userAgent).toHaveLength(512);
  });
});

async function managementGet(path: string, config: OcxConfig = loopbackConfig): Promise<Response> {
  const req = new ManagementRequest(`http://localhost${path}`, { method: "GET" });
  const response = await handleManagementAPI(req, new URL(req.url), config, { refreshCodexCatalog: async () => {} });
  if (!response) throw new Error(`no management route for ${path}`);
  return response;
}

describe("gateway opt-in in the provider listing", () => {
  test("/api/providers names the headers each row forwards, so the gateway opt-in can be read back", async () => {
    const response = await managementGet("/api/providers", { ...loopbackConfig, providers: {
      relay: { adapter: "openai-responses", baseUrl: "https://lb.example/backend-api/codex", apiKey: "relay-key", forwardClientHeaders: ["x-user-id", "x-lgw-cache-key"] },
      vendor: { adapter: "openai-chat", baseUrl: "https://vendor.example/v1", apiKey: "vendor-key" },
    } });
    const rows = await response.json() as Array<{ name: string; forwardClientHeaders?: string[] }>;
    expect(Object.fromEntries(rows.map(row => [row.name, row.forwardClientHeaders]))).toEqual({ relay: ["x-user-id", "x-lgw-cache-key"], vendor: undefined });
    expect(JSON.stringify(rows)).not.toContain("relay-key");
  });
});

describe("attribution filters on stored history", () => {
  test("/api/request-history filters by workload, device, client address, harness, and undeclared callers", async () => {
    const row = (requestId: string, timestamp: number, extra: Parameters<typeof log>[0]) =>
      appendUsageEntry({ ...log({ requestId, timestamp }), ...extra });
    // "declared" and "undeclared" predate workloadSource; their source comes from the old suffix rule.
    row("declared", 10, { workload: "claude-oc:session-1", clientHost: "laptop-1", clientAddress: "198.51.100.4" });
    row("undeclared", 20, { workload: "codex:via-opencodex", clientHost: "desk-2", clientAddress: "203.0.113.9" });
    row("legacy", 30, {});
    row("pi-session", 40, { client: "pi", harnessSessionId: "6f1c2a4e-0b3d-4c5e-8f70-1a2b3c4d5e6f", workload: "pi:6f1c2a4e-0b3d-4c5e-8f70-1a2b3c4d5e6f", workloadSource: "harness" });
    const ids = async (query: string) => {
      const response = await managementGet(`/api/request-history?${query}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { entries: Array<{ requestId: string }> };
      return body.entries.map(entry => entry.requestId);
    };
    expect(await ids("workload=claude-oc%3Asession-1")).toEqual(["declared"]);
    expect(await ids("clientHost=desk-2")).toEqual(["undeclared"]);
    expect(await ids("clientAddress=198.51.100.4")).toEqual(["declared"]);
    expect(await ids("undeclared=true")).toEqual(["pi-session", "undeclared"]);
    expect(await ids("harness=pi")).toEqual(["pi-session"]);
    expect(await ids("harnessSession=6f1c2a4e-0b3d-4c5e-8f70-1a2b3c4d5e6f")).toEqual(["pi-session"]);
    expect(await ids("")).toEqual(["pi-session", "legacy", "undeclared", "declared"]);
  });
});

describe("attribution in the usage summary", () => {
  test("/api/usage reports who sent the window's requests and filters by attribution", async () => {
    const now = Date.now();
    const row = (requestId: string, extra: Parameters<typeof log>[0]) =>
      appendUsageEntry({ ...log({ requestId, timestamp: now, usageStatus: "reported", totalTokens: 10 }), ...extra });
    row("declared-1", { client: "claude_code", workload: "claude-oc:session-1", workloadSource: "declared", clientHost: "laptop-1", clientAddress: "198.51.100.4" });
    row("declared-2", { client: "claude_code", workload: "claude-oc:session-1", workloadSource: "declared", clientHost: "laptop-1", clientAddress: "198.51.100.4" });
    row("undeclared", { client: "codex_cli", workload: "codex:via-opencodex", clientAddress: "203.0.113.9" });
    row("amp-thread", { client: "amp", harnessSessionId: "T-session-9", workload: "amp:T-session-9", workloadSource: "harness" });
    row("legacy", {});
    type Summary = { summary: { requests: number }; attribution: UsageAttributionBreakdown };
    const summary = async (query: string) => {
      const response = await managementGet(`/api/usage?range=1d${query}`);
      expect(response.status).toBe(200);
      return await response.json() as Summary;
    };
    const all = await summary("");
    expect(all.summary.requests).toBe(5);
    expect(all.attribution.byHarness).toEqual([
      { key: "claude_code", requests: 2, totalTokens: 20 }, { key: "amp", requests: 1, totalTokens: 10 }, { key: "codex_cli", requests: 1, totalTokens: 10 },
    ]);
    expect(all.attribution.byWorkloadSource.map(entry => [entry.key, entry.requests])).toEqual([["declared", 2], ["harness", 1], ["hub", 1]]);
    expect(all.attribution.byWorkload.map(entry => [entry.key, entry.requests])).toEqual([["claude-oc:session-1", 2], ["amp:T-session-9", 1], ["codex:via-opencodex", 1]]);
    expect(all.attribution.byClientHost.map(entry => [entry.key, entry.requests])).toEqual([["laptop-1", 2]]);
    expect(all.attribution.byClientAddress.map(entry => [entry.key, entry.requests])).toEqual([["198.51.100.4", 2], ["203.0.113.9", 1]]);
    expect((await summary("&undeclared=true")).summary.requests).toBe(2);
    expect((await summary("&harness=amp")).summary.requests).toBe(1);
    expect((await summary("&harnessSession=T-session-9")).summary.requests).toBe(1);
    expect((await summary("&clientHost=laptop-1")).summary.requests).toBe(2);
    expect((await summary("&clientAddress=203.0.113.9")).summary.requests).toBe(1);
    expect((await summary("&workload=claude-oc%3Asession-1")).attribution.byWorkload).toEqual([{ key: "claude-oc:session-1", requests: 2, totalTokens: 20 }]);
  });
});

describe("Reserve in the usage summary", () => {
  test("a Reserve send is its own model row instead of merging into the requested model", async () => {
    const now = Date.now();
    appendUsageEntry({ ...log({ requestId: "reserve", timestamp: now, provider: "openai", model: "gpt-5.5", usageStatus: "reported", totalTokens: 7 }), wireModel: "gpt-reserve" });
    appendUsageEntry({ ...log({ requestId: "direct", timestamp: now, provider: "openai", model: "gpt-5.5", usageStatus: "reported", totalTokens: 5 }) });
    const response = await managementGet("/api/usage?range=1d");
    const body = await response.json() as { models: Array<{ model: string; requests: number }> };
    expect(body.models.map(row => [row.model, row.requests]).sort()).toEqual([["gpt-5.5", 1], ["gpt-reserve", 1]]);
    const filtered = await (await managementGet("/api/usage?range=1d&model=gpt-reserve")).json() as { summary: { requests: number } };
    expect(filtered.summary.requests).toBe(1);
  });
});
