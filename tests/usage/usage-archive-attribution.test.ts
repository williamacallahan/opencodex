import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { handleManagementAPI } from "../../src/server/management-api";
import { resetUsageReadCacheForTests, usageLogPath } from "../../src/usage/log";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { jsonl, writeArchiveTotals, writeSegment } from "../helpers/usage-archive-rows";

const config: OcxConfig = { port: 0, hostname: "127.0.0.1", defaultProvider: "test", providers: {} };
const HOUR = 3_600_000;
const AT = Date.UTC(2026, 10, 20, 10, 5);

let home: string;
let previousHome: string | undefined;

function attempt(ordinal: number, fields: Record<string, unknown>): Record<string, unknown> {
  return { ordinal, adapter: "openai-responses", status: 200, durationMs: 100, sendCount: 1, recoveryKinds: [], usageStatus: "reported", ...fields };
}

/** (a) a plain row; (b) a combo whose first target failed and whose second served it as Reserve; (c) a combo its first target served. */
const ROWS = [
  {
    requestId: "plain", timestamp: AT, provider: "anthropic", model: "claude-3-haiku-20240307", status: 200, durationMs: 100,
    usageStatus: "reported", usage: { inputTokens: 100, outputTokens: 10 }, client: "claude_code",
  },
  {
    requestId: "failover", timestamp: AT + 60_000, provider: "combo", model: "team-combo", requestedModel: "team-combo", status: 200,
    durationMs: 300, usageStatus: "reported", usage: { inputTokens: 200, outputTokens: 20 }, client: "codex_cli",
    attempts: [
      attempt(1, { provider: "deepseek", model: "deepseek-chat", adapter: "openai-chat", status: 429, durationMs: 50, usageStatus: "unreported" }),
      attempt(2, { provider: "openai", model: "gpt-5.5", wireModel: "gpt-reserve", usage: { inputTokens: 200, outputTokens: 20 }, accountLogLabel: "p0a1b2c" }),
    ],
  },
  {
    requestId: "first-target", timestamp: AT + 120_000, provider: "combo", model: "team-combo", requestedModel: "team-combo", status: 200,
    durationMs: 100, usageStatus: "reported", usage: { inputTokens: 50, outputTokens: 5 }, client: "codex_cli",
    attempts: [attempt(1, { provider: "codex-lb", model: "gpt-5.5", usage: { inputTokens: 50, outputTokens: 5 } })],
  },
];

async function get<T>(path: string): Promise<T> {
  const req = new ManagementRequest(`http://localhost${path}`, { method: "GET" });
  const response = await handleManagementAPI(req, new URL(req.url), config, { refreshCodexCatalog: async () => {} });
  if (!response || response.status !== 200) throw new Error(`GET ${path} answered ${response?.status}`);
  return await response.json() as T;
}

interface Figures { requests: number; totalTokens: number }
interface LiveBody { summary: Figures; providers: Array<{ provider: string } & Figures>; models: Array<{ model: string } & Figures> }
interface ArchiveBody { attribution: string; summary: Figures & { attemptCount: number }; byProvider: { rows: Array<{ key: string } & Figures> }; byModel: { rows: Array<{ key: string } & Figures> } }

const pick = ({ requests, totalTokens }: Figures): Figures => ({ requests, totalTokens });
function byKey<T extends Figures>(rows: readonly T[], keyOf: (row: T) => string): Record<string, Figures> {
  const out: Record<string, Figures> = {};
  for (const row of rows) {
    const current = out[keyOf(row)] ?? { requests: 0, totalTokens: 0 };
    out[keyOf(row)] = { requests: current.requests + row.requests, totalTokens: current.totalTokens + row.totalTokens };
  }
  return out;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-archive-attribution-"));
  process.env.OPENCODEX_HOME = home;
  mkdirSync(join(home, "usage-archive"));
  resetUsageReadCacheForTests();
});

afterEach(() => {
  closeRequestHistoryIndex();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("archive attribution matches the live summary", () => {
  test("totals, per-provider and per-model figures, and a provider filter equal /api/usage over the same rows", async () => {
    mkdirSync(dirname(usageLogPath()), { recursive: true });
    writeFileSync(usageLogPath(), jsonl(ROWS));
    await writeArchiveTotals(writeSegment(join(home, "usage-archive"), "901", jsonl(ROWS), "2026-11-20T10-05-00.000Z"));
    const hour = Math.floor(AT / HOUR) * HOUR;
    const liveWindow = `since=${hour}&until=${hour + HOUR - 1}`;
    const archiveWindow = `since=${hour}&until=${hour + HOUR}`;

    const live = await get<LiveBody>(`/api/usage?range=all&${liveWindow}`);
    const archive = await get<ArchiveBody>(`/api/usage/archive?${archiveWindow}`);
    expect(archive.attribution).toBe("per-attempt");
    expect(pick(archive.summary)).toEqual(pick(live.summary));
    expect(archive.summary).toMatchObject({ requests: 3, attemptCount: 4 });
    expect(byKey(archive.byProvider.rows, row => row.key)).toEqual(byKey(live.providers, row => row.provider));
    expect(byKey(archive.byModel.rows, row => row.key)).toEqual(byKey(live.models, row => row.model));
    // Reserve, named only by the serving attempt's wire model, is its own model row in both.
    expect(byKey(archive.byModel.rows, row => row.key)["gpt-reserve"]).toEqual({ requests: 1, totalTokens: 220 });
    expect(archive.byProvider.rows.map(row => row.key)).not.toContain("combo");

    const liveOpenai = await get<LiveBody>(`/api/usage?range=all&${liveWindow}&provider=openai`);
    const archiveOpenai = await get<ArchiveBody>(`/api/usage/archive?${archiveWindow}&provider=openai`);
    expect(pick(archiveOpenai.summary)).toEqual(pick(liveOpenai.summary));
    expect(archiveOpenai.summary.requests).toBe(1);
  });

  test("a row retried on a second account of the same provider counts once for that provider", async () => {
    const retried = {
      requestId: "account-retry", timestamp: AT, provider: "openai", model: "gpt-5.5", status: 200, durationMs: 200, usageStatus: "reported",
      usage: { inputTokens: 80, outputTokens: 8 },
      attempts: [
        attempt(1, { provider: "openai", model: "gpt-5.5", status: 429, usageStatus: "unreported", accountLogLabel: "p0a1b2c" }),
        attempt(2, { provider: "openai", model: "gpt-5.5", usage: { inputTokens: 80, outputTokens: 8 }, accountLogLabel: "p0d1e2f" }),
      ],
    };
    mkdirSync(dirname(usageLogPath()), { recursive: true });
    writeFileSync(usageLogPath(), jsonl([retried]));
    await writeArchiveTotals(writeSegment(join(home, "usage-archive"), "902", jsonl([retried]), "2026-11-20T10-05-00.000Z"));
    const hour = Math.floor(AT / HOUR) * HOUR;
    const live = await get<LiveBody>(`/api/usage?range=all&since=${hour}&until=${hour + HOUR - 1}`);
    const archive = await get<ArchiveBody>(`/api/usage/archive?since=${hour}&until=${hour + HOUR}&provider=openai`);
    expect(archive.summary.requests).toBe(1);
    expect(byKey(archive.byProvider.rows, row => row.key)).toEqual(byKey(live.providers, row => row.provider));
  });
});
