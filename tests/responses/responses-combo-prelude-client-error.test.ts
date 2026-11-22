import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import { handleComboResponses } from "../../src/server/responses/core";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

let release: (() => void) | undefined;
beforeEach(() => { clearComboSelectionState(); clearComboTargetCooldowns(); release = acquireOwnedSpendHome(); });
afterEach(() => { release?.(); clearComboSelectionState(); clearComboTargetCooldowns(); });

async function responseFor(error: { code: string; message: string; type?: string }, httpStatus = 200) {
  const cfg: OcxConfig = { port: 0, defaultProvider: "fixture", providers: {
    fixture: { adapter: "openai-responses", authMode: "key", apiKey: "fixture", baseUrl: "https://fixture.invalid/v1" },
  }, combos: { sample: { strategy: "failover", targets: [{ provider: "fixture", model: "fixture-model" }] } } };
  const body = { model: "combo/sample", input: "hello", stream: true };
  const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const budget = createTranslatorBudget();
  try {
    const response = await executeComboResponses(req, body, "sample", cfg, { model: "", provider: "" }, { translatorBudget: budget }, {
      handleComboResponses,
      handleResponses: async () => httpStatus === 200
        ? new Response(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", output: [], error } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : Response.json({ error }, { status: httpStatus }),
    });
    return { status: response.status, body: await response.json() as { error: { type: string; code: string } } };
  } finally { budget.dispose(); }
}

test("context-length prelude becomes actionable client error", async () => {
  const result = await responseFor({ code: "context_length_exceeded", message: "Your input exceeds the context window of this model." });
  expect(result.status).toBe(400);
  expect(result.body.error).toMatchObject({ type: "invalid_request_error", code: "context_length_exceeded" });
});
test("model-not-found prelude becomes actionable client error", async () => {
  const result = await responseFor({ code: "model_not_found", message: "Fixture model unavailable" });
  expect(result.status).toBe(404);
  expect(result.body.error).toMatchObject({ type: "not_found_error", code: "model_not_found" });
});
test("throughput wording is not a context overflow", async () => {
  const result = await responseFor({ code: "context_length_exceeded", message: "Rate limit reached: too many tokens per minute" });
  expect(result.status).not.toBe(400);
});
test("a server error mentioning context remains a server error", async () => {
  const result = await responseFor({ type: "server_error", code: "upstream_server_error", message: "context window service unavailable" });
  expect(result.status).toBeGreaterThanOrEqual(500);
});
test("an upstream HTTP 400 context refusal remains a client error", async () => {
  const result = await responseFor({ type: "invalid_request_error", code: "context_length_exceeded", message: "Your input exceeds the context window of this model." }, 400);
  expect(result.status).toBe(400);
  expect(result.body.error).toMatchObject({ type: "invalid_request_error", code: "context_length_exceeded" });
});
