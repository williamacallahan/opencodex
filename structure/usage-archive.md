# Usage archive reads

Earlier builds' ledger trim moved the oldest rows of `usage.jsonl` into
`<config>/usage-archive/<first row UTC>_<ledger inode>-<cut offset>.jsonl` segments; that trim is
now suspended (below), and [Dashboard Surfaces And Usage](dashboard-and-usage.md#usage-accounting)
owns the write path. This doc owns what reads the archive. Segment names, the duplicate rule, and
the head-row label live in `src/usage/archive-segments.ts`.

The hub serves inference on the same event loop that answers these reads, so the governing rule
here is that no request turn does work proportional to the archive's size.

## Suspended trim

The archive directory holds files earlier builds wrote, and the hub can no longer prove which of them
are its own: a crashed copy and a published segment can be byte-identical, and an operator may have
added files. So while the trim is suspended no code path writes, renames or deletes anything in it:
`enforceUsageLedgerSizeLimit` in `src/usage/ledger-retention.ts` defers (`archive-suspended`) before
it opens the archive directory, the runtime owner in `src/server/usage-ledger-retention.ts` only warns,
every totals build is refused before it reads the segment (below), and uninstall keeps the
directory with everything in it. Existing segments and totals files are only read. The trim returns
with the archive catalog, which publishes the archived prefix and the new live ledger in one
durable decision. `tests/usage/usage-archive-leftovers.test.ts` drives a trim over the limit, a
totals build and the startup pass over an archive holding a valid-looking segment and totals name, a
temp-style name, a nested directory, an operator file and a link, and checks every byte, the link and
its target, and the ledger are unchanged.

## Known gaps until slice 2

The read side is not yet exact in these cases; the totals route's `complete: false` covers only a
segment with no usable totals.

- The span cache is keyed on totals path and mtime, so a totals file replaced with the same mtime keeps
  serving the old span.
- A segment whose rows are all unparsable has a null span and is treated as outside every window.
- The first read after a restart reads every segment's totals file once, with no budget on that cold
  pass.
- A segment's byte length is taken from its name, not its actual size, when matching its totals.

## Attribution

`src/usage/archive-row-attribution.ts` counts a row exactly as the live summary does, by reusing
its rules from `src/usage/summary.ts`: `attributionsWithEstimates` gives one attribution per attempt
(the row itself when it has none) with the resolved model (`attributedUsageModel`, so a Reserve
send is `gpt-reserve`) and the cost estimate the summary assigns it; the provider is
`baseProviderLabel` of the attempt's provider and the account `accountLabelForAttribution`. An
attribution's tokens and cost go to its own provider, model and account. The row-level figures the
live summary totals (the row's own usage, `computeEntryCost` through `addEstimatedCost`, and whether
it was priced, unpriced or unmetered) are kept beside them on the bucket of the row's final attempt.
Both routes say so with `attribution: "per-attempt"`.

## Hourly totals files

Each segment gets a sibling `<segment name without .jsonl>.hourly.json`, built by
`src/usage/archive-totals.ts`. A bucket is keyed by UTC hour, the row's own dimensions (harness, the
row's `client`; workload launcher, the `workload` before its first `:`; workload source,
`rowWorkloadSource` in `src/server/request-attribution.ts`; `clientHost`; `clientAddress`), and one
attribution's `provider`, `model` and `account`. A dimension a row lacks is stored as `""`. Each
bucket holds `requests` (rows touching it, each once), `attemptCount`, the attempt-level tokens
(input, output, cache-read, cache-creation, total) and `estimatedCostUsd`, and the row-level
`row*` tokens and cost with `pricedRequests`, `unpricedRequests` and `unmeteredRequests`. A row that
touches several buckets (a failover, or a retry on a second account) is recorded once more in
`overlaps` as the set of its bucket indices with a count, so a reader counts it once in any total
those buckets share. No request body, API key or account identifier beyond the account log label
enters a bucket.

