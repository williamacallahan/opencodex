/** The native cache decision reads the configured provider the send recorded, not the account-qualified log label. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFinalRequestLog, noteProviderAttemptSend, type RequestLogContext } from "../../src/server/request-log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const firstParty = { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key" as const };
const thirdParty = { adapter: "openai-responses", baseUrl: "https://api.z.ai/v1", authMode: "key" as const };

function coldTurnLine(configuredName: string, logLabel: string, provider: typeof firstParty): string {
  const log: RequestLogContext = { model: "fixture-model", provider: logLabel, providerAdapter: provider.adapter };
  log.usageWireParsed = true;
  log.usage = { inputTokens: 166045, outputTokens: 1, cachedInputTokens: 0 };
  noteProviderAttemptSend(log, configuredName, provider, 166045);
  const home = mkdtempSync(join(tmpdir(), "ocx-cache-namespace-"));
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  const info = console.info; const lines: string[] = [];
  console.info = ((line: string) => { lines.push(String(line)); }) as typeof console.info;
  try { addFinalRequestLog("req-namespace-1", Date.now(), log, 200, undefined, () => {}); }
  finally {
    console.info = info;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
  return lines.filter(line => line.includes("event=prompt_cache.outcome"))[0]!;
}

describe("native cache reporting for account namespaces", () => {
  test("hand-written and collision-suffixed namespaces on first-party openai report the counter", () => {
    for (const label of ["openai-work", "openai-main-2", "openai-main"]) {
      expect(coldTurnLine("openai", label, firstParty)).toContain("telemetry=reported cache_eligible=true");
    }
  });
  test("a third-party host stays unavailable under any namespace", () => {
    for (const label of ["zai", "zai-work", "zai-main-2"]) {
      expect(coldTurnLine("zai", label, thirdParty)).toContain("telemetry=unavailable cache_eligible=false");
    }
  });
  test("a namespace that belongs to another provider does not inherit the first-party registry hit", () => {
    expect(coldTurnLine("openai", "zai-work", firstParty)).toContain("telemetry=unavailable cache_eligible=false");
  });
});
