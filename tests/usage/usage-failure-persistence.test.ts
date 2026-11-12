import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFinalRequestLog, addRequestLog, beginRequestAttempt, clearRequestLogsForTests, hydrateRequestLogsFromDisk, noteAttemptSend, requestLogEntryFromPersistedUsage, type RequestLogContext } from "../../src/server/request-log";
import { appendUsageEntry, readUsageEntries, usageLogPath } from "../../src/usage/log";
import { abortAndReleaseAllTurns, registerTurn, tryAdmitTurn } from "../../src/server/lifecycle";
import { ServerShutdownError } from "../../src/lib/abort";
import { classifyRequestOutcome } from "../../src/usage/request-outcome";
import { resendPermission } from "../../src/lib/request-failure-model";
import { closeRequestHistoryIndex, queryRequestHistory } from "../../src/routing/history/indexer";
import { handleManagementAPI } from "../../src/server/management-api";
import { OutboundCredentialRegistry, setOutboundCredentialRegistryForTests } from "../../src/lib/outbound-credential-registry";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-usage-fail-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  closeRequestHistoryIndex();
  clearRequestLogsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

function lastPersistedLine(): Record<string, unknown> {
  const lines = readFileSync(usageLogPath(), "utf-8").trim().split("\n");
  return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
}

test("5xx entry persists failure diagnostics to usage.jsonl (survives the ring buffer)", () => {
  addRequestLog({
    requestId: "ocx-test-502",
    timestamp: Date.now(),
    model: "gpt-test",
    provider: "openai",
    status: 502,
    durationMs: 191_677,
    usageStatus: "unreported",
    errorCode: "upstream_server_error",
    terminalStatus: "failed",
    closeReason: "terminal",
    upstreamError: "An error occurred while processing your request. request ID test-42",
  });
  const row = lastPersistedLine();
  expect(row.status).toBe(502);
  expect(row.errorCode).toBe("upstream_server_error");
  expect(row.terminalStatus).toBe("failed");
  expect(row.closeReason).toBe("terminal");
  // The persisted row keeps the classified condition, never the provider's words.
  expect(row.upstreamError).toBeUndefined();
  expect(row.upstreamCondition).toBe("upstream_failed");
  expect(JSON.stringify(row)).not.toContain("test-42");
});

test("successful entry keeps the existing persisted shape (no diagnostic fields)", () => {
  addRequestLog({
    requestId: "ocx-test-200",
    timestamp: Date.now(),
    model: "gpt-test",
    provider: "openai",
    status: 200,
    durationMs: 1234,
    usageStatus: "reported",
    terminalStatus: "completed",
    closeReason: "terminal",
    usage: { inputTokens: 10, outputTokens: 2 },
  });
  const row = lastPersistedLine();
  expect(row.status).toBe(200);
  expect(row.errorCode).toBeUndefined();
  expect(row.terminalStatus).toBeUndefined();
  expect(row.closeReason).toBeUndefined();
  expect(row.upstreamError).toBeUndefined();
});

test.each(["responses", "chat", "messages"] as const)("%s caller identity and safe diagnostics survive the disk roundtrip", inboundProtocol => {
  addRequestLog({
    requestId: "roundtrip", timestamp: Date.now(), provider: "fixture", model: "fixture",
    status: 503, durationMs: 1, usageStatus: "unreported",
    apiKeyId: "configured-key-id", admissionKind: "configured", inboundProtocol,
    localTerminalReason: "fixture-local-answer",
    upstreamRequestId: "req_safe123", upstreamErrorCode: "server_error", upstreamErrorType: "server_error",
  });
  const persisted = readUsageEntries().at(-1)!;
  const restored = requestLogEntryFromPersistedUsage(persisted);
  for (const row of [persisted, restored]) {
    expect(row.apiKeyId).toBe("configured-key-id");
    expect(row.admissionKind).toBe("configured");
    expect(row.inboundProtocol).toBe(inboundProtocol);
    expect(row.localTerminalReason).toBe("fixture-local-answer");
    expect(row.upstreamRequestId).toBe("req_safe123");
    expect(row.upstreamErrorCode).toBe("server_error");
    expect(row.upstreamErrorType).toBe("server_error");
  }
});

