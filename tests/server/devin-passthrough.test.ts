import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getRequestLogEntries } from "../../src/server/request-log";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { saveConfig } from "../../src/config";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { listAccounts, saveCredential, setAccountPaused } from "../../src/oauth/store";
import { clearPoolRotationState } from "../../src/oauth/pool-kernel";
import {
  resetDevinAccountState,
  resolveDevinPassthroughBaseUrl,
  rewriteDevinProtoCredentials,
} from "../../src/server/devin-passthrough";
import { encodeMessage, encodeString, encodeVarintField, frameConnectStream, iterFields, parseConnectFrames } from "../../src/adapters/devin/cloud-direct/wire";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Captured = { path: string; headers: Headers; bytes: Buffer };
const hubKey = `ocx_data_${"d".repeat(40)}`;

function buildSampleProto(apiKey: string, userJwt?: string): Buffer {
  const metaParts = [
    encodeString(1, "devin-cli"),
    encodeString(2, "3000.14.30821"),
    encodeString(3, apiKey),
    encodeString(4, "en"),
  ];
  if (userJwt) metaParts.push(encodeString(21, userJwt));
  return Buffer.concat([
    encodeMessage(1, Buffer.concat(metaParts)),
    encodeString(2, "prompt-body-intact"),
    encodeVarintField(7, 42),
  ]);
}

function buildConnectEosFrame(payload: Record<string, unknown>): Buffer {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const hdr = Buffer.alloc(5);
  hdr[0] = 0x02;
  hdr.writeUInt32BE(raw.length, 1);
  return Buffer.concat([hdr, raw]);
}

function extractMetadataStrings(proto: Buffer): Map<number, string> {
  const result = new Map<number, string>();
  for (const field of iterFields(proto)) {
    if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      for (const mf of iterFields(field.value)) {
        if (mf.wire === 2 && Buffer.isBuffer(mf.value)) {
          result.set(mf.num, mf.value.toString("utf8"));
        }
      }
    }
  }
  return result;
}

