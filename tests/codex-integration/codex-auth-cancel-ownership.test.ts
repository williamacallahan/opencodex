import { describe, expect, spyOn, test } from "bun:test";
import { handleCodexAuthLoginCancel, handleCodexAuthLoginStart } from "../../src/codex/auth-api/login-flow";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { getCodexAccountCredential } from "../../src/codex/account-store";
import { getCredential, saveCredential } from "../../src/oauth/store";
import { waitForLoginSettled } from "../../src/oauth/login-flow-state";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";
import { codexAuthLoginState } from "../../src/codex/auth-api/login-state";
import { cancelLoginFlow, clearLoginState, getLoginStatus, OAUTH_PROVIDERS, startLoginFlow } from "../../src/oauth";

const OLD_ID = "cancel-ownership-old";
const NEW_ID = "cancel-ownership-new";
const TERMINAL_ID = "cancel-ownership-terminal";

function cancel(body: unknown): Promise<Response> {
  return handleCodexAuthLoginCancel(new Request("http://127.0.0.1/api/codex-auth/login/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("Codex OAuth cancel ownership", () => {
  test("a stale flow cannot abort or expire the active controller", async () => {
    const originalLogin = OAUTH_PROVIDERS.chatgpt.login;
    const signals: AbortSignal[] = [];
    OAUTH_PROVIDERS.chatgpt.login = async controller => {
      signals.push(controller.signal);
      controller.onAuth({ url: "about:blank" });
      return await new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("provider cancelled")), { once: true });
      });
    };

    try {
      await startLoginFlow("chatgpt", {}, { flowId: OLD_ID });
      codexAuthLoginState.set(OLD_ID, { status: "pending", startedAt: Date.now() });
      expect((await cancel({ flowId: OLD_ID })).status).toBe(200);
      expect(signals[0]?.aborted).toBe(true);
      expect(codexAuthLoginState.get(OLD_ID)?.status).toBe("error");

      await startLoginFlow("chatgpt", {}, { flowId: NEW_ID });
      codexAuthLoginState.set(NEW_ID, { status: "pending", startedAt: Date.now() });
      codexAuthLoginState.set(TERMINAL_ID, { status: "error", startedAt: Date.now(), doneAt: Date.now() });
      const active = signals[1];
      expect(active).toBeDefined();

      for (const body of [{}, { flowId: "" }, { flowId: "  " }, { flowId: 42 }, null, [],
        { flowId: "unknown-flow" }, { flowId: TERMINAL_ID }]) {
        expect((await cancel(body)).status).toBe(400);
        expect(active?.aborted).toBe(false);
        expect(codexAuthLoginState.get(NEW_ID)?.status).toBe("pending");
      }
      expect(codexAuthLoginState.has("unknown-flow")).toBe(false);
      expect(codexAuthLoginState.get(TERMINAL_ID)?.status).toBe("error");

      // A stale row can still say pending after its controller was replaced.
      codexAuthLoginState.set(OLD_ID, { status: "pending", startedAt: Date.now() });
      expect((await cancel({ flowId: OLD_ID })).status).toBe(400);
      expect(codexAuthLoginState.get(OLD_ID)?.status).toBe("pending");
      expect(active?.aborted).toBe(false);
      expect(getLoginStatus("chatgpt").done).toBe(false);

      const response = await cancel({ flowId: NEW_ID });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, cancelled: true });
      expect(active?.aborted).toBe(true);
      expect(codexAuthLoginState.get(NEW_ID)?.status).toBe("error");
      expect(codexAuthLoginState.get(OLD_ID)?.status).toBe("pending");

      await startLoginFlow("chatgpt");
      expect(cancelLoginFlow("chatgpt")).toBe(true);
      expect(signals[2]?.aborted).toBe(true);
    } finally {
      OAUTH_PROVIDERS.chatgpt.login = originalLogin;
      clearLoginState("chatgpt");
      codexAuthLoginState.delete(OLD_ID);
      codexAuthLoginState.delete(NEW_ID);
      codexAuthLoginState.delete(TERMINAL_ID);
    }
  });

  test("a 409 names the blocking flow so a caller that lost its flowId can cancel and retry", async () => {
    const originalLogin = OAUTH_PROVIDERS.chatgpt.login;
    OAUTH_PROVIDERS.chatgpt.login = async controller => {
      controller.onAuth({ url: "about:blank" });
      return await new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("provider cancelled")), { once: true });
      });
    };
    const config: OcxConfig = { port: 10100, providers: {}, defaultProvider: "openai", codexAccounts: [] };
    const start = () => handleCodexAuthLoginStart(new Request("http://127.0.0.1/api/codex-auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openBrowser: false }),
    }), config);
    const flowIds: string[] = [];

    try {
      const abandoned = await start();
      expect(abandoned.status).toBe(200);
      const abandonedFlowId = (await abandoned.json() as { flowId: string }).flowId;
      flowIds.push(abandonedFlowId);

      const blocked = await start();
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ status: "pending", flowId: abandonedFlowId });

      expect((await cancel({ flowId: abandonedFlowId })).status).toBe(200);
      const retried = await start();
      expect(retried.status).toBe(200);
      const retriedFlowId = (await retried.json() as { flowId: string }).flowId;
      flowIds.push(retriedFlowId);
      expect(retriedFlowId).not.toBe(abandonedFlowId);
      expect((await cancel({ flowId: retriedFlowId })).status).toBe(200);
    } finally {
      OAUTH_PROVIDERS.chatgpt.login = originalLogin;
      clearLoginState("chatgpt");
      for (const flowId of flowIds) codexAuthLoginState.delete(flowId);
    }
  });
});

