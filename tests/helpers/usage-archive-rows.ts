import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { noteArchiveChanged } from "../../src/usage/archive-segments";
import { archiveTotalsPath, buildArchiveTotals, type ArchiveTotalsFile } from "../../src/usage/archive-totals";

/** 2026-11-01T08:30:00Z: rows advance from here so they span several UTC hours. */
export const ARCHIVE_FIRST_ROW_AT = Date.UTC(2026, 10, 1, 8, 30, 0, 0);

const PROVIDERS = ["alpha", "beta"] as const;
const MODELS = ["model-a", "model-b", "model-c"] as const;
const CLIENTS = ["claude_code", "codex_cli", "pi"] as const;
const WORKLOADS = ["batch-runner:job-7", "claude-code:session-1", "nightly"] as const;
const SOURCES = ["declared", "harness", "hub"] as const;
const HOSTS = ["build-box", "laptop"] as const;
const ADDRESSES = ["192.0.2.10", "198.51.100.7", "203.0.113.5"] as const;
const ACCOUNTS = ["main", "p0a1b2c"] as const;

export interface ArchiveFixtureRow {
  requestId: string;
  timestamp: number;
  provider: string;
  model: string;
  status: number;
  durationMs: number;
  usageStatus: "reported";
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number };
  client?: string;
  workload?: string;
  workloadSource?: string;
  clientHost?: string;
  clientAddress?: string;
  accountLogLabel?: string;
}

/** A varied, made-up row; every seventh row omits its attribution so empty dimensions are exercised. */
export function archiveRow(index: number, stepMs = 7 * 60_000): ArchiveFixtureRow {
  const pick = <T>(values: readonly T[]): T => values[index % values.length]!;
  const bare = index % 7 === 6;
  return {
    requestId: `archive-${index}`,
    timestamp: ARCHIVE_FIRST_ROW_AT + index * stepMs,
    provider: pick(PROVIDERS),
    model: pick(MODELS),
    status: 200,
    durationMs: 100,
    usageStatus: "reported",
    usage: { inputTokens: 100 + index, outputTokens: 10 + (index % 5), cacheReadInputTokens: index % 3, cacheCreationInputTokens: index % 2 },
    ...(bare ? {} : {
      client: pick(CLIENTS),
      workload: pick(WORKLOADS),
      workloadSource: pick(SOURCES),
      clientHost: pick(HOSTS),
      clientAddress: pick(ADDRESSES),
      accountLogLabel: pick(ACCOUNTS),
    }),
  };
}

export function archiveRows(count: number, stepMs?: number, from = 0): ArchiveFixtureRow[] {
  return Array.from({ length: count }, (_, offset) => archiveRow(from + offset, stepMs));
}

export function jsonl(rows: readonly unknown[]): string {
  return rows.map(row => `${JSON.stringify(row)}\n`).join("");
}

/**
 * Build a segment's totals in memory and write them beside it, standing in for the totals file an
 * earlier build published: the hub writes none while the archive trim is suspended.
 */
export async function writeArchiveTotals(segmentPath: string): Promise<ArchiveTotalsFile | null> {
  const totals = await buildArchiveTotals(segmentPath);
  if (totals) writeFileSync(archiveTotalsPath(segmentPath), JSON.stringify(totals), { mode: 0o600 });
  noteArchiveChanged();
  return totals;
}

/** Write a segment the way a trim names it and return its path. */
export function writeSegment(directory: string, ino: string, content: string, label = "2026-11-01T08-30-00.000Z"): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${label}_${ino}-${Buffer.byteLength(content)}.jsonl`);
  writeFileSync(path, content);
  return path;
}

export interface BruteForceTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
}

/** Plain sums over the rows, keyed by whatever `keyOf` returns; the reference the totals must equal. */
export function bruteForce(rows: readonly ArchiveFixtureRow[], keyOf: (row: ArchiveFixtureRow) => string): Map<string, BruteForceTotals> {
  const totals = new Map<string, BruteForceTotals>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = totals.get(key) ?? { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0 };
    current.requests += 1;
    current.inputTokens += row.usage.inputTokens;
    current.outputTokens += row.usage.outputTokens;
    current.cacheReadInputTokens += row.usage.cacheReadInputTokens;
    current.cacheCreationInputTokens += row.usage.cacheCreationInputTokens;
    current.totalTokens += row.usage.inputTokens + row.usage.outputTokens;
    totals.set(key, current);
  }
  return totals;
}

export const hourOf = (timestamp: number): string => new Date(Math.floor(timestamp / 3_600_000) * 3_600_000).toISOString();
