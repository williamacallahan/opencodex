import { getConfigDir } from "../../config/paths";
import { awaitUsageColdRebuild } from "../../usage/cold-rebuild-slot";
import { readUsageFilterCandidates, requestUsageFilterIndexRebuild } from "../../usage/filter-index";
import { readUsageLedgerRowsAtOffsets } from "../../usage/ledger-scanner";
import { currentUsageLogRevision, usageLogIdentityKey, usageLogRevisionKey } from "../../usage/log";
import { createSourceFacetAccumulator } from "../../usage/source-facets";
import { snapshotConfiguredKeyIds, type UsageSourceFilter } from "../../usage/source-filter";
import { rangeWindow } from "../../usage/summary";

/** The derived index cannot answer right now (unusable, or disagrees with the ledger); one refresh is running. */
export class SourceFacetsUnavailableError extends Error {}

type SourceFacets = ReturnType<ReturnType<typeof createSourceFacetAccumulator>["snapshot"]> & {
  sourceFilter: UsageSourceFilter;
  window: { since: number; until: number; timeZone: string };
  usageIncomplete: boolean;
};

/**
 * A picker reopened within this long reuses the completed counts, so it reads no ledger bytes. Rows
 * appended meanwhile wait for expiry; a replaced ledger, another home, a changed key inventory or time
 * zone, and local midnight (which moves the 30-day window's start) are different keys and never reuse.
 */
const COMPLETED_FACETS_MS = 15_000;
const MAX_COMPLETED_FACETS = 4;
const completedFacets = new Map<string, { at: number; facets: SourceFacets }>();

export function resetUsageSourceFacetsForTests(): void {
  completedFacets.clear();
}

/**
 * The 30-day app and key counts for the source picker, folded from the candidate index's rows for the
 * window in bounded pages against one published index generation. Never a per-picker full scan: an
 * unusable index answers unavailable, and a fold that outlasts the cold-rebuild wait answers pending
 * (both a 503 at the route) while it finishes in the background and fills the cache.
 */
export async function getUsageSourceFacets(filter: UsageSourceFilter, configuredIds: readonly string[]): Promise<SourceFacets> {
  const ids = snapshotConfiguredKeyIds(configuredIds);
  const captured: UsageSourceFilter = { client: filter.client, device: { ...filter.device } };
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = Date.now();
  const since = rangeWindow("30d", now).since!;
  const key = JSON.stringify([getConfigDir(), captured, ids, timeZone, since, usageLogIdentityKey(currentUsageLogRevision())]);
  const hit = completedFacets.get(key);
  if (hit && now - hit.at >= 0 && now - hit.at < COMPLETED_FACETS_MS) return hit.facets;
  return awaitUsageColdRebuild(`facets:${key}`, async () => {
    const facets = await foldFacetsFromIndex(captured, ids, since, timeZone);
    completedFacets.delete(key);
    completedFacets.set(key, { at: Date.now(), facets });
    while (completedFacets.size > MAX_COMPLETED_FACETS) completedFacets.delete(completedFacets.keys().next().value!);
    return facets;
  });
}

async function foldFacetsFromIndex(
  captured: UsageSourceFilter,
  ids: readonly string[],
  since: number,
  timeZone: string,
): Promise<SourceFacets> {
  const until = Date.now();
  const read = await readUsageFilterCandidates({ provider: null, model: null, apiKeyId: null, window: { since, until } });
  if (!read) throw new SourceFacetsUnavailableError("usage filter index unavailable");
  const accumulator = createSourceFacetAccumulator(captured, ids, { since, until });
  try {
    for (let first = true; ; first = false) {
      if (!first) await new Promise<void>(resolve => setTimeout(resolve, 0));
      const offsets = read.nextPage();
      // An empty first page still validates the ledger against the snapshot before reporting zeros.
      if (!first && offsets.length === 0) break;
      const rows = await readUsageLedgerRowsAtOffsets({
        offsets,
        expectedIdentityKey: read.snapshot.identityKey,
        expectedRevisionKey: usageLogRevisionKey(read.snapshot.revision),
        expectedProcessedThroughBytes: read.snapshot.indexedOffset,
        expectedProcessedThroughDigest: read.snapshot.processedThroughDigest,
        expectedFileSize: read.snapshot.revision?.size,
      });
      if (rows.unreadableOffsets.length > 0) {
        // Counting only the rows that parsed would under-report a facet; rebuild the index instead.
        requestUsageFilterIndexRebuild();
        throw new SourceFacetsUnavailableError("usage filter index disagrees with the ledger");
      }
      for (const entry of rows.entries) accumulator.add(entry);
      if (offsets.length === 0) break;
    }
  } finally {
    read.close();
  }
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== timeZone) throw new Error("time zone changed");
  return {
    ...accumulator.snapshot(),
    sourceFilter: captured,
    window: { since, until, timeZone },
    usageIncomplete: read.snapshot.oversizedRows > 0 || read.snapshot.invalidRows > 0,
  };
}
