import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementPrincipal } from "../../src/server/management-auth";
import type { ManagementRequestIngress } from "../../src/server/management/context";
import { TELEMETRY_PREVIEW_HASH_PLACEHOLDER, readTelemetryInstallId, resetTelemetryInstallIdMemoForTests, telemetryIdPath } from "../../src/telemetry/install-id";
import { buildTelemetryStatusSnapshot } from "../../src/telemetry/routes";
import { resetTelemetryPreviewAggregateForTests, settleTelemetryPreviewBuildForTests, telemetryPreviewAggregate } from "../../src/telemetry/preview-aggregate";
import { aggregateTelemetryForDay } from "../../src/telemetry/aggregate";
import * as usageLedgerScanner from "../../src/usage/ledger-scanner";
import * as nodeFs from "node:fs";
import { latestCompletedUtcDay, readTelemetryState, recordPendingTelemetryDecision, runTelemetryTick } from "../../src/telemetry/scheduler";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("/api/telemetry management routes", () => {
  let home: string;
  let config: OcxConfig;
  const prevHome = process.env.OPENCODEX_HOME;
  const prevTelemetry = process.env.OCX_TELEMETRY;
  const prevDnt = process.env.DO_NOT_TRACK;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-telemetry-routes-"));
    process.env.OPENCODEX_HOME = home;
    delete process.env.OCX_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    resetTelemetryInstallIdMemoForTests();
    config = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
    } as OcxConfig;
    writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
  });

  afterEach(() => {
    resetTelemetryInstallIdMemoForTests();
    if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevHome;
    if (prevTelemetry === undefined) delete process.env.OCX_TELEMETRY;
    else process.env.OCX_TELEMETRY = prevTelemetry;
    if (prevDnt === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = prevDnt;
    removeTreeWithRetry(home);
  });

  async function call(
    method: string,
    pathname: string,
    options: {
      body?: unknown;
      principal?: ManagementPrincipal;
      ingress?: ManagementRequestIngress;
    } = {},
  ) {
    const url = new URL(`http://127.0.0.1:10100${pathname}`);
    const req = new Request(url, {
      method,
      headers: {
        host: "127.0.0.1:10100",
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const res = await handleManagementAPI(
      req,
      url,
      config,
      {},
      options.principal ?? "admin-token",
      undefined,
      options.ingress ?? { trustedLoopback: true },
    );
    expect(res).not.toBeNull();
    return {
      status: res!.status,
      body: (await res!.json()) as Record<string, unknown>,
    };
  }

  test("GET /api/telemetry answers pending instead of waiting for the day's scan, then serves the completed preview", async () => {
    resetTelemetryPreviewAggregateForTests();
    const pending = await call("GET", "/api/telemetry");
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ preview: null, previewStatus: "pending", previewEligible: false });
    await settleTelemetryPreviewBuildForTests();
    const res = await call("GET", "/api/telemetry");
    expect(res.status).toBe(200);
    expect(res.body.previewStatus).toBe("ready");
    const awaited = await buildTelemetryStatusSnapshot(config, { env: {}, configDir: home });
    // Every field but the per-send random batch id comes from the same rows.
    expect({ ...(res.body.preview as object), batchId: null }).toEqual({ ...JSON.parse(JSON.stringify(awaited.preview)), batchId: null });
    expect(res.body).toMatchObject({
      effective: false,
      reason: "awaiting-notice",
      decision: null,
      lastSentDay: null,
      previewEligible: false,
    });
    const preview = res.body.preview as { installDayHash: string; schemaVersion: number; day: string };
    expect(preview.schemaVersion).toBe(1);
    expect(preview.installDayHash).toBe(TELEMETRY_PREVIEW_HASH_PLACEHOLDER);
    expect(preview.day).toBe(latestCompletedUtcDay());
    expect(existsSync(telemetryIdPath(home))).toBe(false);
  });

  test("D10: GET /api/telemetry preview uses the oldest eligible unsent day and marks previewEligible=false when none is eligible", async () => {
    const now = Date.parse("2026-11-07T12:00:00.000Z");

    // 1. Consent given today (2026-11-07) or yesterday (2026-11-06) -> no completed day is strictly after consent day yet.
    const sameDaySnap = await buildTelemetryStatusSnapshot(
      {
        telemetry: {
          decision: "accepted",
          decidedAt: "2026-11-06T18:00:00.000Z",
          noticeShownAt: "2026-11-06T18:00:00.000Z",
        },
      },
      { now, env: {}, configDir: home },
    );
    expect(sameDaySnap.previewEligible).toBe(false);
    expect(sameDaySnap.preview?.day).toBe("2026-11-06");

    // 2. Consent given on 2026-11-04 -> eligible unsent days are 2026-11-05 and 2026-11-06;
    // preview shows 2026-11-05 (the exact day the scheduler will send next) with previewEligible=true.
    const eligibleConfig = {
      telemetry: {
        decision: "accepted" as const,
        decidedAt: "2026-11-04T18:00:00.000Z",
        noticeShownAt: "2026-11-04T18:00:00.000Z",
      },
    };
    const firstSnap = await buildTelemetryStatusSnapshot(eligibleConfig, { now, env: {}, configDir: home });
    expect(firstSnap.previewEligible).toBe(true);
    expect(firstSnap.preview?.day).toBe("2026-11-05");

    // Scheduler sends 2026-11-05; next preview moves to 2026-11-06 with previewEligible=true:
    const tick1 = await runTelemetryTick({
      configDir: home,
      config: eligibleConfig,
      env: {},
      now,
      fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 202 })) as unknown as typeof fetch,
    });
    expect(tick1).toMatchObject({ sent: true, day: "2026-11-05" });

    const secondSnap = await buildTelemetryStatusSnapshot(eligibleConfig, { now, env: {}, configDir: home });
    expect(secondSnap.previewEligible).toBe(true);
    expect(secondSnap.preview?.day).toBe("2026-11-06");

    // Scheduler sends 2026-11-06; now no eligible day remains, so previewEligible=false on 2026-11-06:
    const tick2 = await runTelemetryTick({
      configDir: home,
      config: eligibleConfig,
      env: {},
      now,
      fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 202 })) as unknown as typeof fetch,
    });
    expect(tick2).toMatchObject({ sent: true, day: "2026-11-06" });

    const thirdSnap = await buildTelemetryStatusSnapshot(eligibleConfig, { now, env: {}, configDir: home });
    expect(thirdSnap.previewEligible).toBe(false);
    expect(thirdSnap.preview?.day).toBe("2026-11-06");
  });

  test("PUT /api/telemetry refuses admin-token and remembered-admin sessions, and POST /api/telemetry/notice is removed (D13)", async () => {
    for (const [principal, guiSessionIssuance] of [
      ["admin-token", null],
      ["gui-session", "remembered-admin"],
    ] as const) {
      const putRes = await call("PUT", "/api/telemetry", {
        body: { decision: "accepted" },
        principal,
        ingress: { trustedLoopback: true, guiSessionIssuance },
      });
      expect(putRes.status).toBe(403);
      expect(putRes.body.code).toBe("agent_consent_required");
    }
    expect(config.telemetry).toBeUndefined();

    const noticeUrl = new URL("http://127.0.0.1:10100/api/telemetry/notice");
    const noticeReq = new Request(noticeUrl, {
      method: "POST",
      headers: { host: "127.0.0.1:10100" },
    });
    const noticeRes = await handleManagementAPI(
      noticeReq,
      noticeUrl,
      config,
      {},
      "gui-session",
      undefined,
      { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
    );
    expect(noticeRes).toBeNull();
  });

  test("PUT /api/telemetry accepts a human dashboard session and deletes telemetry-id.json on decline", async () => {
    const accepted = await call("PUT", "/api/telemetry", {
      body: { decision: "accepted" },
      principal: "gui-session",
      ingress: { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      ok: true,
      effective: true,
      reason: "accepted",
      decision: "accepted",
    });
    expect(config.telemetry?.decision).toBe("accepted");

    const tick = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: Date.now() + 2 * 86_400_000,
      fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 202 })) as unknown as typeof fetch,
    });
    expect(tick.sent).toBe(true);
    const rawInstallId = readTelemetryInstallId(home)!.installId;
    expect(existsSync(telemetryIdPath(home))).toBe(true);

    const declined = await call("PUT", "/api/telemetry", {
      body: { decision: "declined" },
      principal: "gui-session",
      ingress: { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
    });
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({
      ok: true,
      effective: false,
      reason: "declined",
      decision: "declined",
    });
    expect(existsSync(telemetryIdPath(home))).toBe(false);
    for (const entry of readdirSync(home)) {
      const full = join(home, entry);
      if (lstatSync(full).isFile()) {
        expect(readFileSync(full, "utf8")).not.toContain(rawInstallId);
      }
    }
  });

  test("PUT /api/telemetry on a fresh install holds the decision without creating config.json", async () => {
    // A first-run popup can be answered before any config.json exists (fresh desktop install).
    unlinkSync(join(home, "config.json"));
    config = { port: 10100, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;
    const declined = await call("PUT", "/api/telemetry", {
      body: { decision: "declined" },
      principal: "gui-session",
      ingress: { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
    });
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ ok: true, effective: false, decision: "declined" });
    expect(existsSync(join(home, "config.json"))).toBe(false);
    expect(readTelemetryState(home).pendingDecision?.decision).toBe("declined");
    // A later GET from a process that only sees the defaults still reports the held decline.
    config = { port: 10100, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;
    const status = await call("GET", "/api/telemetry");
    expect(status.body).toMatchObject({ effective: false, decision: "declined" });
  });

  test("a decline held before config.json exists survives a management request that creates config.json", async () => {
    // Fresh install: the dashboard popup accepts before any config.json exists ...
    unlinkSync(join(home, "config.json"));
    config = {
      port: 10100,
      logLevel: "info",
      defaultProvider: "fixture",
      providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example.test" } },
    } as unknown as OcxConfig;
    const accepted = await call("PUT", "/api/telemetry", {
      body: { decision: "accepted" },
      principal: "gui-session",
      ingress: { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
    });
    expect(accepted.status).toBe(200);
    // ... the held decision is not copied into the running proxy's config ...
    expect(config.telemetry).toBeUndefined();
    // ... then "ocx telemetry disable" replaces the held decision with a decline.
    recordPendingTelemetryDecision({ decision: "declined", decidedAt: "2026-11-08T12:00:00.000Z", noticeShownAt: "2026-11-08T12:00:00.000Z" }, home);
    // An admin-token request that creates config.json from the in-memory config.
    const created = await call("PUT", "/api/subagent-models", { body: { force: null } });
    expect(created.status).toBe(200);
    expect(existsSync(join(home, "config.json"))).toBe(true);
    expect((JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig).telemetry).toBeUndefined();
    const status = await call("GET", "/api/telemetry");
    expect(status.body).toMatchObject({ effective: false, decision: "declined" });
  });

  test("GET /api/telemetry reports a decision written to disk while the server's config is stale", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({
      ...config,
      telemetry: { decision: "declined", decidedAt: "2026-11-08T10:00:00.000Z", noticeShownAt: "2026-11-08T10:00:00.000Z" },
    }, null, 2) + "\n", "utf8");
    expect(config.telemetry).toBeUndefined();
    const status = await call("GET", "/api/telemetry");
    expect(status.body).toMatchObject({ effective: false, decision: "declined" });
  });
});