test("unsafe diagnostic tokens are rejected at append and historical readback; old rows stay readable", () => {
  const old = { requestId: "old", timestamp: 1, provider: "fixture", model: "fixture",
    status: 502, durationMs: 1, usageStatus: "unreported" as const };
  const unsafe = { ...old, upstreamRequestId: "not a safe token", upstreamErrorCode: "sk-" + "fixture".repeat(6),
    upstreamErrorType: "unrecognized_type" };
  appendUsageEntry(unsafe);
  for (const row of [readUsageEntries().at(-1)!, requestLogEntryFromPersistedUsage(unsafe)]) {
    expect(row.upstreamRequestId).toBeUndefined();
    expect(row.upstreamErrorCode).toBeUndefined();
    expect(row.upstreamErrorType).toBeUndefined();
  }
  expect(requestLogEntryFromPersistedUsage(old).status).toBe(502);
});

test.each([false, true])("shutdown persists a local failure, never caller cancellation or resend permission (output: %s)", output => {
  const attempt = beginRequestAttempt(1, "fixture", "fixture", "openai-responses");
  noteAttemptSend(attempt, undefined);
  const logCtx: RequestLogContext = { model: "fixture", provider: "fixture",
    activeAttempt: attempt, attempts: [attempt], ...(output ? { firstOutputMs: 1 } : {}) };
  const controller = new AbortController();
  const lease = tryAdmitTurn(undefined, undefined, logCtx)!;
  registerTurn(controller, lease);
  controller.signal.addEventListener("abort", () => {
    expect(controller.signal.reason).toBeInstanceOf(ServerShutdownError);
    addFinalRequestLog("shutdown", Date.now(), logCtx, 499, { closeReason: "client_cancel" });
  }, { once: true });
  abortAndReleaseAllTurns();
  const restored = requestLogEntryFromPersistedUsage(readUsageEntries().at(-1)!);
  expect(restored.status).toBe(503);
  expect(restored.errorCode).toBe("server_shutdown");
  expect(restored.failureCause).toBe("transport-ambiguous");
  expect(restored.attempts?.[0]?.streamAborted).toBe(true);
  expect(restored.attempts?.[0]?.sendCount).toBe(1);
  expect(classifyRequestOutcome(restored)).toBe("failed");
  expect(resendPermission(restored.failureStage!, restored.failureCause!)).toBe(output ? "refused-committed" : "refused-ambiguous");
});

test("client cancellation wins before a later shutdown and remains 499", () => {
  const logCtx: RequestLogContext = { model: "fixture", provider: "fixture" };
  const client = new AbortController();
  const controller = new AbortController();
  const lease = tryAdmitTurn(undefined, client.signal, logCtx)!;
  registerTurn(controller, lease);
  controller.signal.addEventListener("abort", () => addFinalRequestLog("cancel", Date.now(), logCtx, 499));
  client.abort();
  abortAndReleaseAllTurns();
  const restored = requestLogEntryFromPersistedUsage(readUsageEntries().at(-1)!);
  expect(restored.status).toBe(499);
  expect(restored.errorCode).not.toBe("server_shutdown");
  expect(restored.failureCause).toBe("client-cancelled");
});

test.each([200, 429])("a genuine terminal already received keeps its status and code through shutdown (%s)", status => {
  const logCtx: RequestLogContext = { model: "fixture", provider: "fixture", terminalSource: "upstream",
    ...(status === 429 ? { errorCode: "rate_limit_exceeded", upstreamErrorCode: "rate_limit_exceeded" } : {}) };
  const controller = new AbortController();
  const lease = tryAdmitTurn(undefined, undefined, logCtx)!;
  registerTurn(controller, lease);
  abortAndReleaseAllTurns();
  addFinalRequestLog("terminal-race", Date.now(), logCtx, status, { terminalStatus: status === 200 ? "completed" : "failed", closeReason: "terminal" });
  const restored = requestLogEntryFromPersistedUsage(readUsageEntries().at(-1)!);
  expect(restored.status).toBe(status);
  expect(restored.errorCode).toBe(status === 429 ? "rate_limit_exceeded" : undefined);
  expect(restored.upstreamErrorCode).toBe(status === 429 ? "rate_limit_exceeded" : undefined);
  expect(classifyRequestOutcome(restored)).toBe(status === 200 ? "completed" : "failed");
});