test.each([false, true])("Codex completion binds A's receipt and refuses replacement by B: %s", async replaced => {
  const home = mkdtempSync(join(tmpdir(), "ocx-flow-receipt-"));
  const previousHome = process.env.OPENCODEX_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const originalLogin = OAUTH_PROVIDERS.chatgpt.login;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let poll: (() => void) | undefined;
  // Hold the actual completion poll until both durable writes have finished.
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]
  ) => {
    if (delay === 2000) {
      poll = () => callback(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  let flowId: string | undefined;
  const usageHeaders: Headers[] = [];
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = join(home, "absent-native-home");
  const config: OcxConfig = { port: 10100, providers: {}, defaultProvider: "openai", codexAccounts: [] };
  const credentialA = { access: "fixture-access-a", refresh: "fixture-refresh-a",
    expires: Date.now() + 3600_000, email: "alice@example.test", accountId: "fixture-account-a" };
  OAUTH_PROVIDERS.chatgpt.login = async controller => {
    controller.onAuth({ url: "about:blank" });
    return credentialA;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://chatgpt.com/backend-api/wham/usage") {
      usageHeaders.push(new Headers(init?.headers));
      // Exhaustion defers warmup: this regression must never send inference.
      return Response.json({ plan_type: "pro", rate_limit: {
        secondary_window: { used_percent: 100, limit_window_seconds: 604800 },
      } });
    }
    if (String(input).endsWith("/models")) return Response.json({ data: [] });
    throw new Error("Unexpected network request in flow-receipt regression");
  }) as typeof fetch;
  try {
    saveConfig(config);
    const response = await handleCodexAuthLoginStart(new Request("http://localhost/api/codex-auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "receipt-pool", openBrowser: false }),
    }), config);
    expect(response.status).toBe(200);
    flowId = (await response.json() as { flowId: string }).flowId;
    expect(await waitForLoginSettled("chatgpt", 1000, flowId)).toBe(true);
    expect(getLoginStatus("chatgpt", false, flowId).status).toBe("complete");
    if (replaced) await saveCredential("chatgpt", { access: "fixture-access-b", refresh: "fixture-refresh-b",
      expires: Date.now() + 3600_000, email: "bob@example.test", accountId: "fixture-account-b" });
    expect(getCredential("chatgpt")?.accountId).toBe(replaced ? "fixture-account-b" : credentialA.accountId);
    expect(usageHeaders).toHaveLength(0);
    expect(poll).toBeDefined();
    poll!();
    const deadline = Date.now() + 6000;
    while (codexAuthLoginState.get(flowId)?.status === "pending" && Date.now() < deadline) await Bun.sleep(10);
    if (replaced) {
      // ChatGPT's canonical store is intentionally single-slot: B removes A.
      expect(codexAuthLoginState.get(flowId)).toMatchObject({
        status: "error", error: "OAuth account is no longer available. Please retry OAuth login.",
      });
      expect(getCodexAccountCredential("receipt-pool")).toBeNull();
      expect(usageHeaders).toHaveLength(0);
      return;
    }
    expect(codexAuthLoginState.get(flowId)).toMatchObject({ status: "done", email: "alice@example.test" });
    expect(getCodexAccountCredential("receipt-pool")).toMatchObject({
      accessToken: credentialA.access, refreshToken: credentialA.refresh, chatgptAccountId: credentialA.accountId,
    });
    expect(usageHeaders).toHaveLength(1);
    expect(usageHeaders[0]!.get("Authorization")).toBe(`Bearer ${credentialA.access}`);
    expect(usageHeaders[0]!.get("ChatGPT-Account-Id")).toBe(credentialA.accountId);
  } finally {
    if (flowId) codexAuthLoginState.delete(flowId);
    clearLoginState("chatgpt");
    OAUTH_PROVIDERS.chatgpt.login = originalLogin;
    globalThis.fetch = originalFetch;
    timerSpy.mockRestore();
    await flushConfigDirHardeningForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(home);
  }
}, 10_000);