describe("telemetry preview builds", () => {
  const homes: string[] = [];
  const day = latestCompletedUtcDay();
  const at = Date.parse(`${day}T12:00:00.000Z`);
  const rows = (count: number) => Array.from({ length: count }, (_, index) => `${JSON.stringify({
    requestId: `r-${index}`, timestamp: at, provider: "openai", model: "gpt-5.5", status: 200, durationMs: 1,
    usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 5 },
  })}\n`).join("");
  const home = (ledger: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-telemetry-preview-"));
    homes.push(dir);
    if (ledger !== null) writeFileSync(join(dir, "usage.jsonl"), ledger);
    return dir;
  };
  const requests = (result: ReturnType<typeof telemetryPreviewAggregate>) =>
    result.status === "ready" ? JSON.stringify(result.aggregate) : result.status;
  const oracle = async (dir: string) => {
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try { return JSON.stringify(await aggregateTelemetryForDay(day)); } finally { process.env.OPENCODEX_HOME = previous; }
  };
  let scans: ReturnType<typeof spyOn>;
  let reads: ReturnType<typeof spyOn>;
  let bytesRead = 0;

  beforeEach(() => {
    resetTelemetryPreviewAggregateForTests();
    const originalScan = usageLedgerScanner.scanUsageLedgerCooperatively;
    scans = spyOn(usageLedgerScanner, "scanUsageLedgerCooperatively").mockImplementation(options => originalScan(options));
    const realReadSync = nodeFs.readSync;
    bytesRead = 0;
    reads = spyOn(nodeFs, "readSync").mockImplementation(((...args: Parameters<typeof nodeFs.readSync>) => {
      const read = realReadSync(...args);
      bytesRead += read;
      return read;
    }) as typeof nodeFs.readSync);
  });

  afterEach(async () => {
    await settleTelemetryPreviewBuildForTests();
    scans.mockRestore();
    reads.mockRestore();
    resetTelemetryPreviewAggregateForTests();
    for (const dir of homes.splice(0)) removeTreeWithRetry(dir);
  });

  test("a cold request reads no ledger byte on its own turn, and the completed build equals a full read", async () => {
    const dir = home(rows(50));
    expect(telemetryPreviewAggregate(day, dir).status).toBe("pending");
    expect(bytesRead).toBe(0);
    await settleTelemetryPreviewBuildForTests();
    // Positive control for the counter: the background build read the whole file.
    expect(bytesRead).toBe(statSync(join(dir, "usage.jsonl")).size);
    bytesRead = 0;
    expect(requests(telemetryPreviewAggregate(day, dir))).toBe(await oracle(dir));
    expect(telemetryPreviewAggregate(day, dir, Date.now() + 11 * 60_000).status).toBe("ready");
  });

  test("two consumers alternating between keys keep both answers, and a third waits while both build", async () => {
    const dir = home(rows(5));
    const other = home(rows(3));
    telemetryPreviewAggregate(day, dir);
    telemetryPreviewAggregate(day, other);
    expect(telemetryPreviewAggregate(day, home(rows(1))).status).toBe("pending");
    await settleTelemetryPreviewBuildForTests();
    expect(scans).toHaveBeenCalledTimes(2);
    expect(requests(telemetryPreviewAggregate(day, dir))).toBe(await oracle(dir));
    expect(requests(telemetryPreviewAggregate(day, other))).toBe(await oracle(other));
    expect(scans).toHaveBeenCalledTimes(4); // the two oracles; A/B/A started no third preview scan
  });

  test("each home is read from its own ledger, and a file rewritten in place is never served from its old rows", async () => {
    const dir = home(rows(40));
    const empty = home(null);
    telemetryPreviewAggregate(day, dir);
    telemetryPreviewAggregate(day, empty);
    await settleTelemetryPreviewBuildForTests();
    expect(requests(telemetryPreviewAggregate(day, empty))).toBe(await oracle(empty));
    expect(requests(telemetryPreviewAggregate(day, dir))).toBe(await oracle(dir));
    // Same inode, truncated to one row: the 40-row answer is dropped, not served as ready.
    nodeFs.truncateSync(join(dir, "usage.jsonl"), 0);
    nodeFs.appendFileSync(join(dir, "usage.jsonl"), rows(1));
    expect(telemetryPreviewAggregate(day, dir).status).toBe("pending");
    await settleTelemetryPreviewBuildForTests();
    expect(requests(telemetryPreviewAggregate(day, dir))).toBe(await oracle(dir));
  });

  test("an answer is dropped when the file shrinks below the size last observed, not the size the scan read", async () => {
    const dir = home(rows(1));
    const ledger = join(dir, "usage.jsonl");
    telemetryPreviewAggregate(day, dir);
    await settleTelemetryPreviewBuildForTests();
    expect(telemetryPreviewAggregate(day, dir).status).toBe("ready");
    nodeFs.appendFileSync(ledger, rows(2)); // observed growth: still the same answer, dated
    expect(telemetryPreviewAggregate(day, dir).status).toBe("ready");
    // Rewritten in place to two rows of another day: longer than the scan read, shorter than observed.
    const otherDay = rows(2).replaceAll(String(at), String(at - 3 * 86_400_000));
    nodeFs.truncateSync(ledger, 0);
    nodeFs.appendFileSync(ledger, otherDay);
    expect(telemetryPreviewAggregate(day, dir).status).toBe("pending");
    await settleTelemetryPreviewBuildForTests();
    expect(requests(telemetryPreviewAggregate(day, dir))).toBe(await oracle(dir));
  });

  test("a scan that opened before observed growth never pulls the observation back", async () => {
    const dir = home(rows(1));
    const ledger = join(dir, "usage.jsonl");
    scans.mockRestore();
    const originalScan = usageLedgerScanner.scanUsageLedgerCooperatively;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // The scan reads the one-row file at once and completes only after the growth below is observed.
    scans = spyOn(usageLedgerScanner, "scanUsageLedgerCooperatively").mockImplementation(async options => {
      const result = await originalScan(options);
      await gate;
      return result;
    });
    telemetryPreviewAggregate(day, dir);
    await Bun.sleep(20);
    nodeFs.appendFileSync(ledger, rows(2));
    expect(telemetryPreviewAggregate(day, dir).status).toBe("pending"); // observes three rows
    release();
    await settleTelemetryPreviewBuildForTests();
    // Rewritten to two rows of another day: more than the scan read, less than observed.
    const otherDay = rows(2).replaceAll(String(at), String(at - 3 * 86_400_000));
    nodeFs.truncateSync(ledger, 0);
    nodeFs.appendFileSync(ledger, otherDay);
    expect(telemetryPreviewAggregate(day, dir).status).toBe("pending");
    await settleTelemetryPreviewBuildForTests();
    expect(requests(telemetryPreviewAggregate(day, dir))).toBe(await oracle(dir));
  });
});
