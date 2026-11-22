import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import { handleComboResponses } from "../../src/server/responses/core";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// 2026-11-22 00:37:19-00:39:31Z: codex-lb refused one thread's resends with 503
// upstream_operation_status_unknown plus Retry-After, because that exact parent and body might
// still be running. The hub cooled its codex-lb combo target and then answered other threads
// combo_unavailable without sending them anywhere.
let release: (() => void) | undefined;
beforeEach(() => { clearComboSelectionState(); clearComboTargetCooldowns(); release = acquireOwnedSpendHome(); });
afterEach(() => { release?.(); clearComboSelectionState(); clearComboTargetCooldowns(); });

const config: OcxConfig = {
  port: 0, defaultProvider: "lb",
  providers: {
    // The codex-lb base path makes the hub treat this target as a pooled relay, as in production.
    lb: { adapter: "openai-responses", authMode: "key", apiKey: "lb", baseUrl: "https://lb.invalid/backend-api/codex" },
    pool: { adapter: "openai-responses", authMode: "key", apiKey: "pool", baseUrl: "https://pool.invalid/v1" },
  },
  combos: { sol: { strategy: "failover", targets: [{ provider: "lb", model: "sol" }, { provider: "pool", model: "sol" }] } },
};

const served: string[] = [];
let threadARefusalCode = "";
async function upstream(req: Request): Promise<Response> {
  const body = await req.clone().json() as { model?: string; input?: unknown };
  const provider = String(body.model).split("/")[0];
  const thread = JSON.stringify(body.input).includes("thread A") ? "A" : "B";
  served.push(`${provider}:${thread}`);
  if (provider === "pool") {
    return Response.json({ error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "pool spent" } },
      { status: 429, headers: { "retry-after": "600" } });
  }
  if (thread === "A") {
    return Response.json({ error: {
      type: "server_error", code: threadARefusalCode,
      message: "The previous response operation may still be running; retry after the cooldown.",
    } }, { status: 503, headers: { "retry-after": "30" } });
  }
  return Response.json({
    id: "resp_ok", object: "response", status: "completed", model: "sol",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  });
}

async function send(thread: string) {
  const body = { model: "combo/sol", input: `next turn of thread ${thread}`, stream: false };
  const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const budget = createTranslatorBudget();
  try {
    const response = await executeComboResponses(req, body, "sol", config, { model: "", provider: "" }, { translatorBudget: budget },
      { handleComboResponses, handleResponses: upstream });
    return { status: response.status, text: await response.text() };
  } finally { budget.dispose(); }
}

test("one thread's ambiguous-operation refusal leaves the target open to other threads", async () => {
  served.length = 0;
  threadARefusalCode = "upstream_operation_status_unknown";
  expect((await send("A")).status).toBeGreaterThanOrEqual(400);
  const other = await send("B");
  expect(other.status).toBe(200);
  expect(served).toEqual(["lb:A", "pool:A", "lb:B"]);
});

// Control: the same fixture still cools a target on an ordinary overload, so the case above
// proves the refusal is exempt rather than that this harness never writes a cooldown.
test("an ordinary overload from the same target still cools it for other threads", async () => {
  served.length = 0;
  threadARefusalCode = "server_is_overloaded";
  expect((await send("A")).status).toBeGreaterThanOrEqual(400);
  const other = await send("B");
  expect(other.text).toContain("combo_unavailable");
  expect(served).toEqual(["lb:A", "pool:A"]);
});
