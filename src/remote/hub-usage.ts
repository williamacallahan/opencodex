import { z } from "zod";
import { USAGE_SOURCE_CLIENTS } from "../usage/source-filter";
import { USAGE_APPS, type UsageApp } from "../usage/app-breakdown";

export const MAX_HUB_USAGE_BYTES = 1024 * 1024;
const count = z.number().finite().nonnegative();
const label = z.string().min(1).max(2048).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const split = { inputTokens: count.optional(), outputTokens: count.optional(), cachedInputTokens: count.optional(), cacheReadInputTokens: count.optional(), cacheCreationInputTokens: count.optional(), cacheCreationReported: z.boolean().optional() };
const costs = { requests: count, totalTokens: count, estimatedCostUsd: count.optional(), ...split };
const appCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/**
 * Linked clients read `apps[].client` as a closed enum, and an older one refuses the whole report on a
 * value it does not know. Labels added after that roster went out are reported as `unknown`, and a
 * reader maps any label it does not know the same way, merging the rows instead of failing.
 */
const REMOTE_FOLDED_APPS = ["pi", "amp", "antigravity_cli"] as const satisfies readonly UsageApp[];
type RemoteUsageApp = Exclude<UsageApp, typeof REMOTE_FOLDED_APPS[number]>;
const REMOTE_USAGE_APPS: readonly RemoteUsageApp[] = USAGE_APPS.filter((app): app is RemoteUsageApp =>
  !(REMOTE_FOLDED_APPS as readonly string[]).includes(app));
const remoteApp = (client: string): RemoteUsageApp => REMOTE_USAGE_APPS.find(app => app === client) ?? "unknown";
const appRow = z.object({ client: z.string().max(64), requests: appCount, measuredRequests: appCount,
  totalTokens: count, ...split, estimatedCostUsd: count.optional(), pricedRequests: appCount, unpricedRequests: appCount,
  shareRatio: count.max(1) });
type RemoteAppRow = Omit<z.infer<typeof appRow>, "client"> & { client: RemoteUsageApp };
const OPTIONAL_APP_SUMS = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "estimatedCostUsd"] as const;

function mergeAppRows(into: RemoteAppRow, row: RemoteAppRow): RemoteAppRow {
  const merged: RemoteAppRow = {
    client: into.client, requests: into.requests + row.requests, measuredRequests: into.measuredRequests + row.measuredRequests,
    totalTokens: into.totalTokens + row.totalTokens, pricedRequests: into.pricedRequests + row.pricedRequests,
    unpricedRequests: into.unpricedRequests + row.unpricedRequests, shareRatio: Math.min(1, into.shareRatio + row.shareRatio),
  };
  for (const field of OPTIONAL_APP_SUMS) {
    if (into[field] !== undefined || row[field] !== undefined) merged[field] = (into[field] ?? 0) + (row[field] ?? 0);
  }
  if (into.cacheCreationReported !== undefined || row.cacheCreationReported !== undefined) {
    merged.cacheCreationReported = into.cacheCreationReported === true || row.cacheCreationReported === true;
  }
  return merged;
}

// A roster label still appears at most once; only labels folded or unknown here merge into `unknown`.
const apps = z.array(appRow).max(64)
  .refine(rows => {
    const known = rows.map(row => row.client).filter(client => remoteApp(client) === client && client !== "unknown");
    return new Set(known).size === known.length;
  })
  .transform(rows => {
    const byClient = new Map<RemoteUsageApp, RemoteAppRow>();
    for (const raw of rows) {
      const row: RemoteAppRow = { ...raw, client: remoteApp(raw.client) };
      const prior = byClient.get(row.client);
      byClient.set(row.client, prior ? mergeAppRows(prior, row) : row);
    }
    return [...byClient.values()];
  });

// Every object is projected through this schema: account labels, raw entries, and
// future management-only fields must not hitch a ride on a client data-key read.
const hubUsageSchema = z.object({
  schemaVersion: z.literal(1), source: z.literal("hub"), scope: z.literal("client"),
  range: z.enum(["today", "7d", "30d", "all"]),
  surface: z.enum(["all", "codex", "claude", "grok"]),
  since: count.nullable(), until: count.optional(), customWindow: z.literal(true).optional(),
  generatedAt: count,
  summary: z.object({ ...costs, inputTokens: count, outputTokens: count,
    cachedInputTokens: count, unpricedRequests: count, unmeteredRequests: count }),
  providers: z.array(z.object({ provider: label, ...costs })).max(2000),
  apps: apps.optional(),
  models: z.array(z.object({ provider: label, model: label, ...costs })).max(2000),
  days: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ...costs })).max(366),
  filter: z.object({ provider: label.nullable(), model: label.nullable(),
    matched: z.boolean(), comboOverlap: z.boolean() }),
  sourceFilter: z.object({ client: z.enum(USAGE_SOURCE_CLIENTS), scope: z.literal("authenticated-key") }).optional(),
  legacyUnclassifiedRequests: count.optional(),
  usageIncomplete: z.literal(true).optional(),
  usageIncompleteReason: z.literal("oversized_rows").optional(),
});

export type HubUsageReport = z.infer<typeof hubUsageSchema>;

export function parseHubUsage(value: unknown): HubUsageReport | null {
  const result = hubUsageSchema.safeParse(value);
  return result.success ? result.data : null;
}
