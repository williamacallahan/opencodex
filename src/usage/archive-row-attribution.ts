/**
 * How one archived row is counted, by the live usage summary's own rules.
 *
 * A row's provider, model and account are its attributions as `attributionsWithEstimates` in
 * `src/usage/summary.ts` gives them: one per attempt for a row that made several (a failover combo,
 * a retry on another account), else the row itself, each with the resolved model identity and the
 * cost estimate the live summary assigns it. Tokens and cost of an attribution go to its own
 * (provider, model, account). The row-level figures the live summary totals (the row's own usage,
 * its cost, and whether it was priced) are kept beside them, so an unfiltered total equals the live
 * total and a provider- or model-filtered total equals the live projection to matching attempts.
 */
import { baseProviderLabel } from "../providers/label";
import { rowWorkloadSource } from "../server/request-attribution";
import type { OcxUsage } from "../types";
import type { PersistedUsageEntry } from "./log";
import {
  accountLabelForAttribution, addEstimatedCost, attributionsWithEstimates, cacheTokensFromUsage, computeEntryCost, usageAttributions,
  type UsageAttribution,
} from "./summary";
import { usageDisplayTotalTokens } from "./totals";

/** Dimensions a row has once, whatever its attempts. */
export const ROW_DIMENSIONS = ["harness", "workloadLauncher", "workloadSource", "clientHost", "clientAddress"] as const;
export type RowDimension = typeof ROW_DIMENSIONS[number];
/** Dimensions each attribution has on its own. */
export const ATTRIBUTION_DIMENSIONS = ["provider", "model", "account"] as const;
export type AttributionDimension = typeof ATTRIBUTION_DIMENSIONS[number];

/** Per-attribution sums: what the live summary adds to a provider, model or account row. */
export const ATTEMPT_SUMS = [
  "attemptCount", "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "totalTokens", "estimatedCostUsd",
] as const;
export type AttemptSums = { [sum in typeof ATTEMPT_SUMS[number]]: number };

/** Row-level sums: what the live summary adds to its window totals for the row as a whole. */
export const ROW_SUMS = [
  "rowInputTokens", "rowOutputTokens", "rowCacheReadInputTokens", "rowCacheCreationInputTokens", "rowTotalTokens",
  "rowEstimatedCostUsd", "pricedRequests", "unpricedRequests", "unmeteredRequests",
] as const;
export type RowSums = { [sum in typeof ROW_SUMS[number]]: number };

export interface ArchiveAttributionPart {
  keys: { [dimension in AttributionDimension]: string };
  sums: AttemptSums;
}

export interface ArchiveRowAttribution {
  row: { [dimension in RowDimension]: string };
  /** In attempt order; the last is the attempt that ended the request. */
  parts: ArchiveAttributionPart[];
  rowSums: RowSums;
}

/** The part of the workload before its first `:`: the launcher or product that named the session. */
export function workloadLauncher(workload: string | undefined): string {
  return typeof workload === "string" ? workload.split(":", 1)[0]! : "";
}

export function rowDimensionValues(entry: PersistedUsageEntry): { [dimension in RowDimension]: string } {
  return {
    harness: entry.client ?? "",
    workloadLauncher: workloadLauncher(entry.workload),
    workloadSource: rowWorkloadSource(entry) ?? "",
    clientHost: entry.clientHost ?? "",
    clientAddress: entry.clientAddress ?? "",
  };
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** An attribution's provider, model and account as buckets key them and filters compare them. */
function attributionKeys(attribution: UsageAttribution): { [dimension in AttributionDimension]: string } {
  return {
    provider: typeof attribution.provider === "string" ? baseProviderLabel(attribution.provider) : "",
    model: typeof attribution.model === "string" ? attribution.model : "",
    account: accountLabelForAttribution(attribution.provider, attribution.accountLogLabel) ?? "",
  };
}

/** Every attribution's keys of a row, without pricing it: what a row read filters on. */
export function rowAttributionKeys(entry: PersistedUsageEntry): Array<{ [dimension in AttributionDimension]: string }> {
  return usageAttributions(entry).map(attributionKeys);
}

function tokenSums(usage: OcxUsage | undefined, storedTotal: number | undefined): { input: number; output: number; read: number; creation: number; total: number } {
  if (!usage) return { input: 0, output: 0, read: 0, creation: 0, total: 0 };
  const { read, creation } = cacheTokensFromUsage(usage);
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    read: read ?? 0,
    creation: creation ?? 0,
    total: usageDisplayTotalTokens(usage, storedTotal) ?? 0,
  };
}

/**
 * The row's attributions and sums, or undefined when any dimension is not a string or any sum is not
 * a finite non-negative number (a `usage: {}` row sums to NaN), so nothing the totals reader would
 * reject can be written.
 */
export function archiveRowAttribution(entry: PersistedUsageEntry): ArchiveRowAttribution | undefined {
  const row = rowDimensionValues(entry);
  if (!ROW_DIMENSIONS.every(dimension => typeof row[dimension] === "string")) return undefined;
  const costInfo = computeEntryCost(entry);
  const parts = attributionsWithEstimates(entry, costInfo).map(({ attribution, estimate }): ArchiveAttributionPart => {
    const tokens = tokenSums(attribution.usage, attribution.totalTokens);
    return {
      keys: attributionKeys(attribution),
      sums: {
        attemptCount: 1, inputTokens: tokens.input, outputTokens: tokens.output, cacheReadInputTokens: tokens.read,
        cacheCreationInputTokens: tokens.creation, totalTokens: tokens.total, estimatedCostUsd: estimate ? estimate.cost.total : 0,
      },
    };
  });
  const tokens = tokenSums(entry.usage, entry.totalTokens);
  const cost = { estimatedCostUsd: 0, pricedRequests: 0, unpricedRequests: 0, unmeteredRequests: 0 };
  addEstimatedCost(cost, entry, costInfo);
  const rowSums: RowSums = {
    rowInputTokens: tokens.input, rowOutputTokens: tokens.output, rowCacheReadInputTokens: tokens.read,
    rowCacheCreationInputTokens: tokens.creation, rowTotalTokens: tokens.total, rowEstimatedCostUsd: cost.estimatedCostUsd,
    pricedRequests: cost.pricedRequests, unpricedRequests: cost.unpricedRequests, unmeteredRequests: cost.unmeteredRequests,
  };
  if (parts.length === 0 || !ROW_SUMS.every(sum => isCount(rowSums[sum]))) return undefined;
  if (!parts.every(part => ATTEMPT_SUMS.every(sum => isCount(part.sums[sum])))) return undefined;
  return { row, parts, rowSums };
}
