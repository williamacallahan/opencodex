import { getConfigDir } from "../../config/paths";
import { requestUsageColdRebuild } from "../../usage/cold-rebuild-slot";
import { publishedUsageFilterIndexGeneration, readUsageFilterCandidates } from "../../usage/filter-index";
import { currentUsageLogRevision } from "../../usage/log";
import { observedUsageRevision, observeUsageRevision, type ObservedUsageRevision } from "../../usage/revision-observation";
import { createSourceFacetAccumulator } from "../../usage/source-facets";
import { snapshotConfiguredKeyIds, type UsageSourceFilter } from "../../usage/source-filter";
import { rangeWindow } from "../../usage/summary";

/** The derived index cannot answer right now; the route reports it unavailable while the index refreshes. */
export class SourceFacetsUnavailableError extends Error {}

type SourceFacets = ReturnType<ReturnType<typeof createSourceFacetAccumulator>["snapshot"]> & {
  sourceFilter: UsageSourceFilter;
  window: { since: number; until: number; timeZone: string };
  usageIncomplete: boolean;
};

/**
 * A picker reopened within this long reuses the completed counts, so it reads no ledger byte and no
 * index row. Rows appended meanwhile wait for expiry. A replaced, shrunk or rewritten ledger, a newly
 * published index generation, another home, key inventory or time zone, and local midnight (which
 * moves the 30-day window's start) never reuse an answer.
 */
const COMPLETED_FACETS_MS = 15_000;
const MAX_COMPLETED_FACETS = 4;
const completedFacets = new Map<string, { at: number; facets: SourceFacets; generation: string; observed: ObservedUsageRevision }>();

export function resetUsageSourceFacetsForTests(): void {
  completedFacets.clear();
}

function reusableFacets(key: string, now: number): SourceFacets | null {
  const hit = completedFacets.get(key);
  if (!hit) return null;
  const valid = now - hit.at >= 0 && now - hit.at < COMPLETED_FACETS_MS
    && rangeWindow("30d", now).since === hit.facets.window.since
    && observeUsageRevision(hit.observed, currentUsageLogRevision()) !== "rewritten"
    && publishedUsageFilterIndexGeneration() === hit.generation;
  if (!valid) completedFacets.delete(key);
  return valid ? hit.facets : null;
}

/**
 * The 30-day app and key counts for the source picker. A request answers from a completed result or
 * registers one build in the cold-rebuild slot and answers pending (a 503 at the route) at once; it
 * never reads the ledger or the index itself.
 */
export function getUsageSourceFacets(filter: UsageSourceFilter, configuredIds: readonly string[]): SourceFacets {
  const ids = snapshotConfiguredKeyIds(configuredIds);
  const captured: UsageSourceFilter = { client: filter.client, device: { ...filter.device } };
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = JSON.stringify([getConfigDir(), captured, ids, timeZone]);
  const reused = reusableFacets(key, Date.now());
  if (reused) return reused;
  return requestUsageColdRebuild(`facets:${key}`, async () => {
    const built = await foldFacetsFromIndex(captured, ids, timeZone);
    completedFacets.delete(key);
    completedFacets.set(key, { at: Date.now(), ...built });
    while (completedFacets.size > MAX_COMPLETED_FACETS) completedFacets.delete(completedFacets.keys().next().value!);
  });
}

/**
 * Folds the window's rows from the index's own columns (`usage_rows`) in bounded pages against one
 * published generation, each page re-checking it; ingest has already validated those rows against
 * the ledger, so no JSONL row is read here.
 */
async function foldFacetsFromIndex(captured: UsageSourceFilter, ids: readonly string[], timeZone: string) {
  const until = Date.now();
  const since = rangeWindow("30d", until).since!;
  const read = await readUsageFilterCandidates({ provider: null, model: null, apiKeyId: null, window: { since, until } });
  if (!read) throw new SourceFacetsUnavailableError("usage filter index unavailable");
  const accumulator = createSourceFacetAccumulator(captured, ids, { since, until });
  try {
    // Every page yields, even one with no row in the window; only the pager's `done` ends the fold.
    for (;;) {
      const page = read.nextIndexedRows();
      for (const row of page.rows) accumulator.add(row);
      if (page.done) break;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  } finally {
    read.close();
  }
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== timeZone) throw new Error("time zone changed");
  return {
    generation: read.snapshot.generation,
    observed: observedUsageRevision(read.snapshot.revision),
    facets: {
      ...accumulator.snapshot(),
      sourceFilter: captured,
      window: { since, until, timeZone },
      usageIncomplete: read.snapshot.oversizedRows > 0 || read.snapshot.invalidRows > 0,
    } satisfies SourceFacets,
  };
}
