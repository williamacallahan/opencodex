import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyInterceptClient, interceptEntrypoint, interceptRouteFor } from "../../src/claude/intercept/client-class";
import { startClaudeInterceptListener } from "../../src/claude/intercept/listener";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
import { startClaudeIntercept } from "../../src/claude/intercept/runtime";
import { startConnectProxy } from "../../src/claude/intercept/connect-proxy";
import { readClaudeInterceptProxyToken } from "../../src/claude/intercept/proxy-auth";
import { buildInterceptDesiredClients } from "../../src/server/index/claude-intercept-lifecycle";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const samples: Array<[string | null, string | null, "desktop" | "cli" | "unknown"]> = [
  ["claude-cli/2.1.282 (external, cli)", "cli", "cli"],
  ["claude-cli/2.1.282 (external, sdk-cli)", "sdk-cli", "cli"],
  ["claude-cli/2.1.282 (external, claude-vscode)", "claude-vscode", "cli"],
  ["claude-cli/2.1.282 (external, claude-desktop)", "claude-desktop", "desktop"],
  ["claude-cli/2.1.282 (external, claude-desktop-3p)", "claude-desktop-3p", "desktop"],
  ["claude-cli/2.1.282 (external, local-agent)", "local-agent", "desktop"],
  ["claude-cli/2.1.282 (external, cli, agent-sdk/0.3)", "cli", "cli"],
  [null, null, "unknown"], ["Mozilla/5.0", null, "unknown"], ["garbage", null, "unknown"],
  ["claude-cli/2.1.282 (external, cli, junk", null, "unknown"],
  ["claude-cli/2.1.282 (external, cli)junk", null, "unknown"],
  ["claude-cli/2.1.282 (external,cli)", null, "unknown"],
  ["claude-cli/ (external, cli)", null, "unknown"],
  [" claude-cli/2.1.282 (external, cli)", null, "unknown"],
];
test.each(samples)("entrypoint %s", (ua, entrypoint, client) => {
  expect(interceptEntrypoint(ua)).toBe(entrypoint);
  expect(classifyInterceptClient(ua)).toBe(client);
});

test("intent matrix routes only identified, desired clients", () => {
  for (const desktop of [false, true]) for (const cli of [false, true]) {
    for (const client of ["desktop", "cli", "unknown"] as const) {
      expect(interceptRouteFor(client, { desktop, cli })).toBe(
        client !== "unknown" && (client === "desktop" ? desktop : cli) ? "router" : "relay-native",
      );
    }
  }
});

test("strict interception reaches managed dispatch regardless of client intent; other paths keep native routing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strict-intercept-"));
  const originalFetch = globalThis.fetch;
  const relay: string[] = [];
  const config = { port: 10100, providers: {}, defaultProvider: "anthropic",
    claudeCode: { strictPassthrough: true, intercept: { port: 10200, picker: false },
      anthropicBaseUrl: "https://unused.fixture.invalid" } } as OcxConfig;
  let handle: Awaited<ReturnType<typeof startClaudeIntercept>>;
  const body = '{ "model" : "claude-x", "opaque" : 1e+02 }';
  const dispatch: string[] = [];
  let blocked = 0;
  // No external sockets: canonical upstream calls are synthetic, client calls need our proxy.
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (handle && init?.proxy === `http://opencodex:${readClaudeInterceptProxyToken(dir)}@127.0.0.1:${handle.proxyPort}`) {
      return originalFetch(input, init);
    }
    if (url.startsWith("https://api.anthropic.com/")) { relay.push(url); return new Response("fixture relay"); }
    blocked++;
    throw new Error("unexpected strict intercept network");
  }, { preconnect: () => { blocked++; throw new Error("unexpected preconnect"); } }) as typeof fetch;
  try {
    handle = await startClaudeIntercept({ config, publicPort: 10100, configDir: dir,
      desiredClients: () => ({ desktop: false, cli: false }),
      startProxy: (_port, options) => startConnectProxy(0, options),
      dispatch: async request => { dispatch.push(new URL(request.url).pathname); return new Response(await request.arrayBuffer()); },
    });
    expect(handle).not.toBeNull();
    const proxy = `http://opencodex:${readClaudeInterceptProxyToken(dir)}@127.0.0.1:${handle!.proxyPort}`;
    const tls = { ca: readFileSync(handle!.caCertPath, "utf8") };
    for (const ua of ["unrecognized-client", "claude-cli/2.1.282 (external, cli)"]) {
      for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
        const response = await fetch(`https://api.anthropic.com${path}`, {
          method: "POST", body, headers: { "user-agent": ua }, proxy, tls,
        });
        expect(await response.text()).toBe(body);
      }
    }
    expect(dispatch).toEqual(["/v1/messages", "/v1/messages/count_tokens", "/v1/messages", "/v1/messages/count_tokens"]);
    expect(relay).toEqual([]);
    const other = await fetch("https://api.anthropic.com/v1/models", { proxy, tls });
    expect(await other.text()).toBe("fixture relay");
    config.claudeCode!.strictPassthrough = false;
    const legacy = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", body, proxy, tls });
    expect(await legacy.text()).toBe("fixture relay");
    expect(relay).toEqual(["https://api.anthropic.com/v1/models", "https://api.anthropic.com/v1/messages"]);
    expect(blocked).toBe(0);
  } finally {
    await handle?.stop();
    globalThis.fetch = originalFetch;
    removeTreeWithRetry(dir);
  }
});