test("bulk history checks credential stores once per read and rechecks changed credentials on the next read", async () => {
  const configPath = join(testDir, "config.json");
  const diagnostic = "safe_token_omega";
  writeFileSync(configPath, JSON.stringify({ providers: { fixture: { apiKey: "safe_token_alpha" } } }));
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    requestId: `bulk-${index}`, timestamp: index, provider: "fixture", model: "fixture", status: 503,
    durationMs: 1, usageStatus: "unreported", upstreamRequestId: diagnostic,
  }));
  writeFileSync(usageLogPath(), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const reads = spyOn(fs, "readFileSync");
  try {
    const restored = readUsageEntries();
    expect(restored).toHaveLength(1000);
    expect(restored.every(row => row.upstreamRequestId === diagnostic)).toBe(true);
    const credentialReads = reads.mock.calls.filter(([path]) => path === configPath).length;
    expect(credentialReads).toBeGreaterThan(0);
    expect(credentialReads).toBeLessThanOrEqual(2);
  } finally {
    reads.mockRestore();
  }
  await queryRequestHistory({}, undefined, 100);
  const pageReads = spyOn(fs, "readFileSync");
  try {
    const page = await queryRequestHistory({}, undefined, 100);
    expect(page.rows).toHaveLength(100);
    expect(page.rows.every(row => row.upstreamRequestId === diagnostic)).toBe(true);
    const credentialReads = pageReads.mock.calls.filter(([path]) => path === configPath).length;
    expect(credentialReads).toBeGreaterThan(0);
    expect(credentialReads).toBeLessThanOrEqual(2);
  } finally {
    pageReads.mockRestore();
  }
  writeFileSync(configPath, JSON.stringify({ providers: { fixture: { apiKey: diagnostic } } }));
  expect(readUsageEntries().every(row => row.upstreamRequestId === undefined)).toBe(true);
  expect((await queryRequestHistory({}, undefined, 100)).rows.every(row => row.upstreamRequestId === undefined)).toBe(true);
  expect(requestLogEntryFromPersistedUsage({ ...rows[0]!, usageStatus: "unreported" }).upstreamRequestId).toBeUndefined();
});

test.each(["configured", "outbound"])("retained logs reject a diagnostic that becomes a %s credential after hydration", async source => {
  const diagnostic = "opaque_retained_token";
  const config: OcxConfig = { port: 10100, defaultProvider: "fixture", providers: {
    fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example/v1", apiKey: "different_opaque_token", models: ["fixture"] },
  } };
  const registry = new OutboundCredentialRegistry();
  const restoreRegistry = setOutboundCredentialRegistryForTests(registry);
  const readLogs = async () => {
    const req = new ManagementRequest("http://localhost/api/logs");
    const response = await handleManagementAPI(req, new URL(req.url), config);
    expect(response?.status).toBe(200);
    return await response!.json() as { logs: Array<{ requestId: string; upstreamRequestId?: string }> };
  };
  try {
    writeFileSync(join(testDir, "config.json"), JSON.stringify(config));
    appendUsageEntry({ requestId: "retained", timestamp: Date.now(), provider: "fixture", model: "fixture",
      status: 503, durationMs: 1, usageStatus: "unreported", upstreamRequestId: diagnostic });
    clearRequestLogsForTests();
    expect(hydrateRequestLogsFromDisk()).toBe(1);
    expect((await readLogs()).logs[0]?.upstreamRequestId).toBe(diagnostic);
    if (source === "configured") {
      config.providers.fixture!.apiKey = diagnostic;
      writeFileSync(join(testDir, "config.json"), JSON.stringify(config));
    } else {
      registry.remember({ Authorization: `Bearer ${diagnostic}` });
    }
    const published = (await readLogs()).logs;
    expect(published).toHaveLength(1);
    expect(published[0]?.requestId).toBe("retained");
    expect(published[0]).not.toHaveProperty("upstreamRequestId");
  } finally {
    restoreRegistry();
  }
});
