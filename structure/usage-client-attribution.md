# Usage client attribution

`src/usage/client.ts` defines the closed client-attribution roster and recognizes bounded
request-header signatures without retaining the header values. HTTP request contexts in
`src/server/index/` and the Responses WebSocket handshake carry that observational label through
`src/server/request-log.ts` (with attempt send/finish and usage-aggregation helpers in
`src/server/request-log-attempt-usage.ts`) projection and `src/usage/log.ts` normalization. Older rows without
the field remain absent, while invalid present values become `unknown`. Combo child adoption
cannot replace the inbound label. The label is caller-supplied evidence, not an authorization
decision. New direct log writes without a valid client record `unknown`; reading an older row
without the field still preserves its absence. The live log detaches mutable caller rows so a
later caller mutation cannot replace a recorded client with raw text; frozen normalized rows with
only data properties can retain their identity. Client values and bounded failure details are
captured before error projection, and normalizing a new write also preserves any existing
attempt-loss marker.
`tests/usage/usage-client-attribution.test.ts` and
`tests/usage/request-log-normalization.test.ts` cover those boundaries.

The label is computed once per admitted request, by `computeRequestAttribution` in
`src/server/request-attribution.ts`, and reaches every log context through `admissionFields`; no
route classifies the headers a second time. Pi (`pi/<version>`), Amp (`OpenAI/JS` plus
`X-Amp-Thread-Id`) and the Antigravity CLI (the hub's `/agy/` mount, since agy sends no identifying
header) are recognized beside the existing signatures. The same pass records the harness's own
session id from the first native header present (`X-Claude-Code-Session-Id`, `X-Amp-Thread-Id`,
`X-Opencode-Session`, `session_id`, `session-id`) as `harnessSessionId`, read from the original
headers before any session rewriting, and its agent or thread id as `harnessAgentId`
(`X-Claude-Code-Agent-Id`, else a Codex `thread-id` that differs from the session). Both must pass
`safeCallerSessionId`; a failing value is dropped, never shortened. agy sends no identifying header, so
the `/agy` pass-through reads its session during the one walk over the decoded body that also finds the
routing `project` (`scanAgyBody` in `src/server/agy-passthrough.ts`; it descends into `request` and
`request.labels` instead of skipping and re-reading them, and stops once the call's fields are found):
`request.labels.trajectory_id` when a canonical UUID, else a decimal `request.sessionId` (Cloud Code's
leading `-` accepted and dropped), else a `writeTrajectoryAcls` call's `trajectoryId`, with
`request.labels.cascade_id` as the agent only when `root_cascade_id` is a different canonical UUID
(compared case-insensitively). `withBodyHarnessSession`
records them on the hub's own row only (workload `antigravity:<session>`); the forwarded bytes are agy's,
and `project` and the per-request ids are never recorded. `metadata.user_id`,
`x-codex-installation-id` and the agy body's `project` are never read for this. The row's
`workload` is the declared `X-User-ID` (`workloadSource: "declared"`), else
`<client with hyphens>:<harnessSessionId>` (`harness`), else the hub's `<product>:via-opencodex`
(`hub`); a sessionless agy call carries a fixed per-class operation in that label instead
(`antigravity:monitoring`, `:account`, `:quota`, `:models`, `:analytics`; see the
[agy pass-through](transports/agy-passthrough.md#calls-that-name-no-session)). `tests/usage/request-attribution.test.ts` covers each harness's header set.
A provider row whose `forwardClientHeaders` lists `x-user-id` or `x-lgw-cache-key` is an LLM gateway row:
`forwardableClientHeaders` in `src/lib/provider-client-headers.ts` sends it that admitted attribution's
`workload`, its declared `conversationKey`, its validated `clientHost` and the `clientAddress` the hub
observed. A row listing `user-agent` gets the incoming header, else the attribution's recorded (sanitized)
`userAgent`, which an internal hop's rebuilt headers no longer carry. The attribution reaches every send through `IncomingMeta.attribution` (Responses dispatch, tool
loops, compaction), `restoreResponsesClientMetadata`, the native Chat builder and the strict Messages lane,
and the Chat and Messages internal hops carry the same workload through `requestWorkload`, so no send derives
it again from rebuilt headers. The hub never invents an `X-LGW-Cache-Key` for a gateway row, because a
gateway may route prompt caching on that header. `tests/responses/gateway-row-attribution-live.test.ts`
proves each lane, the absence of workload, cache key, machine name and caller address on rows without the
opt-in (which still receive the caller's `User-Agent` on Responses, as before), and byte-identical bodies.

`src/usage/source-filter.ts` defines app and device filters. The usage report a linked client reads
(`src/remote/hub-usage.ts`) shows `LINKED_CLIENT_FOLDED_CLIENTS` (clients newer than its roster) as
`unknown`, so `src/server/hub-usage.ts` sets `linkedClientRoster` and that report's `client=unknown` selects
them too, in `matchesUsageSource` and the filter index alike; the hub's own dashboard keeps them apart. A Codex filter includes recognized
Codex clients and legacy Codex-surface rows; it reports the latter as a separate unclassified
count, without assigning a client subtype. A no-key filter means the stored key ID is absent,
including pre-attribution and environment-admitted rows; it does not prove physical origin.
`src/usage/summary.ts` applies filters before aggregation and retains range-aware unclassified
counts. When provider/model filtering removes combo attempts, it recomputes the retained request
status using the same status facts as model and provider counts, excluding usage-less attempts
that never sent or were answered locally. Model and provider attempt counts use the same eligibility
in unfiltered reports; unchanged attempt sets retain the recorded row status.
`src/server/management/usage-aggregate-cache.ts` keys retained aggregates by both source
dimensions, and `src/server/management/logs-usage-routes.ts` validates the complete query before
special projections. The device inventory requires a dashboard session and refuses child scope.
`src/usage/filter-index.ts` reads candidates for those dimensions and for provider, model,
API-key and window bounds. `src/usage/filter-index-candidate-plan.ts` builds the shared SQL for
candidate reads and plan diagnostics. The client, surface and admission columns mirror `source-filter.ts`
exactly, so the index can over-select but never reject a row the accumulator would keep. The
accumulator re-applies the authoritative filter to every candidate, and whole-ledger invalid and
oversized diagnostics come from the index rather than from the selected rows.

The candidate index is a disposable SQLite projection (`usage-filter-index.sqlite`) that records each
complete row's byte offset, the fields above, and one attribution per provider/model the row can
match. `src/usage/ledger-scanner.ts` supplies both halves: `scanUsageLedgerCooperatively` reports the
row offset during ingest, and `readUsageLedgerRowsAtOffsets` re-reads only the selected rows under the
same identity, row-ceiling and torn-suffix rules. The first filtered query after the index is missing
or invalid pays one cooperative full ingest; appends ingest only new bytes, and every later filter
reuses the projection. Candidate offsets are selected and consumed in bounded keyset pages, with a
timer yield between pages; each page rechecks the published generation before it is read, so broad
filters neither retain the complete offset set nor monopolize the event loop. A replaced, truncated
or same-size rewritten ledger rebuilds it, a write
observed during a row read re-verifies the selected bytes before publishing them, and a recorded
offset that no longer frames a complete row drops the projection instead of serving a partial
answer. `usage.jsonl` stays authoritative and is never truncated or rewritten.

The archive reads use the same projection for one more fact: the live ledger's earliest finite row
timestamp (`verifiedUsageLedgerMinimum`), which bounds where the archive's coverage ends. It is the
published generation's `min_timestamp` meta, accepted only when `generationValidated` holds and the
recorded ledger revision is exactly the current one; reading it writes nothing. Both it and the
passive candidate read decline a generation whose ledger is the same file but shorter than before,
or as long but different. They mark the generation in memory only, with one ticket per change, and
the next writer-owned refresh records the mark and rebuilds. Every read keeps a live observation per
index path (`liveObservations`), whether or not it issued a ticket. Before any SQLite access
(`observeLiveRevision`), the first sight of the file sets a baseline, same-file growth advances it,
and a shrink below it, or a same-length rewrite, issues a ticket at once. A truncation a process
sees while another connection holds the index locked is therefore kept, even in a process whose
earlier reads only saw the full file. Every sample, growth included, stays unresolved until a
metadata comparison, since a file longer than this process last saw can still be shorter than
another process indexed it, and a later, larger EOF never erases it. After a successful metadata read
(`observeAgainstIndex`, also in `refreshOnce` before it chooses an append), the unresolved sample and
the live revision are compared with the persisted source revision. A sample shorter than it
declines that generation, which covers a process whose first read happened under the lock. A ticket
issued before the metadata read is bound to that generation without a second ticket, and a declined
generation issues no more. The published generation keeps describing the longer file until its
rebuild publishes, so a fresh ticket from every read meanwhile would fail that rebuild's
publication fence each time. Growth during the rebuild therefore issues nothing, while a genuine
second shrink issues a new ticket and retires the staging. A regrowth that restores the last 64 KiB
before the indexed
boundary would otherwise pass the append's boundary digest and keep the old rows and minimum. An
archive read never ingests to answer. When the minimum is unverified, an active read that finished
within its deadline, and withheld an archive segment for that reason, calls
`scheduleUsageFilterIndexRefresh`, which starts one shared refresh per home on a later
turn. That refresh uses busy timeout 0 and retries on timers, so SQLite's synchronous busy wait never
holds the event loop. It joins no running ingest and does nothing unless the index is still behind. A
passive read schedules nothing (`structure/usage-archive.md`).

Each candidate page is one keyset statement per branch, and every branch index is ordered
`(generation, <equality prefix>, byte_offset, ...)` so its own `ORDER BY byte_offset LIMIT` is
served by the index walk. This is why the window filter uses `idx_usage_rows_window` rather than a
timestamp-ordered index, why a lone provider or model pages from
`idx_usage_attr_{provider,model}_offset`, and why the Codex roster is expanded one label per branch
instead of `client IN (...)`: each of those alternatives would otherwise force SQLite to sort the
whole match set on every page, which made a deep page cost seconds on a large ledger -- more than the
streaming scan the projection exists to replace. The pager keeps one fetch cursor and one surplus
buffer per branch, so merging the branch heads returns one ascending, de-duplicated page bounded by
`CANDIDATE_PAGE_SIZE` while each candidate is fetched about once; a branch that fetched past what
the merge needed carries that surplus into the next page instead of reading it again.
`tests/usage/usage-filter-paging.test.ts` asserts that no paged branch plan carries a temp B-tree,
and pins branch-cursor order, the page bound, and the corrupt-projection rebuild.

The index keeps its `-wal` and `-shm` sidecars after the last connection closes
(`SQLITE_FCNTL_PERSIST_WAL` on every connection that can write, set only once the file classified
as this projection). The writer runs `PRAGMA wal_checkpoint(TRUNCATE)` before it closes and a
`journal_size_limit` is set, so a clean close leaves the kept WAL empty; while a reader in another
process pins it, the WAL keeps its frames until a later writer's checkpoint. Creation registers the
sidecar names up front; an existing projection whose names were never recorded (a 0-byte file left
by a crash before the first open) registers them on the first open after they exist. SQLite's
default deletes them on the final close, which changed the config directory on
every filtered query. On Windows a changed
config directory re-runs its ACL harden, whose inherited-ACE rewrite moves `usage.jsonl`'s
ChangeTime, and both the usage aggregate and this index then rebuild from the whole ledger.
`tests/usage/usage-filter-index.test.ts` asserts that filtered queries after the first leave the
directory's entries and times unchanged.

The reader also receives the snapshot's revision, boundary offset and trailing digest. When the
revision moved since the snapshot it re-verifies that boundary before trusting any offset, so a
rewrite between the index refresh and the row read becomes a rebuild rather than a silently
different row set; a candidate that no longer normalizes is reported unreadable for the same reason.
At an unchanged size a moved revision is always a rebuild, because the file cannot have grown: the
trailing digest is only the append contract for a file that grew, and a rewrite earlier than that
window accompanied by growth remains the base aggregate's documented limit. An empty selection still
performs this validation, so a query with no candidates cannot skip it, and a retained projection
that reports "unchanged" validates the ledger the same way before returning.

Growth is measured against the physical file size the snapshot recorded, not the processed byte
boundary. A torn final row leaves the file larger than the boundary without being new content, so a
snapshot taken with a torn suffix has a physical size above its cursor; a later same-size rewrite is
therefore a rebuild rather than an append, while an unchanged torn suffix settles as "unchanged"
without re-reading the ledger.

Rows belong to a generation; a small registry lists every generation and meta names the one
published. A rebuild stages a fresh generation under a writer lease and publishes it in one short
transaction fenced on the generation and cursor it started from. That transaction switches the
generation and ends the writer's lease and deletes no rows: the replaced generation's registry row,
now without a lease, is its durable retirement record, and a reader only ever sees one complete
generation. A
crash before publish leaves the previously published generation complete. An append writes into the
published generation and publishes its cursor, digest, counts and span in the same transaction,
fenced on the cursor so a stale append cannot regress it. Each candidate page re-reads meta and
selects inside its own short read transaction, and a generation or schema change aborts the read --
the per-page recheck described with the paging contract above. A published
generation that claims rows it no longer holds is rebuilt rather than served as a complete zero, in
both the active and the passive read.

The index judges an append from its own recorded size and boundary digest, so it cannot see a
shrink another cache observed if the file then grows past the indexed size again. Whether the
published generation may be extended or served is therefore recorded in the index database, so a
restarted process, a peer process and a passive reader reach the same verdict. A writer-owned path
that observes a destructive change (`src/usage/revision-observation.ts`) increments
`source_invalidations` in the index of that ledger's own home; a full ingest records the count it
started under as the generation's `validated_invalidations` inside its publish transaction, which
is refused, and the staging retired for a retry, if the count moved or the live file changed
identity. A generation is valid while the two counts are equal: any process adopts it, and only an
invalid one is replaced. An invalid generation is never extended or served: the active refresh
ingests in full, the active reader and every candidate or projected-row page re-check the counts in
their own read transaction (a page of an invalidated generation throws rather than return partial
counts), the published-generation lookup behind cached filtered and picker answers returns no
generation, an extend-only refresh and `usageFilterIndexExtendable` refuse, and the passive read
returns no answer. A passive read (a Remote Link request, and the background work it starts)
writes nothing to the index: a destructive change it observes, in the passive index read or in any
usage cache lookup, is only marked in memory, which declines the generation in that process, and the
next writer-owned index refresh records the mark in the database. Until its
increment commits (the write uses busy timeout 0 and retries with backoff), the observing process
also declines the generation itself.

Rewriting the live `usage.jsonl` in place is unsupported. Nothing in the product does it: one
appender writes the ledger, and the trim that could shorten it is suspended. Truncation and
replacement by a different file are detected from the file's identity and size wherever they are
read. An in-place rewrite that keeps the same file and the index's boundary digest is detected only
on a best-effort basis, and only by a process that saw the larger file first: an increment that
process could not commit before it exited is lost, and another process's retained answers do not
learn of it. The usage archive catalog's generations (slice 3) replace the live file instead of
rewriting it, which removes this case.

A staging generation registers itself and its writer pid before its first row. A failed attempt
ends its own lease in a finally; a process that dies without running it leaves a lease whose pid is
no longer alive. Retired, failed and abandoned generations are all removed by one background
reclaimer (`scheduleRetiredGenerationReclaim` in `src/usage/filter-index.ts`), scheduled after a
publish or a failed attempt and whenever a refresh notices a leftover; neither publication nor a
refresh deletes rows itself. Deleting a whole generation in one write transaction stalled the event
loop for seconds (1.7 s, 1.3 s and a 1.3 s commit on a 725,946-row index), so the reclaimer removes
at most 2,000 rows per table per transaction in primary-key order (for attributions the whole
`(byte_offset, provider, model)` key, since one ledger row can carry thousands), commits, and yields a
timer turn before the next batch; the registry and lease rows go with the last batch. Another
writer's lock fails the reclaimer at once, from its first schema read on (it opens the index with
busy timeout 0, so the event loop never waits on it); the
reclaimer closes its connection and tries again after a backoff from 50 ms capped at 2 s, so the
backlog drains after the lock is released without another index read. A generation whose writer
is alive is never reclaimed. The registry row and the lease commit together, and every batch re-reads
the published generation and the lease inside its own write transaction before deleting, so a
generation that registered, or was published, after the candidate check is never treated as retired;
a live writer's staging is left alone and its own publish fails the fence and retries. A lease whose
generation is no longer registered cannot belong to a live writer and is pruned.

Opening the projection is safe against a concurrent first open. The busy timeout is set before the
first read, and a classification that meets another writer's lock rethrows the busy error into the
caller's retry; it never reads as a foreign file. A fresh file gets its whole schema in one
`BEGIN IMMEDIATE` transaction that re-classifies under the lock, so no process can observe the meta
table without the data tables, and a schema another process committed first is adopted and
verified. An outdated schema is recreated only after re-checking it under the same lock, so two
processes that both saw it stale cannot drop each other's fresh tables.

The projection is created 0600 through the shared private-SQLite path. It and its WAL and
shared-memory sidecars are registered for uninstall when this module creates them, or, beside an
existing file that classified as this projection, once they appear; a file at that path that is
not this projection is never registered or modified. A passive management read opens an existing
projection read-only, requires this projection's full table set rather than a coincidental meta
table, and only uses it when it is current for the exact ledger revision; otherwise it streams,
and it never creates, writes or registers anything. The passive read makes a single attempt and
degrades to the streaming scan on any error; it does not retry. Only the active index read
(`readUsageFilterCandidates`) retries contention on three short delays (85 ms, plus SQLite's
250 ms busy timeout per attempt) before streaming, and runs a
foreign or unsafe open and a rebuild-required read through three short delays before degrading.
Any other
index-side failure -- unwritable home,
full disk, a corrupt file -- falls back to the authoritative streaming scan
instead of failing a request the scan can answer; a failure to read `usage.jsonl` itself is
propagated. A `UsageFilterIndexPageError` from a `src/usage/filter-index.ts` page read clears the
retained filtered aggregate, then retries the authoritative streaming scan under
`withFilterIndexRetry` (`MAX_FILTER_INDEX_ATTEMPTS` attempts) in
`src/server/management/usage-aggregate-cache.ts`: only a concurrent ledger replacement or an
aggregation-input change is retried, the unusable index is never re-entered, and unrelated ledger
I/O failures still propagate. A nonselective filter (`client=all`, `device=all`, no provider/model/key) still reads
every row in its window; `candidateRows` counts the rows selected and normalized for that call and
`scope` says whether that is the whole candidate set or only the appended suffix, not how many SQL
index entries were examined. `tests/usage/usage-filter-index.test.ts` asserts candidate counts against the whole
ledger, the append cursor, crash and two-writer generation handling, passive and fallback behavior,
row tolerance, query plans, and parity with a full-scan oracle.

`src/usage/app-breakdown.ts` maps only the closed recorded-client roster to report app categories:
the three Codex variants share one category, absent client fields are unclassified, and invalid
present values are unknown. `src/usage/summary.ts` accumulates per-app request, token and price
coverage within each date/surface partition after source and model projection. Clone and retained
memory accounting include these counters; filtered snapshot projection replaces them with the
filtered totals. `src/remote/hub-usage.ts` accepts the optional bounded app list while stripping
undeclared fields, and the hub computes it only for the authenticated key. Tests in
`tests/usage/usage-client-attribution.test.ts`, `tests/usage/usage-aggregate-cache.test.ts` and
`tests/server/hub-usage.test.ts` cover classification, projection, append and hub scope. The GUI
validates app categories against the backend roster, and `gui/tests/usage-app-breakdown.test.tsx`
checks that the source picker exposes the same categories apart from its all-app option.

The unconfigured-key filter compares configured-admission rows to a captured snapshot of all
currently configured key IDs; it does not prove historical deletion or device identity. Its
snapshot is included in filtered-cache identity. `src/usage/source-facets.ts` folds the bounded
30-day app/device counts in one pass, retaining individual counters only for configured IDs;
its legacy count is the unclassified subset of the Codex app option for the selected device.
Unselectable padded IDs remain in the configured membership set but are omitted from individual
rows and counted separately, so they neither hide valid choices nor become unconfigured traffic.
`src/server/management/usage-source-facets.ts` folds them from the candidate index's own columns
(`usage_rows`: timestamp, client, surface, admission kind, key id) in pages of at most 2,000 physical
rows by offset against one published generation (`nextIndexedRows` in `src/usage/filter-index.ts`),
re-checking it between pages, applying the window in the accumulator, yielding after every page even
one with no row in the window, and reading no JSONL row, since ingest already validated those rows. It keeps at
most four completed answers for 15 seconds, keyed by home, filter, key inventory and time zone and
tagged with the index generation, the last observed ledger revision and the captured window; a hit
checks the published generation from index metadata alone, the revision (growth reuses, a shrink or
same-length rewrite never does) and that local midnight has not moved the window start. A request
never folds: it answers from that cache or registers the fold in the cold-rebuild slot
(`src/usage/cold-rebuild-slot.ts`) and answers 503 with `Retry-After` at once, as it does when the
index is unusable. The session-only facets
route rechecks session and inventory after scanning, fails closed on changes and sets no-store.
Expiration after an authorized scan starts returns 401 so the dashboard clears session-scoped
results; an initial credential lacking the required dashboard scope still receives 403.
Snapshots exceeding 1,024 configured keys, 256 characters per ID or 65,536 total ID characters
are refused rather than truncated; retained accumulator estimates include the snapshot and cache
identity. Invalid ledger rows mark unconfigured reports incomplete without claiming they were
oversized. `tests/usage/usage-aggregate-cache.test.ts` covers append and snapshot identity.

`src/server/index/link-management.ts` binds new source-filtered relay reads to the admitted link
key. Source-filtered snapshot bounds cover only matching rows. `src/client/link-management-relay.ts`
requires JSON, a byte-limited body with a deadline, and the Home's matching source echo; it refuses
filtered HEAD reads, whose empty body cannot confirm the scope. Requests without these dimensions retain the previous relay behavior and are not
newly scoped by that rule. `src/server/hub-usage.ts` binds a client-filtered data-plane read to its authenticated
key and emits a safe scope echo; `src/remote/hub-usage.ts` projects it without key IDs, and
`src/client/hub-client.ts` rejects a missing or mismatched echo.

## Anthropic pool account tag

Anthropic pool attempts carry no `accountLogLabel`; the pool folds the account into the logged
provider (`anthropic-p<hex6>`, `formatAnthropicProviderForLog`). `anthropicAccountTag` in
`src/providers/label.ts` exposes that same suffix as a separate `accountTag` field and mints no
new identifier. `sealRequestAttemptIdentity` (`src/server/request-log-account-rotation.ts`)
derives it from the attempt's frozen provider, so a failover split carries the next account's
tag; the row's tag comes from the row's provider in `src/server/request-log.ts`. `src/usage/log.ts`
and the request-log hydration keep only `p` plus six lowercase hex digits and drop anything else.
Per-account summaries still key on `accountLogLabel` and ignore the tag
(`tests/usage/request-log-anthropic-account-tag.test.ts`).

## Prompt cache reuse

`src/server/prompt-cache-outcome.ts` emits `reuse_schema=1` with a process epoch, expectation,
reason and coverage alongside the existing usage fields. `src/server/prompt-cache-observer.ts`
binds the final native physical send to its response and supplies its completed, merged usage;
opening counters cannot replace later cache counters or determine final lost tokens. Final usage also
reconciles the ledger anchors created by that physical send, preserving their original prefill readiness
and dispatch-based expiry. A reader finishing before its matching predecessor finalizes reports
`unknown/predecessor_pending` without expected or lost tokens; prefill alone does not authorize a
loss denominator. Missing, contradictory or unattributable final measurements leave the affected
prefix unknown rather than retain or select an opening denominator. Failed sends,
local answers and combo-parent summaries do not supply expected-token denominators. Combo children
are excluded before capture. Translated transports and relays with hidden accounts remain explicitly
unknown; relay detection uses the matching `nativeCacheProvider` and `sentProvider` context fields.

The native observer records dispatch identity before sending and readiness from a valid complete
`message_start`, or a valid buffered Messages result. Non-strict prefill is observed before OAuth
name restoration and model echo, so a qualified client selector cannot hide or invent a model mismatch.
Configured authentication headers remain unknown; OAuth identity includes the credential generation.
Native completion releases captured observations even when no outcome log is emitted. Only a confirmed
hashing job can outlive that completion, until its worker reply or bounded deadline releases it.

Response chunks are forwarded before observation. Validated prefill yields to the event loop before
copying or starting the resident `src/server/prompt-cache-observation-worker.ts`. Copying yields between
256 KiB binary chunks or 32,768-code-unit string segments without splitting surrogate pairs. The worker
concatenates transferred chunks and hashes them. Admission reserves the source, transferred chunks,
worker concatenation and bounded scratch within the ledger's pending budget; insufficient capacity
reports `worker_backlog` without rejecting the request. Neither forwarding nor final logging waits for
hashing: a fast buffered reply can report `hash_unavailable` while its confirmed prefill subsequently
becomes evidence for a later request. A walk that throws inside the worker marks only its own turn
`worker_failed`. A worker fault (its `error` event, a failed spawn or post, or 10 seconds without a
completion while jobs are outstanding) terminates the worker and marks every pending turn
`worker_failed`. Completions are read from a counter the worker shares with the main thread, so a
reply still queued behind a stalled main loop counts. The window starts when a job is posted, not
when copying starts, and a 250 ms check that fires more than 250 ms late restarts it: on a
CPU-starved hub, main-thread stalls of up to 5.7 seconds had faulted a worker that answers in
milliseconds. Lag never extends a window past 60 seconds without a completion, so a hung worker on a
chronically lagging hub still faults. New
sends stay `worker_failed` for a doubling backoff from 1 second up to 5 minutes, which resets on the
next successful reply, and the next send after it rebuilds the worker. Each fault logs its path and
detail without prompt bytes. A latch for the observer's lifetime blinded production cache alerts
within 52 to 82 minutes of every hub start.

`src/server/prompt-cache-prefix.ts` owns byte-preserving position identities and unsupported shapes.
`src/server/prompt-cache-reuse.ts` owns dispatch-time history, bounded pending memory, expiry and
measured anchors. Each prefix indexes the retained records directly, in account and insertion order;
classifying a send does not look each historical version up again by ID. Exact credentials share their observed cache namespace; different credentials
share only with evidence from `src/routing/identity-domains.ts`. With no workspace evidence a
credential change reports `unknown/credential_changed`, not a proven cache-domain move.
Expected and per-event lost tokens require a reachable, unexpired measured anchor. The
`tests/usage/prompt-cache-reuse-paths.test.ts` boundary proves native byte preservation, prefill
observation, answering-send attribution and exclusions; the two adjacent cache tests own hashing
and ledger timing semantics.
