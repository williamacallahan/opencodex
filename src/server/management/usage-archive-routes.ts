/**
 * Reads over the usage archive, the rows a ledger trim moved out of `usage.jsonl` (31 days).
 *
 * - `GET /api/usage/archive` - totals for a window, answered only from the hourly totals files.
 * - `GET /api/usage/archive/rows` - the archived rows of a window of at most six hours, bounded by
 *   a row limit and a deadline.
 *
 * Neither route includes rows still in the live ledger: `coverage.liveLedgerSince` says where it
 * begins, and `/api/usage` answers for it.
 */
import { answerArchiveTotals, readArchiveListing, type ArchiveFilter, type ArchiveSegmentState } from "../../usage/archive-query";
import { readArchivedRows, type ArchivedRowsQuery } from "../../usage/archive-rows";
import { ARCHIVE_DIMENSIONS, archiveTotalsBuildQueued, buildArchiveTotalsInBackground, type ArchiveDimension } from "../../usage/archive-totals";
import { parseUsageTimeWindow } from "../../usage/time-range";
import { jsonResponse } from "../auth-cors";
import { requestLogEntryFromPersistedUsage } from "../request-log";
import { upstreamDiagnosticLogProjection } from "../request-log-terminal-status";
import type { ManagementContext } from "./context";
import { requestLogDto } from "./shared";

const HOUR_MS = 60 * 60 * 1000;
/** The archive keeps 31 days; a day more lets a caller ask for the whole of it without arithmetic. */
const MAX_TOTALS_WINDOW_MS = 32 * 24 * HOUR_MS;

export class ArchiveQueryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function archiveQueryErrorResponse(ctx: ManagementContext, error: ArchiveQueryError): Response {
  return jsonResponse({ error: { code: error.code, message: error.message } }, 400, ctx.req, ctx.config);
}

/** Every parameter appears at most once and is one the route knows. */
export function assertKnownParameters(params: URLSearchParams, known: readonly string[]): void {
  for (const name of new Set(params.keys())) {
    if (!known.includes(name)) throw new ArchiveQueryError("invalid_parameter", `unknown parameter ${name}`);
    if (params.getAll(name).length > 1) throw new ArchiveQueryError("invalid_parameter", `${name} may be given once`);
  }
}

/** Required `since` and `until` (ISO datetime or epoch milliseconds), `until` strictly later, at most `maxMs` apart. */
export function parseArchiveWindow(params: URLSearchParams, maxMs: number): { since: number; until: number } {
  const since = params.get("since");
  const until = params.get("until");
  if (since === null || until === null) throw new ArchiveQueryError("invalid_window", "since and until are required");
  let window;
  try {
    window = parseUsageTimeWindow(since, until)!;
  } catch (error) {
    throw new ArchiveQueryError("invalid_window", error instanceof Error ? error.message : "invalid window");
  }
  if (window.until <= window.since) throw new ArchiveQueryError("invalid_window", "until must be after since");
  if (window.until - window.since > maxMs) {
    throw new ArchiveQueryError("invalid_window", `the window may span at most ${maxMs / HOUR_MS} hours`);
  }
  return window;
}

export function parseArchiveFilter(params: URLSearchParams): ArchiveFilter {
  const filter: ArchiveFilter = {};
  for (const dimension of ARCHIVE_DIMENSIONS) {
    const wanted = params.get(dimension);
    if (wanted !== null) filter[dimension] = wanted;
  }
  return filter;
}

/** Never inline: a read answers with what is built and leaves the rest to the background queue. */
function queueTotalsBuilds(pending: readonly ArchiveSegmentState[]): void {
  for (const state of pending) {
    if (!archiveTotalsBuildQueued(state.path)) buildArchiveTotalsInBackground(state.path);
  }
}

const breakdownName = (dimension: ArchiveDimension): string => `by${dimension[0]!.toUpperCase()}${dimension.slice(1)}`;
const isoOrNull = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();