describe("devin pass-through public HTTP lane", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedCodexHome: string | undefined;
  let savedApiToken: string | undefined;
  let release: (() => void) | undefined;
  let proxy: ReturnType<typeof import("../../src/server").startServer> | undefined;
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let calls: Captured[];
  let reply: (captured: Captured) => Response;

  beforeEach(async () => {
    savedHome = process.env.OPENCODEX_HOME;
    savedCodexHome = process.env.CODEX_HOME;
    savedApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
    home = mkdtempSync(join(tmpdir(), "ocx-devin-passthrough-"));
    process.env.OPENCODEX_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");
    process.env.OPENCODEX_API_AUTH_TOKEN = hubKey;
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    release = acquireOwnedSpendHome();
    calls = [];
    reply = () => new Response(Buffer.from([0x0a, 0x02, 0x6f, 0x6b]), {
      status: 200,
      headers: { "content-type": "application/proto" },
    });
    clearGenericFailoverHealth();
    clearPoolRotationState();
    resetDevinAccountState();

    await saveCredential("devin", {
      access: "devin-session-token$pool-one.jwt.sig",
      refresh: "devin-session-token$pool-one.jwt.sig",
      expires: Number.MAX_SAFE_INTEGER,
      accountId: "devin-one",
      email: "one@example.com",
    });
    await saveCredential("devin", {
      access: "devin-session-token$pool-two.jwt.sig",
      refresh: "devin-session-token$pool-two.jwt.sig",
      expires: Number.MAX_SAFE_INTEGER,
      accountId: "devin-two",
      email: "two@example.com",
    });

    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const captured = { path: url.pathname, headers: req.headers, bytes: Buffer.from(await req.arrayBuffer()) };
        calls.push(captured);
        return reply(captured);
      },
    });

    const config = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "devin",
      providers: {
        devin: { adapter: "devin", authMode: "oauth", baseUrl: upstream.url.origin, allowPrivateNetwork: true, liveModels: false },
      },
      clientIntegrations: { codex: false },
      checkForUpdates: false,
      syncResumeHistory: false,
    } as OcxConfig;
    saveConfig(config);
    proxy = (await import("../../src/server")).startServer(0);
  });

  afterEach(async () => {
    try {
      await proxy?.stop(true);
      proxy = undefined;
      await upstream?.stop(true);
      upstream = undefined;
      await drainAndRemoveFixtureRoots({ roots: [], restoreEnvironment() {} });
    } finally {
      clearGenericFailoverHealth();
      clearPoolRotationState();
      resetDevinAccountState();
      release?.();
      release = undefined;
      if (savedHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = savedHome;
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodexHome;
      if (savedApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = savedApiToken;
      removeTreeWithRetry(home);
    }
  });

  test("rewrites Metadata.api_key and strips Metadata.user_jwt across merged field-1 chunks and rejects malformed varints", () => {
    const merged = Buffer.concat([
      buildSampleProto("synthetic-placeholder-key"),
      encodeMessage(1, encodeString(21, "second-chunk-stale.jwt.value")),
    ]);
    const rewritten = rewriteDevinProtoCredentials(merged, "devin-session-token$real.jwt.sig");
    expect(rewritten).not.toBeNull();
    const meta = extractMetadataStrings(rewritten!);
    expect(meta.get(1)).toBe("devin-cli");
    expect(meta.get(3)).toBe("devin-session-token$real.jwt.sig");
    expect(meta.has(21)).toBe(false);
    const top = [...iterFields(rewritten!)];
    expect(top.find(f => f.num === 2)?.value.toString()).toBe("prompt-body-intact");
    expect(top.find(f => f.num === 7)?.value).toBe(42n);

    // Overlong varint (>10 bytes) must fail closed (null), not DoS.
    const overlongVarint = Buffer.alloc(64, 0x80);
    expect(rewriteDevinProtoCredentials(overlongVarint, "devin-session-token$real.jwt.sig")).toBeNull();
  });

  test("enforces Cognition host allowlist and preserves EU/FedStart tenant path prefixes", () => {
    const defaultCfg = { providers: { devin: { adapter: "devin", authMode: "oauth", baseUrl: "https://server.codeium.com" } } } as OcxConfig;
    expect(resolveDevinPassthroughBaseUrl(defaultCfg, "https://eu.windsurf.com/_route/api_server")).toBe(
      "https://eu.windsurf.com/_route/api_server",
    );
    expect(resolveDevinPassthroughBaseUrl(defaultCfg, "https://evil.example.com/steal")).toBe(
      "https://server.codeium.com",
    );
    expect(resolveDevinPassthroughBaseUrl(defaultCfg, "http://127.0.0.1:9999")).toBe(
      "https://server.codeium.com",
    );
  });

  test("forwards unary application/proto (including gzip) and strips sensitive headers", async () => {
    const body = gzipSync(buildSampleProto("synthetic-placeholder-key"));
    const res = await fetch(`http://127.0.0.1:${proxy!.port}/devin/${hubKey}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        "content-encoding": "gzip",
        "connect-protocol-version": "1",
        authorization: "Basic synthetic-placeholder-key-synthetic-placeholder-key",
        cookie: "session=secret",
        "x-api-key": "leaked",
        referer: `https://opencodex.haiku.host/devin/${hubKey}/secret`,
        "x-opencodex-api-key": hubKey,
        "x-user-id": "claude-oc:session-1", "x-lgw-cache-key": "claude-oc:conversation-1",
        "x-lgw-client-host": "laptop-1", "x-lgw-client-address": "192.0.2.66",
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/exa.seat_management_pb.SeatManagementService/GetUserStatus");
    expect(calls[0]!.headers.get("authorization")).toBe(
      "Basic devin-session-token$pool-one.jwt.sig-devin-session-token$pool-one.jwt.sig",
    );
    expect(calls[0]!.headers.get("cookie")).toBeNull();
    expect(calls[0]!.headers.get("x-api-key")).toBeNull();
    expect(calls[0]!.headers.get("referer")).toBeNull();
    expect(calls[0]!.headers.get("x-opencodex-api-key")).toBeNull();
    for (const name of ["x-user-id", "x-lgw-cache-key", "x-lgw-client-host", "x-lgw-client-address"]) expect(calls[0]!.headers.has(name)).toBe(false);
    const row = getRequestLogEntries().find(entry => entry.workload === "claude-oc:session-1");
    expect(row?.workload).toBe("claude-oc:session-1");
    expect(row?.clientHost).toBe("laptop-1");
  });

  test("fails over on HTTP 429 and on HTTP 200 Connect EOS resource_exhausted trailer", async () => {
    const framed = frameConnectStream(buildSampleProto("synthetic-placeholder-key"), true);
    let attempt = 0;
    reply = () => {
      attempt++;
      if (attempt === 1) {
        return new Response(
          Buffer.concat([
            frameConnectStream(Buffer.from([0x0a, 0x02, 0x6f, 0x6b]), false),
            buildConnectEosFrame({ error: { code: "resource_exhausted", message: "quota reached" } }),
          ]),
          { status: 200, headers: { "content-type": "application/connect+proto" } },
        );
      }
      return new Response(frameConnectStream(Buffer.from([0x0a, 0x02, 0x6f, 0x6b]), false), {
        status: 200,
        headers: { "content-type": "application/connect+proto" },
      });
    };

    const url = `http://127.0.0.1:${proxy!.port}/devin/${hubKey}/exa.api_server_pb.ApiServerService/GetChatMessage`;
    const headers = {
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      authorization: "Basic synthetic-placeholder-key-synthetic-placeholder-key",
    };

    const first = await fetch(url, { method: "POST", headers, body: framed });
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    await Bun.sleep(20);

    const second = await fetch(url, { method: "POST", headers, body: framed });
    expect(second.status).toBe(200);
    await second.arrayBuffer();

    expect(calls).toHaveLength(2);
    const firstMeta = extractMetadataStrings(parseConnectFrames(calls[0]!.bytes)[0]!.payload);
    const secondMeta = extractMetadataStrings(parseConnectFrames(calls[1]!.bytes)[0]!.payload);
    expect(firstMeta.get(3)).toBe("devin-session-token$pool-one.jwt.sig");
    expect(secondMeta.get(3)).toBe("devin-session-token$pool-two.jwt.sig");
  });

  test("never rewrites unauthenticated analytics payloads even with field-1/field-3 and balances distinct callers", async () => {
    const analyticsBody = Buffer.concat([encodeMessage(1, encodeString(3, "event-id-must-not-be-overwritten")), encodeString(2, "payload")]);
    const analyticsRes = await fetch(
      `http://127.0.0.1:${proxy!.port}/devin/${hubKey}/exa.product_analytics_pb.ProductAnalyticsService/BatchRecordAnalyticsEvents`,
      { method: "POST", headers: { "content-type": "application/proto" }, body: analyticsBody },
    );
    expect(analyticsRes.status).toBe(200);
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    expect(calls[0]!.bytes.equals(analyticsBody)).toBe(true);

    const url = `http://127.0.0.1:${proxy!.port}/devin/${hubKey}/exa.seat_management_pb.SeatManagementService/GetUserStatus`;
    const body = buildSampleProto("synthetic-placeholder-key");
    const r1 = await fetch(url, { method: "POST", headers: { "content-type": "application/proto", authorization: "Basic host-a" }, body });
    const r2 = await fetch(url, { method: "POST", headers: { "content-type": "application/proto", authorization: "Basic host-b" }, body });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(extractMetadataStrings(calls[1]!.bytes).get(3)).not.toBe(extractMetadataStrings(calls[2]!.bytes).get(3));
  });

  test("rejects browser Origin, unsupported content types, invalid paths, unauthorized keys, and paused pools", async () => {
    const base = `http://127.0.0.1:${proxy!.port}/devin/${hubKey}/exa.seat_management_pb.SeatManagementService/GetUserStatus`;
    const auth = "Basic synthetic-placeholder-key-synthetic-placeholder-key";

    const badKey = await fetch(`http://127.0.0.1:${proxy!.port}/devin/wrong-key/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
      method: "POST", headers: { "content-type": "application/proto", authorization: auth }, body: buildSampleProto("synthetic-placeholder-key"),
    });
    expect(badKey.status).toBe(401);

    const badPath = await fetch(`http://127.0.0.1:${proxy!.port}/devin/${hubKey}/etc/passwd`, {
      method: "POST", headers: { "content-type": "application/proto", authorization: auth }, body: Buffer.alloc(0),
    });
    expect(badPath.status).toBe(404);

    const browserReq = await fetch(base, {
      method: "POST", headers: { "content-type": "application/proto", origin: "https://evil.example", authorization: auth }, body: buildSampleProto("synthetic-placeholder-key"),
    });
    expect(browserReq.status).toBe(403);

    const badCt = await fetch(base, {
      method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: "{}",
    });
    expect(badCt.status).toBe(415);

    const badGrpcWeb = await fetch(base, {
      method: "POST", headers: { "content-type": "application/grpc-web+proto", authorization: auth }, body: Buffer.from([0, 0, 0, 0, 0]),
    });
    expect(badGrpcWeb.status).toBe(415);
    expect(calls).toHaveLength(0);

    // Pausing all accounts returns 503 (unavailable), not 429 (cooling down).
    for (const row of listAccounts("devin")) {
      await setAccountPaused("devin", row.id, true);
    }
    const pausedRes = await fetch(base, {
      method: "POST", headers: { "content-type": "application/proto", authorization: auth }, body: buildSampleProto("synthetic-placeholder-key"),
    });
    expect(pausedRes.status).toBe(503);
  });
});
