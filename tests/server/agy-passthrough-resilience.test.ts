import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { gzipSync, brotliCompressSync, deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { bindNativeHarnessConfig } from "../../src/lib/native-harness";
import { clearGenericFailoverHealth, rotateGenericOAuthAccountOn429 } from "../../src/oauth/generic-account-failover";
import { clearPoolRotationState } from "../../src/oauth/pool-kernel";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import { extractTopLevelJsonStringField, handleAgyPassthrough } from "../../src/server/agy-passthrough";
import { chooseAgyAccount, resetAgyAccountState } from "../../src/server/agy-passthrough-accounts";
import { AgyUpstreamSendError, describeUpstreamTransportError, sendExactly } from "../../src/server/agy-passthrough-send";
import { readBoundedRequestBytes } from "../../src/server/index/bounded-request";
import { clearAccountQuotaCache } from "../../src/providers/quota";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const hubKey = `ocx_data_${"c".repeat(40)}`;
const agyAgent = "antigravity/cli/1.5.12 (aidev_client; os_type=linux; arch=x64; cl=1; auth_method=consumer)";

describe("agy passthrough resilience and zero-AST parsing", () => {
  let home: string;
  let savedHome: string | undefined;
  let release: (() => void) | undefined;

  beforeEach(async () => {
    savedHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-agy-resilience-"));
    process.env.OPENCODEX_HOME = home;
    release = acquireOwnedSpendHome();
    clearGenericFailoverHealth();
    clearPoolRotationState();
    resetAgyAccountState();
    clearAccountQuotaCache();
    mkdirSync(home, { recursive: true });
    await saveCredential("google-antigravity", {
      access: "synthetic-a-access",
      refresh: "synthetic-a-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "acct-shared-a",
      projectId: "proj-shared",
    });
    await saveCredential("google-antigravity", {
      access: "synthetic-b-access",
      refresh: "synthetic-b-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "acct-shared-b",
      projectId: "proj-shared",
    });
  });

  afterEach(() => {
    bindNativeHarnessConfig(null);
    clearGenericFailoverHealth();
    clearPoolRotationState();
    resetAgyAccountState();
    clearAccountQuotaCache();
    release?.();
    release = undefined;
    if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = savedHome;
    removeTreeWithRetry(home);
  });

  test("extractTopLevelJsonStringField handles nested objects, escapes, non-strings, and malformed payloads", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(extractTopLevelJsonStringField(enc('{"request":{"project":"nested"},"project":"top-proj"}'), "project")).toBe("top-proj");
    expect(extractTopLevelJsonStringField(enc('{"arr":[{"project":"inner"}],"\\u0070roject":"esc-proj"}'), "project")).toBe("esc-proj");
    expect(extractTopLevelJsonStringField(enc('{"project":"proj\\/a\\tb"}'), "project")).toBe("proj/a\tb");
    expect(extractTopLevelJsonStringField(enc('{"project":123}'), "project")).toBeUndefined();
    expect(extractTopLevelJsonStringField(enc('{"project":""}'), "project")).toBeUndefined();
    expect(extractTopLevelJsonStringField(enc('{"request":{"project":"only-nested"}}'), "project")).toBeUndefined();
    expect(extractTopLevelJsonStringField(enc("[]"), "project")).toBeUndefined();
    expect(extractTopLevelJsonStringField(enc('{"project":"unterminated'), "project")).toBeUndefined();
  });

  test("chooseAgyAccount rotates cooled-down project owners onto another healthy owner of the same project", () => {
    const now = Date.now();
    const first = chooseAgyAccount({ project: "proj-shared", callerKey: "sticky-caller", mayRotate: false }, now);
    expect(first.kind).toBe("account");
    if (first.kind !== "account") throw new Error("expected account");
    const firstId = first.accountId;

    const config: OcxConfig = {
      port: 0,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": { adapter: "google", authMode: "oauth", baseUrl: "https://127.0.0.1" },
      },
    };
    rotateGenericOAuthAccountOn429(config, "google-antigravity", firstId, "60", now, null, false);

    const rotated = chooseAgyAccount({ project: "proj-shared", callerKey: "sticky-caller", mayRotate: false }, now + 1);
    expect(rotated.kind).toBe("account");
    if (rotated.kind !== "account") throw new Error("expected account");
    expect(rotated.accountId).not.toBe(firstId);
  });

  test("sendExactly enforces header timeout and handleAgyPassthrough logs safe upstream failure warning", async () => {
    const server = createServer((_req, _res) => {
      // Never sends response headers so the bounded header timeout triggers.
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const target = new URL(`http://127.0.0.1:${port}/v1internal:generateContent`);
      await expect(sendExactly(target, new Headers({ "content-type": "application/json" }), new Uint8Array(2), new AbortController().signal, 30))
        .rejects.toMatchObject({ name: "AgyUpstreamSendError", code: "ETIMEDOUT" });
      try {
        await sendExactly(target, new Headers(), new Uint8Array(2), new AbortController().signal, 25);
        throw new Error("expected timeout");
      } catch (error) {
        expect(error).toBeInstanceOf(AgyUpstreamSendError);
        const typed = error as AgyUpstreamSendError;
        expect(["connect", "headers"]).toContain(typed.phase);
        expect(typed.host).toBe(`127.0.0.1:${port}`);
      }
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    // Exercise handleAgyPassthrough catch path on an unreachable loopback port.
    const deadServer = createServer();
    await new Promise<void>(resolve => deadServer.listen(0, "127.0.0.1", resolve));
    const deadPort = (deadServer.address() as { port: number }).port;
    await new Promise<void>(resolve => deadServer.close(() => resolve()));

    const config: OcxConfig = {
      port: 0,
      defaultProvider: "google-antigravity",
      apiKeys: [{ id: "k1", key: hubKey }],
      nativeHarnessOnly: true,
      providers: {
        "google-antigravity": { adapter: "google", authMode: "oauth", baseUrl: `http://127.0.0.1:${deadPort}` },
      },
    };
    saveConfig(config);
    bindNativeHarnessConfig(config);

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const req = new Request(`http://localhost/agy/${hubKey}/v1internal:generateContent`, {
        method: "POST",
        headers: {
          "user-agent": agyAgent,
          authorization: "Bearer synthetic-client-secret",
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body: gzipSync(Buffer.from('{"project":"proj-shared","secretBodyMarker":"do-not-log"}')),
      });
      const res = await handleAgyPassthrough(req, { config, draining: false });
      expect(res.status).toBe(503);
      const failureWarn = warnSpy.mock.calls.find(call => String(call[0]).includes("upstream failure"));
      expect(failureWarn).toBeDefined();
      const detail = failureWarn![1] as {
        code?: unknown;
        syscall?: unknown;
        message?: unknown;
        elapsedMs?: unknown;
        reusedSocket?: unknown;
      };
      expect(detail.code).toBe("ECONNREFUSED");
      expect(detail.syscall).toBe("connect");
      expect(typeof detail.message).toBe("string");
      expect((detail.message as string).length).toBeGreaterThan(0);
      expect(typeof detail.elapsedMs).toBe("number");
      expect("reusedSocket" in detail).toBe(true);
      const serialized = JSON.stringify(failureWarn);
      expect(serialized).not.toContain("synthetic-a-access");
      expect(serialized).not.toContain("synthetic-b-access");
      expect(serialized).not.toContain("synthetic-client-secret");
      expect(serialized).not.toContain("do-not-log");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("handleAgyPassthrough decodes gzip, deflate, and brotli payloads asynchronously without blocking", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response('{"candidates":[]}', { status: 200, headers: { "content-type": "application/json" } }),
    });
    const config: OcxConfig = {
      port: 0,
      defaultProvider: "google-antigravity",
      apiKeys: [{ id: "k1", key: hubKey }],
      nativeHarnessOnly: true,
      providers: {
        "google-antigravity": { adapter: "google", authMode: "oauth", baseUrl: upstream.url.origin },
      },
    };
    saveConfig(config);
    bindNativeHarnessConfig(config);
    try {
      const raw = Buffer.from('{"project":"proj-shared","payload":"ok"}');
      const cases = [
        { encoding: "gzip", body: gzipSync(raw) },
        { encoding: "deflate", body: deflateSync(raw) },
        { encoding: "br", body: brotliCompressSync(raw) },
      ] as const;
      for (const { encoding, body } of cases) {
        const req = new Request(`http://localhost/agy/${hubKey}/v1internal:generateContent`, {
          method: "POST",
          headers: {
            "user-agent": agyAgent,
            authorization: "Bearer client-tok",
            "content-type": "application/json",
            "content-encoding": encoding,
          },
          body,
        });
        const res = await handleAgyPassthrough(req, { config, draining: false });
        expect(res.status).toBe(200);
        await res.text();
      }
    } finally {
      await upstream.stop(true);
    }
  });

  test("readBoundedRequestBytes fast-rejects oversized content-length and handles single-chunk payloads", async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true;
      },
    });
    const oversizedReq = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-length": "2048" },
      body: stream,
    });
    expect(await readBoundedRequestBytes(oversizedReq, 1024)).toBeNull();
    expect(pulled).toBe(false);

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const singleReq = new Request("http://localhost/test", {
      method: "POST",
      body: payload,
    });
    const read = await readBoundedRequestBytes(singleReq, 1024);
    expect(read).toEqual(payload);
  });

  test("describeUpstreamTransportError redacts tokens and query strings, caps length, and preserves cause codes", () => {
    const cause = Object.assign(new Error("socket failed"), { code: "ECONNRESET", syscall: "read" });
    const wrapped = new Error(
      "POST https://cloudcode-pa.googleapis.com/v1internal:stream?alt=sse&key=secret-qp   failed with\n\tBearer synthetic-bearer-tok and Basic synthetic-basic-tok",
      { cause },
    );
    const described = describeUpstreamTransportError(wrapped);
    expect(described.code).toBe("ECONNRESET");
    expect(described.syscall).toBe("read");
    expect(described.message).toContain("https://cloudcode-pa.googleapis.com/v1internal:stream");
    expect(described.message).not.toContain("secret-qp");
    expect(described.message).not.toContain("synthetic-bearer-tok");
    expect(described.message).not.toContain("synthetic-basic-tok");
    expect(described.message).toContain("[REDACTED]");
    expect(described.message).not.toMatch(/\s{2,}/);

    const longDesc = describeUpstreamTransportError(new Error("x".repeat(320)));
    expect(longDesc.message).toHaveLength(200);
  });

  test("handleAgyPassthrough logs body-phase upstream failure when stream closes prematurely mid-response", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "transfer-encoding": "chunked" });
      res.write('data: {"partial":true}\n\n');
      setTimeout(() => res.socket?.destroy(), 15);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const config: OcxConfig = {
      port: 0,
      defaultProvider: "google-antigravity",
      apiKeys: [{ id: "k1", key: hubKey }],
      nativeHarnessOnly: true,
      providers: {
        "google-antigravity": { adapter: "google", authMode: "oauth", baseUrl: `http://127.0.0.1:${port}` },
      },
    };
    saveConfig(config);
    bindNativeHarnessConfig(config);

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const req = new Request(`http://localhost/agy/${hubKey}/v1internal:streamGenerateContent`, {
        method: "POST",
        headers: {
          "user-agent": agyAgent,
          authorization: "Bearer client-body-fail-secret",
          "content-type": "application/json",
        },
        body: '{"project":"proj-shared"}',
      });
      const res = await handleAgyPassthrough(req, { config, draining: false });
      expect(res.status).toBe(200);
      await expect(res.text()).rejects.toThrow();

      const bodyWarn = warnSpy.mock.calls.find(call => {
        if (!String(call[0]).includes("upstream failure")) return false;
        const fields = call[1] as { phase?: string } | undefined;
        return fields?.phase === "body";
      });
      expect(bodyWarn).toBeDefined();
      const fields = bodyWarn![1] as {
        phase?: unknown;
        code?: unknown;
        syscall?: unknown;
        message?: unknown;
        elapsedMs?: unknown;
        reusedSocket?: unknown;
        cancelled?: unknown;
        draining?: unknown;
      };
      expect(fields.phase).toBe("body");
      expect("code" in fields).toBe(true);
      expect("syscall" in fields).toBe(true);
      expect(typeof fields.message).toBe("string");
      expect((fields.message as string).length).toBeGreaterThan(0);
      expect(typeof fields.elapsedMs).toBe("number");
      expect("reusedSocket" in fields).toBe(true);
      expect(fields.cancelled).toBe(false);
      expect(fields.draining).toBe(false);
      const serialized = JSON.stringify(bodyWarn);
      expect(serialized).not.toContain("synthetic-a-access");
      expect(serialized).not.toContain("client-body-fail-secret");
    } finally {
      warnSpy.mockRestore();
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
