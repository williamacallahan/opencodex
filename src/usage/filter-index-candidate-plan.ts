import type { UsageFilterIndexQuery, UsageFilterIndexSnapshot } from "./filter-index";
import { LINKED_CLIENT_FOLDED_CLIENTS, USAGE_CODEX_CLIENT_LABELS } from "./source-filter";

interface CandidateBranch {
  /** Stable branch name; used to label a page statement in diagnostics and `EXPLAIN` seams. */
  label: string;
  sql: string;
  values: Array<string | number>;
}

/**
 * Plan independent candidate selects. Paged statements append a keyset cursor and ordered row
 * limit; the caller binds those after each branch's filter values.
 *
 * Every branch is served by an index whose key order is `(generation, <equality prefix>,
 * byte_offset, ...)`, so `ORDER BY byteOffset` walks the index and the `LIMIT` stops the scan.
 * That is the whole point of the split: a compound `UNION` cannot keep that order, because
 * SQLite sorts each compound operand, so the previous single-statement pager re-materialized and
 * sorted the entire candidate range on every page. The branches are merged in JS by offset
 * instead, which keeps the one ascending-order contract the accumulator and the tests rely on.
 */
export function usageCandidateStatements(
  query: UsageFilterIndexQuery,
  snapshot: Pick<UsageFilterIndexSnapshot, "generation" | "indexedOffset">,
  paged: boolean,
): CandidateBranch[] {
  const pageOrder = paged ? " ORDER BY byteOffset LIMIT ?" : "";
  const attrClauses: string[] = [];
  const attrValues: Array<string | number> = [];
  const rowClauses: string[] = [];
  const rowValues: Array<string | number> = [];
  const usesAttributions = query.provider !== null || query.model !== null;
  if (query.provider !== null) {
    attrClauses.push("a.provider = ?");
    attrValues.push(query.provider);
  }
  if (query.model !== null) {
    attrClauses.push("a.model = ?");
    attrValues.push(query.model);
  }
  if (query.apiKeyId !== null) {
    rowClauses.push("r.api_key_id = ?");
    rowValues.push(query.apiKeyId);
  }
  const device = query.sourceFilter?.device;
  if (device?.kind === "no-key") rowClauses.push("r.api_key_id IS NULL");
  else if (device?.kind === "key") {
    rowClauses.push("r.api_key_id = ?");
    rowValues.push(device.id);
  } else if (device?.kind === "unconfigured") {
    rowClauses.push("r.admission_kind = 'configured' AND r.api_key_id IS NOT NULL AND r.api_key_id <> ''");
    const ids = query.configuredApiKeyIds ?? [];
    if (ids.length > 0) {
      rowClauses.push(`r.api_key_id NOT IN (${ids.map(() => "?").join(", ")})`);
      rowValues.push(...ids);
    }
  }
  const client = query.sourceFilter?.client;
  // Each alternative is its own index-friendly predicate. Keeping the Codex and unknown
  // expansions as an OR inside one scan made SQLite walk the whole generation; as separate
  // branches each one searches the client index. The Codex roster is expanded one label per
  // branch for the same reason a pager needs it: `client IN (...)` matches across several key
  // values, so SQLite cannot also deliver ascending `byte_offset` from the index and sorts the
  // whole match set on every page. Separate equalities keep each branch a single ordered seek.
  const clientAlternatives: Array<{ clauses: string[]; values: Array<string | number> }> = [];
  if (client === "codex") {
    for (const label of USAGE_CODEX_CLIENT_LABELS) {
      clientAlternatives.push({ clauses: ["r.client = ?"], values: [label] });
    }
    // Mirrors matchesUsageSource: legacy Codex-surface rows are included too.
    clientAlternatives.push({ clauses: ["r.client IS NULL AND r.surface IS NULL"], values: [] });
  } else if (client === "unknown") {
    clientAlternatives.push({ clauses: ["r.client = ?"], values: ["unknown"] });
    // Mirrors matchesUsageSource: attributed-but-unclassified rows are unknown too.
    clientAlternatives.push({ clauses: ["r.client IS NULL AND r.surface IS NOT NULL"], values: [] });
    if (query.sourceFilter?.linkedClientRoster) {
      for (const label of LINKED_CLIENT_FOLDED_CLIENTS) clientAlternatives.push({ clauses: ["r.client = ?"], values: [label] });
    }
  } else if (client !== undefined && client !== "all") {
    clientAlternatives.push({ clauses: ["r.client = ?"], values: [client] });
  } else {
    clientAlternatives.push({ clauses: [], values: [] });
  }
  if (query.window) {
    // A row without a usable timestamp is excluded, exactly as the accumulator skips it.
    rowClauses.push("r.timestamp >= ? AND r.timestamp <= ?");
    rowValues.push(query.window.since, query.window.until);
  }
  // A paged read starts every branch cursor at the append offset instead (see candidatePager): a
  // second lower bound on the same column makes SQLite seek from afterOffset on every page.
  if (query.afterOffset !== undefined && !paged) {
    rowClauses.push("r.byte_offset >= ?");
    rowValues.push(query.afterOffset);
  }
  // The indexed offset is where the next unindexed row starts. Pages run in separate
  // transactions, so a concurrent refresh can index a row at exactly that offset mid-read.
  rowClauses.push("r.byte_offset < ?");
  rowValues.push(snapshot.indexedOffset);
  const alternativeSql = clientAlternatives
    .map(alternative => alternative.clauses.length > 0 ? `(${alternative.clauses.join(" AND ")})` : "")
    .filter(clause => clause !== "")
    .join(" OR ");
  const rowSql = [rowClauses.join(" AND "), alternativeSql === "" ? "" : `(${alternativeSql})`]
    .filter(clause => clause !== "")
    .join(" AND ");
  if (!usesAttributions) {
    // Force the matching index for a selective row predicate. Without it SQLite's default
    // estimate prefers the row primary key, which examines every row in the ledger even when
    // one API key or client matches a handful.
    const baseIndex = rowAccessIndexWithoutClient(query);
    const cursor = paged ? " AND r.byte_offset > ?" : "";
    return clientAlternatives.map((alternative, ordinal) => {
      const index = alternative.clauses.length > 0 ? "idx_usage_rows_client" : baseIndex;
      const clauses = [...rowClauses, ...alternative.clauses];
      return {
        label: `row[${ordinal}]${index ? ` ${index}` : " primary key"}`,
        sql: `SELECT r.byte_offset AS byteOffset FROM usage_rows r${index ? ` INDEXED BY ${index}` : ""} WHERE r.generation = ? AND ${clauses.join(" AND ")}${cursor}${pageOrder}`,
        values: [snapshot.generation, ...rowValues, ...alternative.values],
      };
    });
  }
  // Drive from the attribution index rather than scanning the row range: SQLite's default
  // estimate otherwise prefers the row primary key, which examines every row in the ledger.
  // A provider+model equality pair uses the tight `(provider, model, byte_offset)` index; a lone
  // provider or model still needs an offset-ordered index or the page would sort every match.
  const attrIndex = query.provider !== null && query.model !== null
    ? "idx_usage_attr_provider"
    : query.provider !== null
      ? "idx_usage_attr_provider_offset"
      : "idx_usage_attr_model_offset";
  // Rows with no usable attribution are selected too: the accumulator is what decides, and a
  // hand-edited row with a missing model must fail a provider/model filter exactly as the
  // streaming read does rather than disappear from the result.
  return [
    {
      label: `attribution ${attrIndex}`,
      sql: `SELECT DISTINCT a.byte_offset AS byteOffset FROM usage_attributions a INDEXED BY ${attrIndex} WHERE a.generation = ? AND ${attrClauses.join(" AND ")} AND a.byte_offset < ? AND EXISTS (SELECT 1 FROM usage_rows r WHERE r.generation = a.generation AND r.byte_offset = a.byte_offset AND ${rowSql})${paged ? " AND a.byte_offset > ?" : ""}${pageOrder}`,
      values: [
        snapshot.generation,
        ...attrValues,
        snapshot.indexedOffset,
        ...rowValues,
        ...clientAlternatives.flatMap(alternative => alternative.values),
      ],
    },
    {
      label: "unattributable",
      sql: `SELECT r.byte_offset AS byteOffset FROM usage_rows r INDEXED BY idx_usage_rows_unattributable WHERE r.generation = ? AND r.unattributable = 1 AND ${rowSql}${paged ? " AND r.byte_offset > ?" : ""}${pageOrder}`,
      values: [
        snapshot.generation,
        ...rowValues,
        ...clientAlternatives.flatMap(alternative => alternative.values),
      ],
    },
  ];
}

/** The index that answers the non-client part of a row-only filter. */
function rowAccessIndexWithoutClient(query: UsageFilterIndexQuery): string | null {
  if (query.apiKeyId !== null) return "idx_usage_rows_key";
  const device = query.sourceFilter?.device;
  if (device?.kind === "no-key" || device?.kind === "key") return "idx_usage_rows_key";
  if (device?.kind === "unconfigured") return "idx_usage_rows_admission";
  // The window is a residual predicate over a byte-offset-ordered index rather than a seek into
  // a timestamp-ordered one. A timestamp prefix cannot also deliver ascending `byte_offset`
  // without sorting, so the choice is a sort of every match on every page or one monotonic pass
  // over the generation's index entries; the latter is what a streaming scan would cost anyway.
  if (query.window) return "idx_usage_rows_window";
  return null;
}
