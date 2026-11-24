import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFinalRequestLog } from "../../src/server";
import { admissionFields, markDashboardProxyPeer, resolveResponsesApiAuth } from "../../src/server/auth-cors";
import { clearRequestLogsForTests, getRequestLogEntries, hydrateRequestLogsFromDisk } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { normalizeUsageEntryForTest, readUsageEntries, resetUsageReadCacheForTests } from "../../src/usage/log";
import { log } from "../helpers/request-log-entry";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const loopbackConfig: OcxConfig = { port: 0, hostname: "127.0.0.1", defaultProvider: "test", providers: {} };
const previousHome = process.env.OPENCODEX_HOME;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-attribution-"));
  process.env.OPENCODEX_HOME = home;
  clearRequestLogsForTests();
});

afterEach(() => {
  clearRequestLogsForTests();
  resetUsageReadCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function admittedRow(headers: Record<string, string>, peer: string | undefined) {
  const req = new Request("http://127.0.0.1:10100/v1/responses", { method: "POST", headers });
  markDashboardProxyPeer(req, peer);
  const admission = resolveResponsesApiAuth(req, loopbackConfig);
  if (!admission) throw new Error("loopback admission refused");
  addFinalRequestLog("attribution-row", 1, { model: "gpt-test", provider: "mock", ...admissionFields(admission) }, 200, { closeReason: "non_stream" });
  return { persisted: readUsageEntries()[0], live: getRequestLogEntries()[0] };
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
      "x-user-id": "someone-else:chosen",
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
