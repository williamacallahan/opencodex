/**
 * Reads over the usage archive, the rows a ledger trim moved out of `usage.jsonl` (31 days).
 *
 * - `GET /api/usage/archive` - totals for a window, answered only from the hourly totals files.
 * - `GET /api/usage/archive/rows` - the archived rows of a window of at most six hours, one read at a
 *   time, bounded by a row limit and a deadline.
 *
 * Neither route includes rows still in the live ledger: `coverage.liveLedgerSince` says where it
 * begins, and `/api/usage` answers for it. Both attribute a row per attempt, as the live summary
 * does, which `attribution` names in each answer.
 */
import { REQUEST_HISTORY_MAX_PAGE_SIZE } from "../../routing/history/indexer";
import { answerArchiveTotals, type ArchiveFilter } from "../../usage/archive-answer";
import { scheduleUsageFilterIndexRefresh } from "../../usage/filter-index";
import {
  ambiguousWindowSegments, loadWindowSegments, mayDuplicateLiveLedger, missingWindowSegments, queueMissingTotals, readArchiveListing,
  type ArchiveSegmentState,
} from "../../usage/archive-query";
import { inArchiveRowsReadQueue, readArchivedRows, type ArchivedRowsQuery } from "../../usage/archive-rows";
import { ARCHIVE_DIMENSIONS, MAX_DATE_MS, type ArchiveDimension } from "../../usage/archive-totals";
import { parseUsageTimeWindow } from "../../usage/time-range";
import { jsonResponse } from "../auth-cors";
import { parseAttributionFilter } from "../request-attribution";
import { requestLogEntryFromPersistedUsage } from "../request-log";
import { upstreamDiagnosticLogProjection } from "../request-log-terminal-status";
import type { ManagementContext } from "./context";
import { requestLogDto } from "./shared";

const HOUR_MS = 60 * 60 * 1000;
/** The archive keeps 31 days; a day more lets a caller ask for the whole of it without arithmetic. */
const MAX_TOTALS_WINDOW_MS = 32 * 24 * HOUR_MS;
/** Provider, model and account figures are each attempt's, as the live summary attributes them. */
const ATTRIBUTION = "per-attempt";

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

/**
 * Exact-match filters, normalized the way the live attribution filters are (`parseAttributionFilter`:
 * a client address in canonical form, an unrecognized harness as `unknown`, values trimmed). A blank
 * value stays `""`, which selects rows that never recorded the dimension.
 */
export function parseArchiveFilter(params: URLSearchParams): ArchiveFilter & { workload?: string } {
  const live = parseAttributionFilter(params);
  const normalized: Partial<Record<ArchiveDimension | "workload", string | undefined>> = {
    harness: live.harness, clientAddress: live.clientAddress, clientHost: live.clientHost, workload: live.workload,
  };
  const filter: ArchiveFilter & { workload?: string } = {};
  for (const name of [...ARCHIVE_DIMENSIONS, "workload"] as const) {
    const raw = params.get(name);
    if (raw === null) continue;
    filter[name] = raw.trim() === "" ? "" : normalized[name] ?? raw.trim();
  }
  return filter;
}

const breakdownName = (dimension: ArchiveDimension): string => `by${dimension[0]!.toUpperCase()}${dimension.slice(1)}`;
/** Total: an instant outside what a `Date` can hold is reported as unknown rather than thrown. */
const isoOrNull = (at: number | null): string | null => at !== null && Math.abs(at) <= MAX_DATE_MS ? new Date(at).toISOString() : null;
const failedCoverage = (states: readonly ArchiveSegmentState[]) =>
  states.map(state => ({ segment: state.name, ...state.failure! }));

