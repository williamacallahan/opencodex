import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { getDefaultConfig } from "../../src/config";
import { handleResponses } from "../../src/server/responses";
import type { AdapterEvent, OcxConfig, OcxParsedRequest } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// The emergency compaction model rescues a failed concrete compaction. A combo keeps its failures
// inside the combo, and the rescue replays the caller's body, not the operator's routing override.
const sourceError: AdapterEvent = { type: "error", status: 400, code: "invalid_argument", message: "Source rejected compact fixture" };
const rescued: AdapterEvent[] = [{ type: "text_delta", text: "Resume the report." }, { type: "done" }];
let calls: Array<{ provider: string; model: string; parsed: OcxParsedRequest }>;
let restore: (() => void) | undefined;

function settings(): OcxConfig {
  return {
    ...getDefaultConfig(), defaultProvider: "source",
    providers: {
      source: { adapter: "devin", authMode: "key", apiKey: "fixture-only", baseUrl: "https://source.example" },
      emergency: { adapter: "devin", authMode: "key", apiKey: "fixture-only", baseUrl: "https://emergency.example" },
    },
    compactionRecovery: { enabled: true, model: "emergency/rescue", allowDevinInvalidArgument: true },
  };
}

function request(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", session_id: "isolation-fixture" },
    body: JSON.stringify(payload),
  });
}

function body(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model, stream: false, store: false, max_output_tokens: 512, ...extra,
    input: [
      { type: "message", role: "user", content: "Latest goal: finish the report." },
      { type: "compaction_trigger" },
    ],
  };
}

let releaseSpend: (() => void) | undefined;
beforeEach(() => {
  releaseSpend = acquireOwnedSpendHome();
  calls = [];
  const factory = spyOn(ADAPTER_REGISTRY.devin, "create").mockImplementation((_provider, context) => ({
    name: "devin",
    reportsPhysicalSends: true,
    buildRequest() { throw new Error("runTurn fixture must not build HTTP requests"); },
    async *parseStream() { throw new Error("runTurn fixture must not parse HTTP responses"); },
    async runTurn(parsed, incoming, emit) {
      const send = incoming.sendBudget?.reserveDispatch({ sendClass: "initial", targetKey: `${context.providerId}/${parsed.modelId}` });
      if (send && (!send.allowed || !send.permit.use())) {
        emit({ type: "error", status: 429, code: "request_send_budget_exhausted", message: "Fixture send allowance exhausted" });
        return;
      }
      incoming.onPhysicalSend?.({ ordinal: 1 });
      calls.push({ provider: context.providerId, model: parsed.modelId, parsed: structuredClone(parsed) });
      for (const event of context.providerId === "source" ? [sourceError] : rescued) emit(event);
    },
  }));
  restore = () => factory.mockRestore();
});

afterEach(() => {
  try { restore?.(); } finally {
    restore = undefined;
    releaseSpend?.();
    releaseSpend = undefined;
  }
});

test("a failed combo compaction stays in the combo instead of sending to the emergency model", async () => {
  const config = settings();
  config.combos = { pair: { strategy: "failover", targets: [{ provider: "source", model: "swe-2" }, { provider: "source", model: "swe-3" }] } };
  const response = await handleResponses(request(body("combo/pair")), config, { model: "", provider: "" });
  await response.text();
  expect(calls[0] && `${calls[0].provider}/${calls[0].model}`).toBe("source/swe-2");
  expect(calls.map(call => call.provider)).not.toContain("emergency");
  expect(response.ok).toBe(false);
});

test("an operator routing override's effort reaches the initial target, not the emergency rescue", async () => {
  const config = settings();
  config.compactionRouting = { model: "source/swe-2", reasoningEffort: "high" };
  const payload = body("source/normal", { client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", compaction: { trigger: "manual" } }),
  } });
  const response = await handleResponses(request(payload), config, { model: "", provider: "" });
  await response.text();
  expect(calls.map(call => call.model)).toEqual(["swe-2", "rescue"]);
  const effortOf = (parsed: OcxParsedRequest) => (parsed._rawBody as { reasoning?: { effort?: unknown } } | undefined)?.reasoning?.effort;
  expect(effortOf(calls[0]!.parsed)).toBe("high");
  expect(effortOf(calls[1]!.parsed)).toBeUndefined();
});
