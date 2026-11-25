# Usage archive reads

The ledger trim in `src/usage/ledger-retention.ts` moves the oldest rows of `usage.jsonl` into
`<config>/usage-archive/<first row UTC>_<ledger inode>-<cut offset>.jsonl` segments and deletes
them after `USAGE_ARCHIVE_RETENTION_DAYS` (31) by mtime; [Dashboard Surfaces And
Usage](dashboard-and-usage.md#usage-accounting) owns that write path. This doc owns what reads the
archive. Segment names, the duplicate rule, and the head-row label that both sides use live in
`src/usage/archive-segments.ts`.

The hub serves inference on the same event loop that answers these reads, so the governing rule
here is that no request turn does work proportional to the archive's size.

## Hourly totals files

Each segment gets a sibling `<segment name without .jsonl>.hourly.json`, built by
`src/usage/archive-totals.ts`. It holds additive buckets keyed by UTC hour, `provider`, `model`,
harness (the row's `client`), workload launcher (the `workload` before its first `:`), workload
source (`rowWorkloadSource` in `src/server/request-attribution.ts`), `clientHost`,
`clientAddress`, and account (`accountLogLabel`). A dimension a row lacks is stored as `""`, never
dropped. Each bucket sums requests, input, output, cache-read input, cache-creation input and total
tokens with the live summary's rules (`cacheTokensFromUsage` and `usageDisplayTotalTokens`), and
`estimatedCostUsd` with its `pricedRequests`, `unpricedRequests` and `unmeteredRequests` through
the live summary's own `addEstimatedCost` in `src/usage/summary.ts`, unrounded as there. No request
body, API key or account identifier beyond `accountLogLabel` enters a bucket.

Buckets key on a row's top-level `provider`, `model` and `accountLogLabel`, which describe its
final attempt. `/api/usage` attributes a multi-attempt or combo row to each attempt's own provider,
model and account, so the two can differ for those rows; both archive routes say so with
`attribution: "final-attempt"`.

Every dimension is caller-influenced (a data-plane caller declares its own machine name and
workload), so the builder bounds the file. Each dimension keeps the live summary's
`RETAINED_KEYS` (1,000) distinct values per segment and counts later ones as `OVERFLOW_KEY`
(`(other)`), both from `src/usage/attribution-breakdown.ts`. A segment keeps at most
`MAX_BUCKETS_PER_SEGMENT` (5,000) buckets, about 350 bytes of JSON each, so a totals file stays
under 2 MB; a further combination is counted in its hour's all-`(other)` bucket.

The file carries `version` (`ARCHIVE_TOTALS_FORMAT_VERSION`, 3), the segment's `bytes`, the `rows`
counted, `unparsableRows`, `firstRowAt`/`lastRowAt`, `hourOffsets` (for each UTC hour with rows,
the byte offset of the first row in file order stamped in that hour, which is what a row read seeks
to), `overflowRows` (per dimension, the rows counted as `(other)`), and `foldedRows` (rows counted
in an all-`(other)` bucket). A row is unparsable when it fails to parse or normalize, exceeds the
1 MiB row ceiling, is a torn final row, has no integer timestamp in `[0, 8.64e15]` (the range a
`Date` holds), has a non-string dimension, or contributes a non-finite or negative sum (a
`usage: {}` row sums to NaN). So nothing the reader would reject can reach the file. A reader
serves it only when the version is current and `bytes` equals the segment's length; anything else
is rebuilt.

A build reads the segment through `scanUsageLedgerCooperatively` in `src/usage/ledger-scanner.ts`
with its `path` option, so archive reads share the live ledger's chunked reads, row ceiling,
torn-row rule, and its yields to the event loop (every 8 ms of row work, and every 1 MiB or 1,000
rows at a chunk boundary). Only the buckets are kept in memory. The file is published through
`atomicWriteFileStreamed` with `recordOwnership: false`, since the archive directory is registered
once. Builds run one at a time in arrival order; each starts from a timer `BUILD_GAP_MS` (250 ms)
after the previous one finished, so a backlog never runs back to back and no build runs in the tail
of the turn that queued it. A queued segment is not queued twice. A build that fails is remembered
in process by segment path (whose name carries its length) and format version, with its reason
(`segment-changed`, `io-error` with the error code, or `build-error`), and is not queued again
automatically until the process restarts.

A trim that publishes a segment queues its build from `src/server/usage-ledger-retention.ts` from a
timer after the trim's turn has ended: a failed build logs one `[usage-retention]` warning and never
fails or delays the trim. Segments with no current totals (written before totals existed,
interrupted by a crash, or from an older format) are built two ways. A read that finds one in its
window queues it. And `scheduleArchiveTotalsStartupBuild`, in the same file, is called from the
background lifecycle's `scheduleStartupRun` in `src/server/background-lifecycle.ts` beside the
storage policy's startup run: it arms one unref'd 60-second timer, so `startServer` only sets a
timer and awaits nothing, and when it fires `buildMissingArchiveTotals` in
`src/usage/archive-query.ts` queues every counted segment without totals, newest first, through the
same paced queue. Releasing the last background lifecycle lease cancels a timer that has not fired.

Every place that deletes a segment deletes its totals file with it, as a separate step, and the
31-day prune also deletes any totals file whose segment is gone (`segmentNameOfTotals`). Each of
those deletions is isolated like the leftover cleanups in [Dashboard Surfaces And
Usage](dashboard-and-usage.md#usage-accounting): a totals file that cannot be removed logs one
warning and never stops a segment's cleanup or the trim. A totals file is written after its
segment, so its own mtime is never the retention clock. Every in-process write to the archive calls
`noteArchiveChanged`, which invalidates the cached listing below.

`tests/usage/usage-archive-totals.test.ts` and `tests/usage/usage-archive-totals-bounds.test.ts`
cover the trim-time build against a plain sum and its timer, the lazy build and hour offsets, the
startup pass, unparsable rows, the cost, the cardinality caps, the pacing, remembered failures,
format and length mismatches, the prune, and the yields.

## Counting each row once

A completed trim publishes the new ledger through a rename, so each published segment comes from a
different ledger file (inode) and no two published segments share a row. The overlaps that remain
are leftovers: segments of the same file, which all copy it from byte 0, and so share its first-row
label. The publishing trim replaced the file, and no trim of a replaced file can write a segment, so
the published one is always the most recently written. `countedArchiveSegments` therefore counts,
among segments with the same inode and first-row label, only the one with the latest mtime (the
longer on a tie). That covers both orders: an older shorter leftover holds only rows the published
segment holds, and an older longer one (a trim killed before its rename, then a smaller cut after
the limit was raised) also holds rows the published ledger now has. It also skips a segment named
with the live ledger's inode and head label (`ledgerHeadLabel`), a trim that stopped before its
rename whose rows are still in `usage.jsonl`. After a publish, `ledger-retention.ts` also deletes a
same-inode leftover that is longer than the new segment when the new segment is its prefix.

## Reading without blocking

`readArchiveListing` lists the directory asynchronously, stats each segment and totals file, and
caches the result for 5 seconds; after that it re-lists only when the directory's mtime moved, at
least every 60 seconds regardless, and at once after any in-process archive write. The live ledger's
head row is read again only when its inode changes. `loadWindowSegments` picks the segments that may
overlap the window from the listing alone (the first-row time in the name, and the mtime as the last
row's upper bound), reads only their totals files, asynchronously and one file per event-loop turn,
and parses each within the per-segment bucket cap. Parsed totals sit in a least-recently-used cache
bounded by `TOTALS_CACHE_MAX_BUCKETS` (100,000 buckets, twenty segments at their cap); the first and
last row of every totals file read are kept apart so coverage stays exact. The aggregation yields
every 2,000 buckets.

## Totals route

`GET /api/usage/archive` in `src/server/management/usage-archive-routes.ts` sits behind the same
management authentication as `/api/usage` and is declared in
`src/server/management/route-registry.ts` as a `deferred-verb` exemption owned by this doc: no CLI
verb reads the archive yet. It validates `since`/`until` with `parseUsageTimeWindow` (required,
`until` strictly later, at most 32 days), rejects unknown or repeated parameters, and widens the
window outward to whole UTC hours, `until` exclusive. Filters normalize like the live ones through
`parseAttributionFilter` (a canonical client address, an unrecognized harness as `unknown`, values
trimmed); a blank value selects rows that never recorded the dimension. The route sums every bucket
whose hour is in the window and whose dimensions equal every filter.

The route never builds inline. A segment in the window without current totals is listed in
`coverage.pendingSegments` and queued; one whose build failed in this process is listed in
`coverage.failed` with its reason and left alone. The answer never includes rows still in
`usage.jsonl`; `coverage.liveLedgerSince` is the live ledger's first timed row.
`coverage.earliestRowAt`/`latestRowAt` span every counted segment: a segment whose totals have not
been read contributes its name's first-row time and its mtime, and `coverage.approximate: true`
says so. Every reported instant outside what a `Date` holds is `null`, never a thrown error. `byHour`
is the window's time series, every hour with rows in chronological order and bounded only by the
window (at most 768 hours). Every other breakdown keeps the 200 keys with the most requests and
reports the rest as `truncated`. `tests/usage/usage-archive-route.test.ts` covers hour widening,
filters and their normalization, the 400 cases, pending, failed and rebuilt totals, the window
pre-filter, the cap, an out-of-range timestamp, and the counting rule including the limit-change
sequence; `tests/usage/usage-archive-leftovers.test.ts` covers the cleanup side of that sequence.

## Rows route

`GET /api/usage/archive/rows`, in the same route file, reads archived rows for a window of at most
six hours (not widened, `until` exclusive) with the same filters plus an exact `workload`, and a
`limit` of 1 to `REQUEST_HISTORY_MAX_PAGE_SIZE` (100, from `src/routing/history/indexer.ts`, the
default too). Reads run one at a time through `inArchiveRowsReadQueue` in `src/usage/archive-rows.ts`;
a request that waits longer than the five-second deadline answers 503 `archive_rows_busy` with
`Retry-After: 1`. Rows are appended in arrival order, but a retry can log one slightly out of time
order, so each segment is read from `archiveSeekOffset`: the smallest `hourOffsets` offset among
hours at or after the hour before `since`'s hour (the minimum also catches a later-stamped row
appended before that hour's first row). The scan starts there through `scanUsageLedgerCooperatively`
with `startAtBytes`, which for a `path` file needs only the scanner's LF-boundary check, since a
published segment is immutable. It stops at the first row stamped an hour or more past `until`, at
`limit + 1` matching rows, or at the five-second deadline (`AbortSignal.timeout`; no management route
shares a deadline constant), and every row is filtered by its own timestamp. A segment without
current totals has no offsets, so it is never scanned from its start: it is reported pending (or
failed) and its build is queued. `coverage.segments` lists each segment read with its `fromByte` and
`endedBy` (`window-end`, `segment-end`, `limit`, `deadline`), and the top-level `endedBy` is
`window-end`, `limit` or `deadline`. A segment pruned or replaced mid-read keeps the rows already
read. Rows go through the same `requestLogEntryFromPersistedUsage` and `requestLogDto` projection as
`/api/request-history`, so an archived row exposes exactly the fields, and the redaction, of a live
one. `tests/usage/usage-archive-rows.test.ts` covers the window, filters, the seek with an
out-of-order row, pending segments, the row shape against `/api/request-history`, the limit, a
deadline that passes mid-scan, the read queue, and the 400 cases.