function archiveTotalsResponse(ctx: ManagementContext): Response {
  const params = ctx.url.searchParams;
  let window: { since: number; until: number };
  let filter: ArchiveFilter;
  try {
    assertKnownParameters(params, ["since", "until", ...ARCHIVE_DIMENSIONS]);
    window = parseArchiveWindow(params, MAX_TOTALS_WINDOW_MS);
    filter = parseArchiveFilter(params);
  } catch (error) {
    if (error instanceof ArchiveQueryError) return archiveQueryErrorResponse(ctx, error);
    throw error;
  }
  // Buckets are whole UTC hours, so the window widens outward to them: [since hour, until hour).
  const since = Math.floor(window.since / HOUR_MS) * HOUR_MS;
  const until = Math.ceil(window.until / HOUR_MS) * HOUR_MS;
  const listing = readArchiveListing();
  const answer = answerArchiveTotals(listing, since, until, filter);
  queueTotalsBuilds(answer.pendingSegments);
  const breakdowns = Object.fromEntries(ARCHIVE_DIMENSIONS.map(dimension => [breakdownName(dimension), answer.byDimension[dimension]]));
  return jsonResponse({
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    coverage: {
      earliestRowAt: isoOrNull(answer.earliestRowAt),
      latestRowAt: isoOrNull(answer.latestRowAt),
      ...(answer.spanApproximate ? { approximate: true } : {}),
      segments: answer.segmentsInRange,
      pending: answer.pendingSegments.length > 0,
      pendingSegments: answer.pendingSegments.map(state => state.segment.name),
      duplicateSegments: listing.skipped.length,
      unparsableRows: answer.unparsableRows,
      liveLedgerSince: isoOrNull(listing.liveLedgerSince),
    },
    summary: answer.summary,
    byHour: answer.byHour,
    ...breakdowns,
  }, 200, ctx.req, ctx.config);
}

const MAX_ROWS_WINDOW_MS = 6 * HOUR_MS;
const MAX_ROWS_LIMIT = 500;
const DEFAULT_ROWS_LIMIT = 100;
/** No management route shares a deadline constant; with the hour seek a six-hour read covers about eight hours of rows. */
const ARCHIVE_ROWS_DEADLINE_MS = 5_000;

function parseRowsLimit(params: URLSearchParams): number {
  const raw = params.get("limit");
  if (raw === null) return DEFAULT_ROWS_LIMIT;
  const limit = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS_LIMIT) {
    throw new ArchiveQueryError("invalid_limit", `limit must be an integer from 1 to ${MAX_ROWS_LIMIT}`);
  }
  return limit;
}

async function archiveRowsResponse(ctx: ManagementContext): Promise<Response> {
  const params = ctx.url.searchParams;
  let query: ArchivedRowsQuery;
  try {
    assertKnownParameters(params, ["since", "until", "limit", "workload", ...ARCHIVE_DIMENSIONS]);
    const window = parseArchiveWindow(params, MAX_ROWS_WINDOW_MS);
    const workload = params.get("workload");
    query = { ...window, filter: parseArchiveFilter(params), limit: parseRowsLimit(params), ...(workload !== null ? { workload } : {}) };
  } catch (error) {
    if (error instanceof ArchiveQueryError) return archiveQueryErrorResponse(ctx, error);
    throw error;
  }
  const listing = readArchiveListing();
  const result = await readArchivedRows(listing, query, AbortSignal.timeout(ARCHIVE_ROWS_DEADLINE_MS));
  queueTotalsBuilds(result.pending);
  const projectDiagnostics = upstreamDiagnosticLogProjection();
  return jsonResponse({
    since: new Date(query.since).toISOString(),
    until: new Date(query.until).toISOString(),
    // The request-history DTO and its redaction, so an archived row exposes exactly what a live one does.
    entries: result.rows.map(row => requestLogDto(requestLogEntryFromPersistedUsage(row, { projectDiagnostics }), { includeDecodeRate: false, projectDiagnostics })),
    endedBy: result.endedBy,
    truncated: result.endedBy !== "window-end",
    coverage: {
      segments: result.segments,
      pending: result.pending.length > 0,
      pendingSegments: result.pending.map(state => state.segment.name),
      duplicateSegments: listing.skipped.length,
      liveLedgerSince: isoOrNull(listing.liveLedgerSince),
    },
  }, 200, ctx.req, ctx.config);
}

export async function handleUsageArchiveRoutes(ctx: ManagementContext): Promise<Response | undefined> {
  const { req, url } = ctx;
  if (url.pathname === "/api/usage/archive" && req.method === "GET") return archiveTotalsResponse(ctx);
  if (url.pathname === "/api/usage/archive/rows" && req.method === "GET") return archiveRowsResponse(ctx);
  return undefined;
}