Every dimension is caller-influenced, so the builder bounds the file. Each dimension keeps the live
summary's `RETAINED_KEYS` (1,000) distinct values per segment and counts later ones as
`OVERFLOW_KEY` (`(other)`), both from `src/usage/attribution-breakdown.ts`. A segment keeps at most
`MAX_BUCKETS_PER_SEGMENT` (5,000) buckets plus one all-`(other)` bucket per hour for further
combinations, spans at most `MAX_HOURS_PER_SEGMENT` (744, the retention window's hours; a row that
would open one more is unparsable), and keeps at most `MAX_OVERLAPS_PER_SEGMENT` (5,000) overlap
records. A file is therefore at most about 5,744 buckets of roughly 600 bytes of JSON, under 4 MB.

The file carries `version` (`ARCHIVE_TOTALS_FORMAT_VERSION`, 4), the segment's `bytes`, the `rows`
counted, `unparsableRows`, `firstRowAt`/`lastRowAt`, `buckets`, `overlaps`, `overlapRowsDropped`,
`hourOffsets` (for each UTC hour, the byte offset of its first row in file order), `overflowRows` per
dimension, and `foldedRows`. A row is unparsable when it fails to parse or normalize, exceeds the
1 MiB row ceiling, is a torn final row, has no integer timestamp in `[0, 8.64e15]`, has a non-string
dimension, or contributes a non-finite or negative sum. A reader serves the file only when the
version is current and `bytes` equals the segment's length. Anything else is not served, and while
the trim is suspended it is not rebuilt either: the segment is reported failed (`publishing-suspended`).

`buildArchiveTotals` reads the segment through `scanUsageLedgerCooperatively` in
`src/usage/ledger-scanner.ts` with its `path` option, so archive reads share the live ledger's chunked
reads, row ceiling, torn-row rule and yields (every 8 ms of row work, and every 1 MiB or 1,000 rows at
a chunk boundary), and returns the totals in memory; it publishes nothing. While the trim is suspended
no totals file is written: earlier builds wrote a temp file by name into the archive directory and
renamed it over its destination. `scheduleArchiveTotalsBuild` refuses every build with
`ArchiveTotalsPublishingSuspendedError` before reading anything, and remembers the refusal in process
by segment path and format version with reason `publishing-suspended`, so a read lists the segment in
`coverage.failed` and does not queue it again until the process restarts. The other reasons the type
keeps (`segment-changed`, `io-error` with the code, `build-error`) belong to builds into the hub's own
store once it exists.

A segment without current totals is asked for two ways, and both reach that refusal. A read that finds
one in its window queues it. And `scheduleArchiveTotalsStartupBuild`, called from the background
lifecycle's `scheduleStartupRun` in `src/server/background-lifecycle.ts`, arms one unref'd timer 60
seconds after the server starts serving (so `startServer` only sets a timer): each pass,
`buildMissingArchiveTotals` in `src/usage/archive-query.ts` takes at most
`ARCHIVE_TOTALS_PASS_SEGMENTS` (4) segments, newest first, and the timer re-arms after
`ARCHIVE_TOTALS_PASS_INTERVAL_MS` (5 minutes) while any remain. Releasing the last background
lifecycle lease cancels a pending pass and stops a running one from re-arming.

`tests/usage/usage-archive-totals.test.ts`, `tests/usage/usage-archive-totals-bounds.test.ts` and
`tests/usage/usage-archive-attribution.test.ts` cover the builds, the bounds, the refused startup
passes, and equality with `/api/usage` over the same rows, including a failover combo and a retry on
a second account. Their fixtures write segments and totals files directly
(`writeArchiveTotals` in `tests/helpers/usage-archive-rows.ts`), standing in for files earlier builds
published.

## Counting each row once

A completed trim publishes the new ledger through a rename, so each published segment comes from a
different ledger file (inode). Segments of the same file all copy it from byte 0 and share its
first-row label, and the publishing trim is always the last to write one, so `countedArchiveSegments`
counts, among segments with the same inode and label, only the one with the latest mtime (the longer
on a tie). It skips a segment named with the live ledger's inode and head label (`ledgerHeadLabel`),
a trim that stopped before its rename. The live head is cached by the same identity
`usageLogIdentityKey` uses (device, inode, birth time) and dropped on every in-process archive write,
so a new ledger that reuses a retired inode never makes a published segment look unpublished. These
are read-side rules only: nothing deletes a duplicate or leftover segment any more.

## Reading without blocking

