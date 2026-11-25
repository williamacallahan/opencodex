# Usage archive reads

The ledger trim in `src/usage/ledger-retention.ts` moves the oldest rows of `usage.jsonl` into
`<config>/usage-archive/<first row UTC>_<ledger inode>-<cut offset>.jsonl` segments and deletes
them after `USAGE_ARCHIVE_RETENTION_DAYS` (31) by mtime; [Dashboard Surfaces And
Usage](dashboard-and-usage.md#usage-accounting) owns that write path. This doc owns what reads the
archive. Segment names, the duplicate rule, and the head-row label that both sides use live in
`src/usage/archive-segments.ts`.

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

The file carries `version` (`ARCHIVE_TOTALS_FORMAT_VERSION`), the segment's `bytes`, the `rows`
counted, `unparsableRows` (rows that fail to parse or to normalize, exceed the 1 MiB row ceiling,
lack a finite `timestamp`, or a torn final row), and `firstRowAt`/`lastRowAt`. A reader serves it
only when the version is current and `bytes` equals the segment's length; anything else is
rebuilt.

A build reads the segment through `scanUsageLedgerCooperatively` in `src/usage/ledger-scanner.ts`
with its `path` option, so archive reads share the live ledger's chunked reads, row ceiling,
torn-row rule, and its yields to the event loop (every 8 ms of row work, and every 1 MiB or 1,000
rows at a chunk boundary). Only the buckets are kept in memory. The file is published through
`atomicWriteFileStreamed` with `recordOwnership: false`, since the archive directory is registered
once. Builds run one at a time in arrival order, and a queued segment is not queued twice.

A trim that publishes a segment queues its build from `src/server/usage-ledger-retention.ts` after
the trim has returned, in a separate async chain: a failed build logs one `[usage-retention]`
warning and never fails or delays the trim. Segments with no current totals (written before totals
existed, interrupted by a crash, or from an older format) are built lazily when a read finds them.

Every place that deletes a segment deletes its totals file with it (`removeArchiveSegment`), and the
31-day prune also deletes any totals file whose segment is gone. A totals file is written after its
segment, so its own mtime is never the retention clock.

`tests/usage/usage-archive-totals.test.ts` covers the trim-time build against a plain sum, the lazy
build, unparsable rows, format and length mismatches, the prune, a failing build beside a published
trim, and the yields.

## Counting each row once

A completed trim publishes the new ledger through a rename, so each published segment comes from a
different ledger file (inode) and no two published segments share a row. The overlaps that remain
are the leftovers `ledger-retention.ts` removes and can fail to remove. `countedArchiveSegments`
therefore counts, among segments with the same inode and the same first-row label, only the longest,
since the shorter ones are byte prefixes of it; and it skips a segment named with the live ledger's
inode and head label (`ledgerHeadLabel`), a trim that stopped before its rename whose rows are still
in `usage.jsonl`. Every archive read applies this rule and reports the skipped count.

## Totals route

`GET /api/usage/archive` in `src/server/management/usage-archive-routes.ts` sits behind the same
management authentication as `/api/usage` and is declared in
`src/server/management/route-registry.ts` as a `deferred-verb` exemption owned by this doc: no CLI
verb reads the archive yet. It validates `since`/`until` with `parseUsageTimeWindow` (required,
`until` strictly later, at most 32 days), rejects unknown or repeated parameters, and widens the
window outward to whole UTC hours, `until` exclusive. `src/usage/archive-query.ts` lists the
segments, applies the counting rule, and sums the buckets of every counted segment whose hour is in
the window and whose dimensions equal every given filter. Parsed totals are cached per totals-file
mtime and segment length, so a repeated query re-reads only changed files.

The route never builds inline. A counted segment that may overlap the window (its totals' first and
last row, or for a pending one its name's first-row time and its mtime) but has no current totals
is listed in `coverage.pendingSegments` and queued for a background build. The answer never
includes rows still in `usage.jsonl`; `coverage.liveLedgerSince` is the live ledger's first timed
row. Each breakdown keeps the 200 keys with the most requests and reports the rest as `truncated`.
`tests/usage/usage-archive-route.test.ts` covers hour widening, filters, the 400 cases, pending and
rebuilt totals, the cap, and the counting rule.
