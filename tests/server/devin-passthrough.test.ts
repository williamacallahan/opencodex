import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { saveCredential } from "../../src/oauth/store";
import { clearPoolRotationState } from "../../src/oauth/pool-kernel";
import { resetDevinAccountState, rewriteDevinProtoCredentials } from "../../src/server/devin-passthrough";
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

  test("rewrites Metadata.api_key and strips Metadata.user_jwt while preserving other fields", () => {
    const raw = buildSampleProto("sk-ws-placeholder", "stale.jwt.value");
    const rewritten = rewriteDevinProtoCredentials(raw, "devin-session-token$real.jwt.sig");
    const meta = extractMetadataStrings(rewritten);
    expect(meta.get(1)).toBe("devin-cli");
    expect(meta.get(3)).toBe("devin-session-token$real.jwt.sig");
    expect(meta.has(21)).toBe(false);
    const top = [...iterFields(rewritten)];
    expect(top.find(f => f.num === 2)?.value.toString()).toBe("prompt-body-intact");
    expect(top.find(f => f.num === 7)?.value).toBe(42n);
  });

  test("forwards unary application/proto with swapped Basic auth and Metadata.api_key", async () => {
    const body = buildSampleProto("sk-ws-opencodex-placeholder");
    const res = await fetch(`http://127.0.0.1:${proxy!.port}/devin/${hubKey}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        "connect-protocol-version": "1",
        authorization: "Basic sk-ws-opencodex-placeholder-sk-ws-opencodex-placeholder",
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/exa.seat_management_pb.SeatManagementService/GetUserStatus");
    expect(calls[0]!.headers.get("authorization")).toBe(
      "Basic devin-session-token$pool-one.jwt.sig-devin-session-token$pool-one.jwt.sig",
    );
    expect(extractMetadataStrings(calls[0]!.bytes).get(3)).toBe("devin-session-token$pool-one.jwt.sig");
  });

  test("rewrites gzipped application/connect+proto streaming frames and fails over after 429", async () => {
    const framed = frameConnectStream(buildSampleProto("sk-ws-opencodex-placeholder"), true);
    let attempt = 0;
    reply = () => {
      attempt++;
      if (attempt === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
      return new Response(frameConnectStream(Buffer.from([0x0a, 0x02, 0x6f, 0x6b]), false), {
        status: 200,
        headers: { "content-type": "application/connect+proto" },
      });
    };

    const url = `http://127.0.0.1:${proxy!.port}/devin/${hubKey}/exa.api_server_pb.ApiServerService/GetChatMessage`;
    const headers = {
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      authorization: "Basic sk-ws-opencodex-placeholder-sk-ws-opencodex-placeholder",
    };

    const first = await fetch(url, { method: "POST", headers, body: framed });
    expect(first.status).toBe(429);
    const second = await fetch(url, { method: "POST", headers, body: framed });
    expect(second.status).toBe(200);

    expect(calls).toHaveLength(2);
    const firstMeta = extractMetadataStrings(parseConnectFrames(calls[0]!.bytes)[0]!.payload);
    const secondMeta = extractMetadataStrings(parseConnectFrames(calls[1]!.bytes)[0]!.payload);
    expect(firstMeta.get(3)).toBe("devin-session-token$pool-one.jwt.sig");
    expect(secondMeta.get(3)).toBe("devin-session-token$pool-two.jwt.sig");
    expect(calls[1]!.headers.get("authorization")).toBe(
      "Basic devin-session-token$pool-two.jwt.sig-devin-session-token$pool-two.jwt.sig",
    );
  });

  test("preserves unauthenticated analytics RPCs without injecting Authorization and balances distinct callers", async () => {
    const analyticsBody = Buffer.concat([encodeMessage(1, encodeString(1, "evt")), encodeString(2, "payload")]);
    const analyticsRes = await fetch(
      `http://127.0.0.1:${proxy!.port}/devin/${hubKey}/exa.product_analytics_pb.ProductAnalyticsService/BatchRecordAnalyticsEvents`,
      { method: "POST", headers: { "content-type": "application/proto" }, body: analyticsBody },
    );
    expect(analyticsRes.status).toBe(200);
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    expect(calls[0]!.bytes.equals(analyticsBody)).toBe(true);

    const url = `http://127.0.0.1:${proxy!.port}/devin/${hubKey}/exa.seat_management_pb.SeatManagementService/GetUserStatus`;
    const body = buildSampleProto("sk-ws-opencodex-placeholder");
    const r1 = await fetch(url, { method: "POST", headers: { "content-type": "application/proto", authorization: "Basic host-a" }, body });
    const r2 = await fetch(url, { method: "POST", headers: { "content-type": "application/proto", authorization: "Basic host-b" }, body });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(extractMetadataStrings(calls[1]!.bytes).get(3)).not.toBe(extractMetadataStrings(calls[2]!.bytes).get(3));
  });

  test("rejects unauthorized key and invalid RPC paths before reaching upstream", async () => {
    const badKey = await fetch(`http://127.0.0.1:${proxy!.port}/devin/wrong-key/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
      method: "POST",
      headers: { "content-type": "application/proto" },
      body: buildSampleProto("sk-ws-placeholder"),
    });
    expect(badKey.status).toBe(401);

    const badPath = await fetch(`http://127.0.0.1:${proxy!.port}/devin/${hubKey}/etc/passwd`, {
      method: "POST",
      headers: { "content-type": "application/proto" },
      body: Buffer.alloc(0),
    });
    expect(badPath.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
