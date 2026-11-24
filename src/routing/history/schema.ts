/**
 * Schema contract for the derived request-history index (RI-02).
 *
 * `usage.jsonl` remains the canonical append-only evidence ledger;
 * `routing-history.sqlite` is a disposable, rebuildable query projection
 * (ADR-1/ADR-8 in devlog/_fin/260804_router_intelligence/000_master_plan.md).
 */

// Version 2 rebuilds the derived projection so old raw requested-model selectors
// are replaced by the bounded encoding already used by canonical JSONL reads.
// Version 3 adds the routing-health indexes; the rebuild runs on the worker, so
// no existing index is ever indexed in place on the event loop.
// Version 4 widened single-column filter indexes to composite (col, timestamp DESC, request_id DESC)
// so filtered /api/request-history pages seek via index instead of temp-B-tree sorting on the event loop.
// Version 5 widens idx_requests_provider_model_ts to (provider, model, timestamp DESC, request_id DESC)
// ahead of single-column filter indexes so provider+model and health lookups never scan another provider's rows.
// Version 6 adds the request-attribution columns (user agent, client address, workload, device, conversation key)
// with their composite filter indexes.
// Version 7 adds the harness columns (client, workload source, native harness session id); ingest
// classifies pre-existing rows' workload source so `undeclared` seeks an index instead of a LIKE.
export const HISTORY_SCHEMA_VERSION = 7;
export const HISTORY_DB_FILENAME = "routing-history.sqlite";

export const HISTORY_META_KEYS = {
  schemaVersion: "schema_version",
  sourcePath: "source_path",
  sourceDev: "source_dev",
  sourceIno: "source_ino",
  sourceBirthtimeMs: "source_birthtime_ms",
  sourceSize: "source_size",
  sourceMtimeMs: "source_mtime_ms",
  indexedOffset: "indexed_offset",
  indexedRows: "indexed_rows",
  builtAtMs: "built_at_ms",
  lastError: "last_error",
} as const;

export const HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  request_id       TEXT PRIMARY KEY,
  timestamp        INTEGER NOT NULL,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  requested_model  TEXT,
  status           INTEGER NOT NULL,
  surface          TEXT,
  inbound_protocol TEXT,
  api_key_id       TEXT,
  conversation_id  TEXT,
  route_kind       TEXT,
  profile_id       TEXT,
  profile_revision TEXT,
  fallback         INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER NOT NULL,
  first_output_ms  INTEGER,
  usage_status     TEXT,
  usage_json       TEXT,
  total_tokens     INTEGER,
  error_code       TEXT,
  terminal_status  TEXT,
  close_reason     TEXT,
  attempt_count    INTEGER NOT NULL DEFAULT 1,
  decision_json    TEXT,
  user_agent       TEXT,
  client_address   TEXT,
  workload         TEXT,
  client_host      TEXT,
  conversation_key TEXT,
  client           TEXT,
  workload_source  TEXT,
  harness_session_id TEXT,
  row_json         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(timestamp DESC, request_id DESC);
-- Placed before single-column indexes so without ANALYZE SQLite prefers (provider, model) over idx_requests_model/api_key.
CREATE INDEX IF NOT EXISTS idx_requests_provider_model_ts ON requests(provider, model, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_requested_model ON requests(requested_model, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_conversation ON requests(conversation_id, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_api_key ON requests(api_key_id, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_profile ON requests(profile_id, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_user_agent ON requests(user_agent, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_client_address ON requests(client_address, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_workload ON requests(workload, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_client_host ON requests(client_host, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_conversation_key ON requests(conversation_key, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_client ON requests(client, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_workload_source ON requests(workload_source, timestamp DESC, request_id DESC);
CREATE INDEX IF NOT EXISTS idx_requests_harness_session ON requests(harness_session_id, timestamp DESC, request_id DESC);
-- Routing-time health evidence (routing/health.ts): rare multi-attempt rows outside top-level provider/model.
CREATE INDEX IF NOT EXISTS idx_requests_multi_attempt_ts ON requests(timestamp) WHERE attempt_count > 1;
`;

// The index is a disposable projection, so it lives in its own directory: a deployment can keep
// it on storage it does not back up, beside canonical state it does.
export const HISTORY_DIR_NAME = "request-history";

export function historyIndexPath(configDir: string): string {
  return `${configDir.replace(/[\\/]+$/, "")}/${HISTORY_DIR_NAME}/${HISTORY_DB_FILENAME}`;
}

/** Where releases before the move kept the index; removed on the next open. */
export function legacyHistoryIndexPath(configDir: string): string {
  return `${configDir.replace(/[\\/]+$/, "")}/${HISTORY_DB_FILENAME}`;
}
