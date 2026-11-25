import { rowWorkloadSource, type RequestAttribution } from "../server/request-attribution";

/** Who sent the window's requests: harness, workload and its source, device, and client address. */
export interface UsageAttributionBreakdown {
  byHarness: UsageAttributionRow[];
  /** `declared`, `harness`, or `hub`: whether the caller named its workload or the hub built it. */
  byWorkloadSource: UsageAttributionRow[];
  byWorkload: UsageAttributionRow[];
  byClientHost: UsageAttributionRow[];
  byClientAddress: UsageAttributionRow[];
}

export interface UsageAttributionRow {
  key: string;
  requests: number;
  totalTokens: number;
}

const DIMENSIONS = ["byHarness", "byWorkloadSource", "byWorkload", "byClientHost", "byClientAddress"] as const satisfies ReadonlyArray<keyof UsageAttributionBreakdown>;
type UsageAttributionDimension = typeof DIMENSIONS[number];
type AttributionTally = { requests: number; totalTokens: number };
/** Per-partition tallies; rows that never carried a dimension are not counted in it. */
export type UsageAttributionCounts = { [dimension in UsageAttributionDimension]: Map<string, AttributionTally> };

const REPORTED_ROWS = 50;
// A day partition keeps at most this many distinct keys per dimension, so a burst of distinct
// client addresses cannot grow the retained summary without bound; later keys fold into one row.
export const RETAINED_KEYS = 1_000;
export const OVERFLOW_KEY = "(other)";

export function blankAttributionCounts(): UsageAttributionCounts {
  return { byHarness: new Map(), byWorkloadSource: new Map(), byWorkload: new Map(), byClientHost: new Map(), byClientAddress: new Map() };
}

/** The harness is the row's classified `client`; rows written before it was recorded are not counted. */
function attributionKeys(row: RequestAttribution): { [dimension in UsageAttributionDimension]: string | undefined } {
  return {
    byHarness: row.client,
    byWorkloadSource: rowWorkloadSource(row),
    byWorkload: row.workload,
    byClientHost: row.clientHost,
    byClientAddress: row.clientAddress,
  };
}

function tally(counts: Map<string, AttributionTally>, key: string, requests: number, totalTokens: number): boolean {
  const bucket = counts.has(key) || counts.size < RETAINED_KEYS ? key : OVERFLOW_KEY;
  const current = counts.get(bucket);
  if (current) {
    current.requests += requests;
    current.totalTokens += totalTokens;
    return false;
  }
  counts.set(bucket, { requests, totalTokens });
  return true;
}

/** Count one row; returns how many new keys were retained, for the accumulator's size estimate. */
export function addAttributionCounts(counts: UsageAttributionCounts, row: RequestAttribution, totalTokens: number): number {
  let added = 0;
  const keys = attributionKeys(row);
  for (const dimension of DIMENSIONS) {
    const key = keys[dimension];
    if (key !== undefined && tally(counts[dimension], key, 1, totalTokens)) added += 1;
  }
  return added;
}

export function mergeAttributionCounts(into: UsageAttributionCounts, from: UsageAttributionCounts): void {
  for (const dimension of DIMENSIONS) {
    for (const [key, current] of from[dimension]) tally(into[dimension], key, current.requests, current.totalTokens);
  }
}

export function cloneAttributionCounts(counts: UsageAttributionCounts): UsageAttributionCounts {
  const cloned = blankAttributionCounts();
  mergeAttributionCounts(cloned, counts);
  return cloned;
}

/** The top rows of each dimension by requests, then tokens, then key. */
export function summarizeAttribution(counts: UsageAttributionCounts): UsageAttributionBreakdown {
  const top = (dimension: UsageAttributionDimension): UsageAttributionRow[] => [...counts[dimension]]
    .map(([key, current]) => ({ key, requests: current.requests, totalTokens: current.totalTokens }))
    .sort((left, right) => right.requests - left.requests || right.totalTokens - left.totalTokens || left.key.localeCompare(right.key))
    .slice(0, REPORTED_ROWS);
  return { byHarness: top("byHarness"), byWorkloadSource: top("byWorkloadSource"), byWorkload: top("byWorkload"), byClientHost: top("byClientHost"), byClientAddress: top("byClientAddress") };
}