async function archiveTotalsResponse(ctx: ManagementContext): Promise<Response> {
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
  const listing = await readArchiveListing();
  const answer = await answerArchiveTotals(listing, since, until, filter);
  queueMissingTotals(answer.windowSegments);
  const ambiguous = [...await ambiguousWindowSegments(listing, since, until), ...answer.liveDuplicateSegments];
  const missing = await missingWindowSegments(listing, since, until);
  const complete = answer.pendingSegments.length === 0 && answer.failedSegments.length === 0 && answer.inexactSegments.length === 0
    && ambiguous.length === 0 && missing.length === 0;
  const capped = answer.foldedRows > 0 || answer.overlapRowsDropped > 0 || ARCHIVE_DIMENSIONS.some(dimension => answer.overflowRows[dimension] > 0);
  catchUpLiveLedgerMinimum(listing);
  // A breakdown whose pricing classes cannot be rebuilt carries them as null rather than a guess.
  const unpriced = new Set(answer.unpricedBreakdowns);
  const breakdowns = Object.fromEntries(ARCHIVE_DIMENSIONS.map(dimension => {
    const breakdown = answer.byDimension[dimension];
    return [breakdownName(dimension), unpriced.has(dimension)
      ? { ...breakdown, rows: breakdown.rows.map(row => ({ ...row, pricedRequests: null, unpricedRequests: null, unmeteredRequests: null })) }
      : breakdown];
  }));
  return jsonResponse({
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    attribution: ATTRIBUTION,
    coverage: {
      earliestRowAt: isoOrNull(answer.earliestRowAt),
      latestRowAt: isoOrNull(answer.latestRowAt),
      ...(answer.spanApproximate ? { approximate: true } : {}),
      segments: answer.segmentsInRange,
      pending: answer.pendingSegments.length > 0,
      pendingSegments: answer.pendingSegments.map(state => state.name),
      failed: failedCoverage(answer.failedSegments),
      inexact: answer.inexactSegments,
      unpricedBreakdowns: answer.unpricedBreakdowns.map(breakdownName),
      // Read only to report: neither counted nor skipped, since nothing proves which copy is archived once.
      ambiguousSegments: ambiguous.map(entry => entry.name),
      // Deprecated: the archive-wide count of those files, kept for existing callers; it decides nothing.
      duplicateSegments: listing.ambiguous.length,
      // Totals files whose segment is gone: rows missing from the archive, not absent from it.
      missingSegments: missing.map(entry => entry.segment),
      unparsableRows: answer.unparsableRows,
      // Per-segment caps folded some keys into `(other)`: a filtered or per-dimension figure may undercount.
      capped,
      overflowRows: answer.overflowRows,
      foldedRows: answer.foldedRows,
      overlapRowsDropped: answer.overlapRowsDropped,
      liveLedgerSince: isoOrNull(listing.liveLedgerSince),
    },
    // A segment that may overlap the window but has no usable totals (pending or failed), or whose
    // totals left rows, a once-only count or a filtered value out of the window (inexact), leaves the
    // figures short or doubled: the answer says so and carries no numbers rather than numbers that
    // look complete.
    ...(complete
      ? { complete: true, summary: answer.summary, byHour: answer.byHour, ...breakdowns }
      : { complete: false, summary: null, byHour: null, ...Object.fromEntries(Object.keys(breakdowns).map(name => [name, null])) }),
  }, 200, ctx.req, ctx.config);
}

const MAX_ROWS_WINDOW_MS = 6 * HOUR_MS;
const DEFAULT_ROWS_LIMIT = REQUEST_HISTORY_MAX_PAGE_SIZE;
/** No management route shares a deadline constant; with the hour seek a six-hour read covers about eight hours of rows. */
const ARCHIVE_ROWS_DEADLINE_MS = 5_000;

function parseRowsLimit(params: URLSearchParams): number {
  const raw = params.get("limit");
  if (raw === null) return DEFAULT_ROWS_LIMIT;
  const limit = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REQUEST_HISTORY_MAX_PAGE_SIZE) {
    throw new ArchiveQueryError("invalid_limit", `limit must be an integer from 1 to ${REQUEST_HISTORY_MAX_PAGE_SIZE}`);
  }
  return limit;
}

/**
 * A read that withheld segments because the live ledger's minimum was unverified asks the usage
 * filter index to catch up, once its own read is done: in the background, so this request and the
 * next never wait for the ingest, and a later read can answer exactly.
 */
function catchUpLiveLedgerMinimum(listing: Awaited<ReturnType<typeof readArchiveListing>>): void {
  if (listing.liveLedgerPresent && !listing.liveLedgerVerified) scheduleUsageFilterIndexRefresh();
}

