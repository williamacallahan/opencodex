import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as budgets from "../../src/lib/translator-budget";
import { clearResponseStateForTests, responseContinuationRetainedStoreSnapshot } from "../../src/responses/state";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import * as requestDecompress from "../../src/server/request-decompress";
import { clearRequestLogsForTests } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses/core";
import { registerTurn, unregisterTurn } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("in-memory preParsedBody handoff and budget parity", () => {
  let home: string;
  let savedHome: string | undefined;
  let releaseSpendHome: (() => void) | undefined;

  beforeEach(() => {
    savedHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-preparsed-budget-"));
    process.env.OPENCODEX_HOME = home;
    releaseSpendHome = acquireOwnedSpendHome();
    clearRequestLogsForTests();
    clearResponseStateForTests();
  });

  afterEach(() => {
    clearRequestLogsForTests();
    clearResponseStateForTests();
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = savedHome;
    removeTreeWithRetry(home);
  });

  test("POST /v1/messages hands body in-memory once, avoids non-Responses continuation state, and charges request_copies once", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const frames = [
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_claude_msg_1", status: "in_progress", output: [] } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_claude_msg_1",
              status: "completed",
              output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
              usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
            },
          })}\n\n`,
        ];
        return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const budget = budgets.createTranslatorBudget({ maxTurnBytes: 64 * 1024 });
    const charge = spyOn(budget, "chargeRetained");
    const factory = spyOn(budgets, "createTranslatorBudget").mockReturnValue(budget);
    const stringify = spyOn(JSON, "stringify");
    const config: OcxConfig = {
      port: 0,
      defaultProvider: "mock",
      providers: {
        mock: { adapter: "openai-responses", baseUrl: upstream.url.origin, apiKey: "k", allowPrivateNetwork: true },
      },
    };
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/gpt-test", max_tokens: 32, stream: false, messages: [{ role: "user", content: "hello" }] }),
    });
    const turnId = `preparsed-${crypto.randomUUID()}`;
    registerTurn(turnId);
    try {
      const response = await handleClaudeMessages(req, config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
      expect(charge.mock.calls.filter(([, scope]) => scope.kind === "request_copies")).toHaveLength(1);
      // Outbound adapter serialization may call JSON.stringify on the request body at most once;
      // no intermediate Request body serialization occurs during Messages -> Responses handoff.
      const inputStringifies = stringify.mock.calls.filter(([value]) => value && typeof value === "object" && "input" in value);
      expect(inputStringifies.length).toBeLessThanOrEqual(1);
      expect(responseContinuationRetainedStoreSnapshot().count).toBe(0);
    } finally {
      unregisterTurn(turnId);
      factory.mockRestore();
      stringify.mockRestore();
      charge.mockRestore();
      budget.dispose();
      await upstream.stop(true);
    }
  });

  test("handleResponses enforces maxInboundBodyBytes on preParsedBody with 413 without reading req.body", async () => {
    const config: OcxConfig = {
      port: 0,
      maxInboundBodyBytes: 1024 * 1024,
      defaultProvider: "mock",
      providers: {},
    };
    const readSpy = spyOn(requestDecompress, "readJsonRequestBody");
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "missing/m", input: "small" }),
    });
    const oversizedPayload = { model: "missing/m", input: "x".repeat(1024 * 1024 + 64) };
    try {
      const response = await handleResponses(req, config, { model: "", provider: "" }, {
        preParsedBody: oversizedPayload,
      });
      expect(readSpy).not.toHaveBeenCalled();
      expect(req.bodyUsed).toBe(false);
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: "inbound_body_too_large" } });
    } finally {
      readSpy.mockRestore();
    }
  });

  test("handleResponses with preParsedBodyCharged=false observes request copies without consuming hard headroom across combo retries", async () => {
    const budget = budgets.createTranslatorBudget({ maxTurnBytes: 1024 });
    // Simulate parent ingress already holding 400 bytes of hard-charged request_copies.
    budget.chargeRetained(400, { kind: "request_copies" });
    const initialHeadroom = budget.snapshot().admissionHeadroomBytes;
    const charge = spyOn(budget, "chargeRetained");
    const observeCopy = spyOn(budget, "observeAcceptedRequestCopy");
    const config: OcxConfig = { port: 0, providers: {} };
    const childBody = { model: "missing/target", input: "y".repeat(380) };
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await handleResponses(
          new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" } }),
          config,
          { model: "", provider: "" },
          {
            translatorBudget: budget,
            preParsedBody: childBody,
            preParsedBodyCharged: false,
          },
        );
        expect(res.status).toBe(404);
        await res.text();
      }
      expect(charge).not.toHaveBeenCalled();
      expect(observeCopy).toHaveBeenCalledTimes(3);
      expect(budget.snapshot().admissionHeadroomBytes).toBe(initialHeadroom);
    } finally {
      charge.mockRestore();
      observeCopy.mockRestore();
      budget.dispose();
    }
  });
});