test("disabled live Claude config relays Desktop and CLI on Messages and other paths", async () => {
  const config = {
    port: 10100, providers: {}, defaultProvider: "openai",
    clientIntegrations: { "claude-desktop": true },
    claudeCode: { desktopMode: "first-party", cliFirstParty: true },
  } as OcxConfig;
  const desiredClients = buildInterceptDesiredClients(config, {});
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, ["127.0.0.1"]);
  const targets: string[] = [];
  const listener = startClaudeInterceptListener({
    leaf, upstreamBase: "https://custom.example",
    fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
      targets.push(String(input));
      return Response.json({ via: "relay" });
    }) as typeof fetch,
    route: req => interceptRouteFor(classifyInterceptClient(req.headers.get("user-agent")), desiredClients()),
    dispatch: async () => Response.json({ via: "router" }),
  });
  try {
    const cli = "claude-cli/2.1.282 (external, cli)";
    const desktop = "claude-cli/2.1.282 (external, claude-desktop)";
    for (const ua of [cli, desktop]) {
      const response = await fetch(`https://127.0.0.1:${listener.port}/v1/messages`, {
        method: "POST", body: "{}", headers: { "user-agent": ua }, tls: { ca: ca.certPem },
      });
      expect(await response.json()).toEqual({ via: "router" });
    }
    config.claudeCode!.enabled = false;
    for (const ua of [cli, desktop]) for (const path of ["/v1/messages", "/v1/models"]) {
      const response = await fetch(`https://127.0.0.1:${listener.port}${path}`, {
        method: path === "/v1/messages" ? "POST" : "GET",
        ...(path === "/v1/messages" ? { body: "{}" } : {}),
        headers: { "user-agent": ua }, tls: { ca: ca.certPem },
      });
      expect(await response.json()).toEqual({ via: "relay" });
    }
    expect(targets).toEqual([
      "https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/models",
      "https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/models",
    ]);
  } finally { await listener.stop(true); }
});