`readArchiveListing` lists the directory asynchronously and caches it for 5 seconds; after that it
re-lists only when the directory's mtime moved, at least every 60 seconds, and at once after any
in-process archive write. `entryMayOverlap` decides whether a segment may overlap a window by its
exact span once its totals have been read, and otherwise always answers yes: a name's first-row label
and a file's mtime are not a trustworthy span (a row is stamped when its request starts and appended
when it completes, no hub setting bounds a request's total duration, and an mtime can be changed), so
a segment is never dropped by them. Its totals file is read once to learn its span, which is then
cached by totals mtime, or, without usable totals, it is reported pending or failed.

`answerArchiveTotals` in `src/usage/archive-answer.ts` loads, folds and drops one segment's totals at
a time, keeping only its span and hour index, so a request never holds more than one segment's
buckets beyond the totals cache, which is least-recently-used and bounded by
`TOTALS_CACHE_MAX_BUCKETS` (100,000). It yields every 2,000 buckets, and selects each breakdown's top
keys a slice at a time.

## Totals route

`GET /api/usage/archive` in `src/server/management/usage-archive-routes.ts` sits behind the same
management authentication as `/api/usage` and is declared in
`src/server/management/route-registry.ts` as a `deferred-verb` exemption owned by this doc. It
validates `since`/`until` with `parseUsageTimeWindow` (required, `until` strictly later, at most 32
days), rejects unknown or repeated parameters, and widens the window outward to whole UTC hours,
`until` exclusive. Filters normalize like the live ones through `parseAttributionFilter`; provider
and model compare case-insensitively, as the live filter does, and a blank value selects rows that
never recorded the dimension.

Provider, model and account breakdowns sum attempt-level figures. The summary, `byHour` and the row
dimensions' breakdowns sum row-level figures, except under a provider, model or account filter,
where, like the live projection to matching attempts, they sum the matching attempts' figures.
Requests count each row once in every total, through the overlap records. `byHour` is every hour with
rows in chronological order; every other breakdown keeps its 200 top keys and reports the rest as
`truncated`. `coverage` sums `overflowRows`, `foldedRows` and `overlapRowsDropped` over the window's
segments and sets `capped` when any is positive, because a filtered or per-dimension figure may then
undercount. When any segment that may overlap the window has no usable totals, the answer sets
`complete: false` and carries `summary`, `byHour` and every breakdown as `null`, because those rows are
uncounted and a number would look exact; otherwise it sets `complete: true`. A segment without
current totals is listed as pending and queued; one whose build failed
or was refused (`publishing-suspended`) is listed in `coverage.failed`. `coverage.earliestRowAt`/`latestRowAt` are approximate
(`coverage.approximate`) while some totals file has not been read. `tests/usage/usage-archive-route.test.ts`
and `tests/usage/usage-archive-leftovers.test.ts` cover the route and the counting rule.

## Rows route

`GET /api/usage/archive/rows` reads archived rows for a window of at most six hours (not widened,
`until` exclusive) with the same filters plus an exact `workload`, and a `limit` of 1 to
`REQUEST_HISTORY_MAX_PAGE_SIZE` (100, from `src/routing/history/indexer.ts`). A provider, model or
account filter matches a row when any of its attributions matches. Reads run one at a time through
`inArchiveRowsReadQueue` in `src/usage/archive-rows.ts`; a request that waits longer than the
five-second deadline answers 503 `archive_rows_busy` with `Retry-After: 1`, and the request's own
abort signal ends its wait or its read at once. Each segment is read from `archiveSeekOffset` (the
smallest `hourOffsets` offset among hours at or after the hour before `since`'s) and stops at
`archiveStopOffset`: the first-row offset of an hour an hour or more past `until` that lies after
the first rows of every hour the read covers, so one stray far-future row cannot end it early. It
also stops at `limit + 1` matching rows or the deadline. A segment without current totals is never
scanned from its start: it is reported pending (or failed) and its build is queued, and the answer
sets `incomplete: true`. Rows go through the same `requestLogEntryFromPersistedUsage` and
`requestLogDto` projection as `/api/request-history`. `tests/usage/usage-archive-rows.test.ts` covers
the window, filters, the seek and stop, pending segments, the row shape, the limit, a mid-scan
deadline, and the read queue with abandoned and throwing reads.
