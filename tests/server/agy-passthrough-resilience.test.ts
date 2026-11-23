import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
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
import {
  AgyUpstreamSendError,
  createSettledPassthroughBody,
  DEFAULT_AGY_CONNECT_TIMEOUT_MS,
  DEFAULT_AGY_HEADER_TIMEOUT_MS,
  describeUpstreamTransportError,
  sendExactly,
  setAgyIdleSocketTimeoutMsForTests,
} from "../../src/server/agy-passthrough-send";

type UpstreamFailureLogFields = {
  method?: unknown;
  rpcPath?: unknown;
  account?: unknown;
  phase?: unknown;
  code?: unknown;
  syscall?: unknown;
  message?: unknown;
  elapsedMs?: unknown;
  reusedSocket?: unknown;
  cancelled?: unknown;
  draining?: unknown;
};

function parseUpstreamFailureWarn(call: unknown[]): UpstreamFailureLogFields | undefined {
  const line = String(call[0] ?? "");
  const marker = "[agy-passthrough] upstream failure ";
  if (!line.startsWith(marker)) return undefined;
  return JSON.parse(line.slice(marker.length)) as UpstreamFailureLogFields;
}
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
    setAgyIdleSocketTimeoutMsForTests(undefined);
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
      const failureCall = warnSpy.mock.calls.find(call => String(call[0]).includes("[agy-passthrough] upstream failure "));
      expect(failureCall).toBeDefined();
      expect(failureCall).toHaveLength(1);
      const detail = parseUpstreamFailureWarn(failureCall!)!;
      expect(detail.code).toBe("ECONNREFUSED");
      expect(detail.syscall).toBe("connect");
      expect(typeof detail.message).toBe("string");
      expect((detail.message as string).length).toBeGreaterThan(0);
      expect(typeof detail.elapsedMs).toBe("number");
      expect("reusedSocket" in detail).toBe(true);
      const serialized = String(failureCall![0]);
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

  test("describeUpstreamTransportError redacts tokens, userinfo, headers, and queries safely across cause chains", () => {
    const rootCause = Object.assign(new Error("socket failed"), { code: "ECONNRESET", syscall: "read" });
    const midCause = new Error("relay hop", { cause: rootCause });
    const wrapped = new Error(
      [
        "POST https://synthetic-user:synthetic-urlsecret@upstream.test/v1internal:stream?alt=sse&a=\"1\"&key=secret-qp#frag=topsecret",
        "failed\n\tx-goog-api-key: gsec-123\x1b[31m Bearer synthetic-bearer-tok",
        "Bearer%20enc-bearer Basic:colon-basic devin-session-token$devin12345678",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.sigpart123",
      ].join("   "),
      { cause: midCause },
    );
    const described = describeUpstreamTransportError(wrapped);
    expect(described.code).toBe("ECONNRESET");
    expect(described.syscall).toBe("read");
    expect(described.message).toContain("https://");
    expect(described.message).toContain("/v1internal:stream");
    for (const secret of [
      "synthetic-urlsecret",
      "secret-qp",
      "topsecret",
      "gsec-123",
      "synthetic-bearer-tok",
      "enc-bearer",
      "colon-basic",
      "devin12345678",
      "sigpart123",
    ]) {
      expect(described.message).not.toContain(secret);
    }
    expect(described.message).not.toContain("\x1b");
    expect(described.message).toContain("[REDACTED]");
    expect(described.message).not.toMatch(/\s{2,}/);

    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { code: undefined, syscall: "" });
    const safeNull = describeUpstreamTransportError(nullProto);
    expect(safeNull.code).toBeNull();
    expect(safeNull.syscall).toBeNull();
    expect(safeNull.message).toBe("[unprintable error]");

    const longDesc = describeUpstreamTransportError(new Error("x".repeat(320)));
    expect(longDesc.message).toHaveLength(200);
  });

  test("createSettledPassthroughBody ignores late pull EOF/error after cancel and protects settle when onError throws", async () => {
    let settleCalls: Array<number | "complete"> = [];
    let abortCalls = 0;
    let onErrorCalls = 0;
    const lateEofSource = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
    });
    const lateEofBody = createSettledPassthroughBody({
      source: lateEofSource,
      settle: status => { settleCalls.push(status); },
      abort: () => { abortCalls += 1; },
      isAborted: () => false,
      onError: () => { onErrorCalls += 1; },
    });
    const eofReader = lateEofBody.getReader();
    const pendingEofPull = eofReader.read();
    await Promise.resolve();
    await eofReader.cancel("client closed");
    expect((await pendingEofPull).done).toBe(true);
    expect(settleCalls).toEqual([499]);
    expect(abortCalls).toBe(1);
    expect(onErrorCalls).toBe(0);

    // Late rejection triggered while abort tears down upstream socket after cancel must also ignore onError.
    settleCalls = [];
    abortCalls = 0;
    onErrorCalls = 0;
    let rejectPendingRead: ((err: Error) => void) | undefined;
    const fakeAbortSource = {
      getReader: () => ({
        read: () => new Promise<ReadableStreamReadResult<Uint8Array>>((_res, rej) => { rejectPendingRead = rej; }),
        cancel: () => Promise.resolve(),
      }),
    } as unknown as ReadableStream<Uint8Array>;
    const abortErrBody = createSettledPassthroughBody({
      source: fakeAbortSource,
      settle: status => { settleCalls.push(status); },
      abort: () => { abortCalls += 1; rejectPendingRead?.(new Error("aborted upstream")); },
      isAborted: () => true,
      onError: () => { onErrorCalls += 1; },
    });
    const abortReader = abortErrBody.getReader();
    const pendingAbortPull = abortReader.read();
    await Promise.resolve();
    expect(rejectPendingRead).toBeDefined();
    await abortReader.cancel("client aborted");
    await pendingAbortPull;
    expect(settleCalls).toEqual([499]);
    expect(abortCalls).toBe(1);
    expect(onErrorCalls).toBe(0);

    // Non-aborted upstream failure with throwing onError still settles 502 and errors the consumer.
    settleCalls = [];
    abortCalls = 0;
    const errSource = new ReadableStream<Uint8Array>({
      pull() {
        return Promise.reject(Object.assign(new Error("boom"), { code: "ECONNRESET", syscall: "read" }));
      },
    });
    const errBody = createSettledPassthroughBody({
      source: errSource,
      settle: status => { settleCalls.push(status); },
      abort: () => { abortCalls += 1; },
      isAborted: () => false,
      onError: () => { throw new Error("logger blew up"); },
    });
    await expect(errBody.getReader().read()).rejects.toThrow("boom");
    expect(settleCalls).toEqual([502]);
  });

  test("handleAgyPassthrough logs single-line body-phase failure on premature close and nothing on clean client cancel", async () => {
    const server = createServer((req, res) => {
      if (req.url?.includes("cancelCase=1")) {
        res.writeHead(200, { "content-type": "text/event-stream", "transfer-encoding": "chunked" });
        res.write('data: {"chunk":1}\n\n');
        return;
      }
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
      // 1. Clean consumer cancellation while streaming must emit zero upstream failure logs.
      const cancelReq = new Request(`http://localhost/agy/${hubKey}/v1internal:streamGenerateContent?cancelCase=1`, {
        method: "POST",
        headers: { "user-agent": agyAgent, authorization: "Bearer client-cancel-secret", "content-type": "application/json" },
        body: '{"project":"proj-shared"}',
      });
      const cancelRes = await handleAgyPassthrough(cancelReq, { config, draining: false });
      expect(cancelRes.status).toBe(200);
      const cancelReader = cancelRes.body!.getReader();
      await cancelReader.read();
      await cancelReader.cancel("user stopped");
      expect(warnSpy.mock.calls.filter(c => String(c[0]).includes("upstream failure"))).toHaveLength(0);

      // 2. Premature upstream TCP close logs single-line JSON body-phase failure without secrets.
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

      const bodyCall = warnSpy.mock.calls.find(call => parseUpstreamFailureWarn(call)?.phase === "body");
      expect(bodyCall).toBeDefined();
      expect(bodyCall).toHaveLength(1);
      const fields = parseUpstreamFailureWarn(bodyCall!)!;
      expect(fields.phase).toBe("body");
      expect("code" in fields).toBe(true);
      expect("syscall" in fields).toBe(true);
      expect(typeof fields.message).toBe("string");
      expect((fields.message as string).length).toBeGreaterThan(0);
      expect(typeof fields.elapsedMs).toBe("number");
      expect("reusedSocket" in fields).toBe(true);
      expect(fields.cancelled).toBe(false);
      expect(fields.draining).toBe(false);
      const serialized = String(bodyCall![0]);
      expect(serialized).not.toContain("synthetic-a-access");
      expect(serialized).not.toContain("client-body-fail-secret");
    } finally {
      warnSpy.mockRestore();
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("sendExactly separates connect/header timeouts from idle keep-alive socket eviction", async () => {
    expect(DEFAULT_AGY_CONNECT_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_AGY_HEADER_TIMEOUT_MS).toBe(200_000);

    // 1. Stalled TLS handshake triggers connect-phase timeout without waiting for the header deadline.
    const stalledTls = createNetServer(_socket => {
      // Accept TCP and hold without speaking TLS so handshake stalls in connect phase.
    });
    await new Promise<void>(resolve => stalledTls.listen(0, "127.0.0.1", resolve));
    const tlsPort = (stalledTls.address() as { port: number }).port;
    try {
      await expect(sendExactly(
        new URL(`https://127.0.0.1:${tlsPort}/v1internal:streamGenerateContent`),
        new Headers(),
        new Uint8Array(2),
        new AbortController().signal,
        2_000,
        40,
      )).rejects.toMatchObject({ name: "AgyUpstreamSendError", phase: "connect", code: "ETIMEDOUT" });
    } finally {
      stalledTls.close();
    }

    // 2. Slow active header responses survive beyond idle eviction, reused sockets do not accumulate
    //    timeout listeners, and idle pooled sockets expire cleanly once idle past the window.
    const seenDelayHeaders: number[] = [];
    const srv = createServer((req, res) => {
      const delay = Number(req.headers["x-delay"] ?? 0);
      seenDelayHeaders.push(delay);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      }, delay);
    });
    await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as { port: number }).port;
    setAgyIdleSocketTimeoutMsForTests(50);
    try {
      const target = new URL(`http://127.0.0.1:${port}/v1internal:generateContent`);
      // Warm keep-alive socket.
      const warm = await sendExactly(target, new Headers({ "x-delay": "0" }), new Uint8Array(2), new AbortController().signal, 2_000, 1_000);
      expect(warm.status).toBe(200);
      await new Response(warm.body).text();

      // Immediate reuse with header delay 150ms > 50ms idle window must succeed repeatedly without accumulating listeners.
      for (let i = 0; i < 4; i += 1) {
        const res = await sendExactly(
          target,
          new Headers({ "x-delay": i === 0 ? "150" : "5" }),
          new Uint8Array(2),
          new AbortController().signal,
          2_000,
          1_000,
        );
        expect(res.status).toBe(200);
        expect(res.reusedSocket).toBe(true);
        await new Response(res.body).text();
      }

      // Leaving the pooled socket idle longer than 50ms evicts it before the next request.
      await new Promise(resolve => setTimeout(resolve, 140));
      const afterIdle = await sendExactly(target, new Headers({ "x-delay": "5" }), new Uint8Array(2), new AbortController().signal, 2_000, 1_000);
      expect(afterIdle.status).toBe(200);
      expect(afterIdle.reusedSocket).toBe(false);
      await new Response(afterIdle.body).text();
      expect(seenDelayHeaders).toHaveLength(6);
    } finally {
      setAgyIdleSocketTimeoutMsForTests(undefined);
      srv.closeAllConnections?.();
      await new Promise<void>(resolve => srv.close(() => resolve()));
    }
  });
});