async function archiveRowsResponse(ctx: ManagementContext): Promise<Response> {
  const params = ctx.url.searchParams;
  let query: ArchivedRowsQuery;
  try {
    assertKnownParameters(params, ["since", "until", "limit", "workload", ...ARCHIVE_DIMENSIONS]);
    const window = parseArchiveWindow(params, MAX_ROWS_WINDOW_MS);
    const { workload, ...filter } = parseArchiveFilter(params);
    query = { ...window, filter, limit: parseRowsLimit(params), ...(workload !== undefined ? { workload } : {}) };
  } catch (error) {
    if (error instanceof ArchiveQueryError) return archiveQueryErrorResponse(ctx, error);
    throw error;
  }
  // An abandoned request stops its read, or its wait for a turn, at once instead of at the deadline.
  const abandoned = ctx.req.signal;
  const queued = await inArchiveRowsReadQueue(ARCHIVE_ROWS_DEADLINE_MS, async () => {
    // The read's own deadline starts with its turn and covers listing, totals and the ambiguity check,
    // not only the scan; waiting for the turn has its own budget above.
    const deadline = AbortSignal.any([AbortSignal.timeout(ARCHIVE_ROWS_DEADLINE_MS), abandoned]);
    let listing: Awaited<ReturnType<typeof readArchiveListing>>;
    try {
      listing = await readArchiveListing(undefined, deadline);
    } catch (error) {
      if (!deadline.aborted) throw error;
      // The listing ran out of time: nothing was read, which the reader reports as the deadline.
      listing = { segments: [], ambiguous: [], missing: [], liveLedgerSince: null, liveLedgerPresent: false, liveLedgerVerified: false };
    }
    const loaded = await loadWindowSegments(listing, query.since, query.until, deadline);
    queueMissingTotals(loaded);
    // A segment the live ledger may also hold is withheld and reported, like an ambiguous one.
    const states = loaded.filter(state => !state.built || !mayDuplicateLiveLedger(state, listing));
    const ambiguous = [
      ...await ambiguousWindowSegments(listing, query.since, query.until, deadline),
      ...loaded.filter(state => state.built && mayDuplicateLiveLedger(state, listing)),
    ];
    const missing = await missingWindowSegments(listing, query.since, query.until, deadline);
    return { listing, ambiguous, missing, result: await readArchivedRows(states, query, deadline) };
  }, abandoned);
  if (queued.kind === "busy") {
    const response = jsonResponse({ error: { code: "archive_rows_busy", message: "another archive row read is running; retry shortly" } }, 503, ctx.req, ctx.config);
    response.headers.set("Retry-After", "1");
    return response;
  }
  const { listing, ambiguous, missing, result } = queued.value;
  catchUpLiveLedgerMinimum(listing);
  const projectDiagnostics = upstreamDiagnosticLogProjection();
  const pending = result.pending.filter(state => !state.failure);
  return jsonResponse({
    since: new Date(query.since).toISOString(),
    until: new Date(query.until).toISOString(),
    attribution: ATTRIBUTION,
    // The request-history DTO and its redaction, so an archived row exposes exactly what a live one does.
    entries: result.rows.map(row => requestLogDto(requestLogEntryFromPersistedUsage(row, { projectDiagnostics }), { includeDecodeRate: false, projectDiagnostics })),
    endedBy: result.endedBy,
    truncated: result.endedBy !== "window-end",
    // Segments in the window without totals (pending or failed), and ambiguous ones, were not read, so rows may be missing.
    incomplete: result.endedBy !== "window-end" || result.pending.length > 0 || ambiguous.length > 0 || missing.length > 0
      || result.skippedRows > 0,
    coverage: {
      segments: result.segments,
      pending: pending.length > 0,
      pendingSegments: pending.map(state => state.name),
      failed: failedCoverage(result.pending.filter(state => state.failure)),
      ambiguousSegments: ambiguous.map(entry => entry.name),
      duplicateSegments: listing.ambiguous.length,
      missingSegments: missing.map(entry => entry.segment),
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