test("listener chooses router or relay by UA and live intent; relay preserves the request", async () => {
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, ["127.0.0.1"]);
  const dispatched: string[] = [];
  const relayed: Array<{ url: string; method: string; body: string; authorization: string | null; anthropic: string | null }> = [];
  let desired = { desktop: false, cli: true };
  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    relayed.push({ url: String(input), method: init?.method ?? "", body: await new Response(init?.body).text(),
      authorization: headers.get("authorization"), anthropic: headers.get("anthropic-version") });
    return Response.json({ path: "relay" });
  }) as typeof fetch;
  const listener = startClaudeInterceptListener({ leaf, upstreamBase: "https://api.anthropic.com", fetchImpl: fakeFetch,
    route: req => interceptRouteFor(classifyInterceptClient(req.headers.get("user-agent")), desired),
    dispatch: async req => { dispatched.push(new URL(req.url).pathname); return Response.json({ path: "router" }); } });
  try {
    for (const [ua, route] of [
      ["claude-cli/2.1.282 (external, cli)", "router"],
      ["claude-cli/2.1.282 (external, claude-desktop)", "relay"],
      ["Mozilla/5.0", "relay"],
    ] as const) {
      const response = await fetch(`https://127.0.0.1:${listener.port}/v1/messages?x=1`, {
        method: "POST", headers: { "user-agent": ua, authorization: "Bearer opaque", "anthropic-version": "2023-06-01" },
        body: "opaque-body", tls: { ca: ca.certPem },
      });
      expect((await response.json() as { path: string }).path).toBe(route);
    }
    desired = { desktop: true, cli: false };
    const response = await fetch(`https://127.0.0.1:${listener.port}/v1/messages/count_tokens`, {
      method: "POST", headers: { "user-agent": "claude-cli/2.1.282 (external, claude-desktop-3p)" },
      body: "{}", tls: { ca: ca.certPem },
    });
    expect((await response.json() as { path: string }).path).toBe("router");
    expect(dispatched).toEqual(["/v1/messages", "/v1/messages/count_tokens"]);
    expect(relayed).toEqual([
      { url: "https://api.anthropic.com/v1/messages?x=1", method: "POST", body: "opaque-body", authorization: "Bearer opaque", anthropic: "2023-06-01" },
      { url: "https://api.anthropic.com/v1/messages?x=1", method: "POST", body: "opaque-body", authorization: "Bearer opaque", anthropic: "2023-06-01" },
    ]);
    for (const desktop of [false, true]) for (const cli of [false, true]) {
      desired = { desktop, cli };
      for (const [ua, , client] of samples) for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
        // Fetch normalizes leading header whitespace before the listener can observe it.
        if (ua?.startsWith(" ")) continue;
        const headers = new Headers({ authorization: "Bearer matrix", "anthropic-version": "2023-06-01" });
        if (ua !== null) headers.set("user-agent", ua);
        const beforeRouter = dispatched.length;
        const beforeRelay = relayed.length;
        const result = await fetch(`https://127.0.0.1:${listener.port}${path}`, {
          method: "POST", headers, body: "matrix-body", tls: { ca: ca.certPem },
        });
        const expectedRoute = client !== "unknown" && (client === "desktop" ? desktop : cli) ? "router" : "relay-native";
        const actualRoute = (await result.json() as { path: string }).path;
        if (actualRoute !== (expectedRoute === "router" ? "router" : "relay")) {
          throw new Error(`route mismatch ua=${ua} client=${client} desktop=${desktop} cli=${cli} path=${path}: ${actualRoute}`);
        }
        expect(dispatched.length - beforeRouter).toBe(expectedRoute === "router" ? 1 : 0);
        expect(relayed.length - beforeRelay).toBe(expectedRoute === "relay-native" ? 1 : 0);
        if (expectedRoute === "relay-native") expect(relayed.at(-1)).toEqual({
          url: `https://api.anthropic.com${path}`, method: "POST", body: "matrix-body",
          authorization: "Bearer matrix", anthropic: "2023-06-01",
        });
      }
    }
    const beforeRouter = dispatched.length;
    for (const [method, path] of [["GET", "/v1/messages"], ["POST", "/v1/models"]] as const) {
      const result = await fetch(`https://127.0.0.1:${listener.port}${path}`, {
        method, tls: { ca: ca.certPem },
      });
      expect((await result.json() as { path: string }).path).toBe("relay");
    }
    expect(dispatched.length).toBe(beforeRouter);
  } finally { await listener.stop(true); }
});
test("opted-out requests use real Anthropic on every path; opted-in other paths keep custom upstream", async () => {
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, ["127.0.0.1"]);
  const targets: string[] = [];
  const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
    targets.push(String(input));
    return Response.json({ via: "relay" });
  }) as typeof fetch;
  const listener = startClaudeInterceptListener({
    leaf, upstreamBase: "https://custom.example", fetchImpl: fakeFetch,
    route: req => interceptRouteFor(classifyInterceptClient(req.headers.get("user-agent")), { desktop: false, cli: true }),
    dispatch: async () => Response.json({ via: "router" }),
  });
  try {
    for (const path of ["/v1/messages", "/v1/models"]) {
      const response = await fetch(`https://127.0.0.1:${listener.port}${path}`, {
        method: path === "/v1/messages" ? "POST" : "GET",
        headers: { "user-agent": "claude-cli/2.1.282 (external, claude-desktop)" },
        ...(path === "/v1/messages" ? { body: "{}" } : {}), tls: { ca: ca.certPem },
      });
      expect(await response.json()).toEqual({ via: "relay" });
    }
    const optedIn = await fetch(`https://127.0.0.1:${listener.port}/v1/models`, {
      headers: { "user-agent": "claude-cli/2.1.282 (external, cli)" }, tls: { ca: ca.certPem },
    });
    expect(await optedIn.json()).toEqual({ via: "relay" });
    expect(targets).toEqual([
      "https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/models",
      "https://custom.example/v1/models",
    ]);
  } finally { await listener.stop(true); }
});

test("native relay streams SSE incrementally and cancels upstream on client abort", async () => {
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, ["127.0.0.1"]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  let signalCancellation!: () => void;
  const cancelled = new Promise<void>(resolve => { signalCancellation = resolve; });
  let secondEnqueued = false;
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(encoder.encode("event: first\ndata: 1\n\n"));
    },
    cancel() { signalCancellation(); },
  });
  const fakeFetch = (async () => {
    void secondGate.then(async () => {
      await Bun.sleep(25);
      secondEnqueued = true;
      streamController.enqueue(encoder.encode("event: second\ndata: 2\n\n"));
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const listener = startClaudeInterceptListener({
    leaf, fetchImpl: fakeFetch, route: () => "relay-native",
    dispatch: async () => Response.json({ via: "router" }),
  });
  try {
    const abort = new AbortController();
    const response = await fetch(`https://127.0.0.1:${listener.port}/v1/messages`, {
      method: "POST", body: "{}", signal: abort.signal, tls: { ca: ca.certPem },
    });
    expect(response.headers.get("content-type")).toStartWith("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("event: first\ndata: 1\n\n");
    expect(secondEnqueued).toBe(false); // observed before the producer can enqueue event two
    releaseSecond();
    const second = await reader.read();
    expect(decoder.decode(second.value)).toBe("event: second\ndata: 2\n\n");
    const pendingRead = reader.read().catch(() => undefined);
    abort.abort();
    await Promise.race([cancelled, Bun.sleep(1000).then(() => { throw new Error("upstream stream was not cancelled"); })]);
    await pendingRead;
  } finally { await listener.stop(true); }
});
