# Archive slice 3: implementation plan

This is a plan only. I have not touched the worktree, and no code exists yet. It follows the design's slice 3 section plus three boundaries already recorded in the structure docs:

- **`structure/usage-archive.md`:** the per-hour row-end requirement, the deferred catalog listing, and concurrency findings 1b, 5 and the first half of 4.
- **`structure/usage-client-attribution.md`:** live-ledger rewrites are unsupported until catalog generations replace the file.

## What the catalog changes

A trim captures the live ledger L = P || S, where P ends at a complete row and S is the rest, torn tail included. It writes P as a new archive object and S as a new live ledger, and leaves L untouched. Both files are created exclusively under fixed ids in a hub-private store, with the files and their directory synced. Then one catalog transaction switches the live generation and adds the segment.

Before the commit, readers see L live and no new archive. After it, they see S live and P archived exactly once. No rename crosses volumes: `compose.yaml` mounts the ledger (`ocx-state`) and the archive (`ocx-usage-archive`) separately, and both new objects go on the archive volume. The catalog lives at `usage-archive/.opencodex-usage-store/catalog.sqlite`. The legacy segment listing already ignores names that do not parse as segments, and commit 1 tests that it ignores this directory.

## How trimming stays off until commit 8

- Commits 1–7 add code that only does anything on a home already bound to a store.
- Only commit 8 creates a binding, and only at startup on a supported platform with `usageLedgerMaxBytes` set.
- Until commit 8, `enforceUsageLedgerSizeLimit` keeps deferring with `archive-suspended`. Legacy totals publishing stays refused in every commit.
- Every intermediate build therefore behaves exactly like d9e2d3c20 on an unbound home, and any of them can be deployed. Each commit includes a test that an unbound home is unchanged.

## Commits

### 1. Store and home binding, with no caller

Files:
- New `src/usage/archive-catalog.ts`: `openArchiveCatalog` and `readUsageGeneration`. The catalog is a bun:sqlite schema holding the store id, the home identity, the generations (id, object path, dev, ino, birth time), the committed segments, and at most one pending trim.
- `structure/usage-archive.md`, plus the new source's entry in `structure/manifest.json`.
- Test-layout registration in `layout.json` and an expected shard.

Binding is two-phase:
1. Write `<home>/usage-store.json` as `{storeId, state: "creating"}`, synced along with its directory.
2. Create the store directory exclusively: mkdir with no reuse, the parent checked with lstat to refuse redirection, and the dev and ino recorded. Then create the catalog, whose generation 0 is the current `usage.jsonl` identity.
3. Switch the binding to `bound`.

After `bound`, a missing store, a different store id or a different directory identity is an error, never a fallback. A `creating` binding resumes when the store is absent or carries the same id. An existing store directory without a matching binding is refused and left untouched. On Windows, or where syncing the directory fails, it defers before creating anything.

Failing-first tests (new `tests/usage/usage-archive-catalog.test.ts`):
- exclusive creation;
- a pre-existing directory is refused and its bytes are unchanged;
- a symlinked parent is refused;
- a crash after each phase resumes or refuses correctly;
- a mismatched mount after `bound` is an error;
- an unsupported platform defers with nothing created;
- the legacy listing ignores the store directory.

### 2. Totals format v6 with each hour's last row end

Files: `src/usage/archive-totals.ts`, `src/usage/archive-rows.ts`, `src/usage/archive-query.ts` (segment state).

Each hour offset gains `end`, the exclusive end of the last row stamped in that hour, which the builder tracks during its scan. A rows read on v6 totals stops at the window's largest `end`. Versions 4 and 5 keep reading to the segment's end. Nothing publishes v6 yet: the legacy directory stays refused, and the store writer arrives in commit 5.

Failing-first tests:
- in `usage-archive-rows.test.ts`, slice 2's order (an in-window row, rows hours later, then in-window again) on v6 returns both ids and reads fewer bytes than the segment;
- v5 still reads to the end;
- in `usage-archive-totals.test.ts`, the decoder rejects an `end` that is not above its offset or lies past the segment.

### 3. The live generation is the ledger path

Files:
- New `src/usage/usage-generation.ts` owns where the ledger is. `usageLogPath`, `appendUsageEntry` and `currentUsageLogRevision` in `log.ts` delegate to it; this shrinks `log.ts`, which is already over the 500-line limit.
- `src/usage/ledger-scanner.ts`, which uses the default path.
- `structure/usage-client-attribution.md`, which says tools must open the resolved path.

On a bound home, the path is the catalog's current generation, resolved once and cached until a commit bumps a generation epoch. An append to a switched home requires the home-wide writer lease (`src/lib/spend-ledger-owner.ts`). If the store is unavailable, the append fails with the existing counted, rate-limited error and never writes to the literal `usage.jsonl`. The retention status reports the store as unavailable.

Deploying this commit before commit 8 makes it the oldest safe rollback target once the hub has switched.

Failing-first tests (new `tests/usage/usage-generation.test.ts`):
- with a test-made binding at generation 1, appends land in the store file and `usage.jsonl` keeps its bytes and mtime;
- an unavailable store makes the append fail with zero bytes written anywhere;
- an append without the lease is refused;
- an unbound home behaves as before.

### 4. Readers pin one generation per answer

Files: `src/server/management/logs-usage-routes.ts` (`/api/usage`), `usage-archive-routes.ts`, `usage-aggregate-cache.ts` (cache keys), `src/usage/filter-index.ts` (keys only), `docs-site/.../management-api.md`.

Both routes return the same `usageGeneration` token. A request carrying a `generation=` that is no longer current gets 409 `usage_generation_changed`. Each answer reads under the generation it started with, and caches are keyed by generation and object id. On an unbound home the token is the generation 0 identity, so nothing visible changes.

Failing-first tests:
- a commit between the start and end of an `/api/usage` answer cannot mix generations;
- a stale token gets 409 on both routes;
- the token matches across both routes.

### 5. Catalog-backed archive listing and store-private totals

Files: `src/usage/archive-query.ts`, `archive-answer.ts`, `archive-rows.ts`, `archive-catalog.ts`, `src/server/usage-ledger-retention.ts` (background totals pass for catalog segments only).

Catalog segments are listed from the catalog. They are opened by path and then checked with fstat (dev, ino, size) against the catalog record, so a swapped object is a failure and is never served. That closes finding 1b for catalog objects. Totals are built from the open descriptor into a store object created exclusively, then added by a catalog transaction, which closes finding 5. Spans are cached by object id under the pinned generation, which closes the first half of finding 4.

A catalog segment is never ambiguous and never treated as a possible copy of the live ledger. The catalog records P's minimum raw-row timestamp, and legacy segments are then bounded by the lower of that and the verified live minimum. This keeps a legacy segment from being counted beside a restored copy that is now archived in P. No catalog segments exist in production until commit 8.

Failing-first tests (`usage-archive-route.test.ts`, `usage-archive-rows.test.ts`):
- a catalog segment counts exactly once;
- an equal-size swap at its path is reported failed, not served;
- totals built during a swap are not published;
- a legacy segment overlapping P's minimum is withheld;
- the leftovers test still shows the legacy directory byte-identical.

### 6. `prepareTrim`, not wired

Files: `src/usage/archive-catalog.ts`, `src/usage/ledger-retention.ts` (keeps `firstRowBoundary` from `archive-segments.ts`, and restores `copyRange` and the final revision check from before 145db8704).

1. Capture the ledger revision.
2. Choose the cut with the legacy policy: the first row boundary at or after `size − maxBytes`.
3. Record one pending operation with two fixed object ids.
4. Create both objects with `O_CREAT|O_EXCL|O_NOFOLLOW`, after checking the store directory's identity before and after. A collision fails the operation and is never reused, truncated or unlinked.
5. Copy P and S cooperatively in 1 MiB chunks with event-loop yields, computing P's minimum and maximum raw timestamps along the way.
6. Sync each file and the directory separately.
7. On reopen, a pending operation with no commit is marked abandoned, its objects are left for slice 4, and a new operation gets new ids.

Failing-first tests (new `tests/usage/usage-ledger-retention.test.ts` cases from the design list):
- destination collision;
- each sync failing on its own;
- an interrupt after each durable boundary of the prepare;
- an untimed head;
- a changed cut size;
- the old generation stays live after any pre-commit failure;
- an unsupported platform leaves all bytes alone.

### 7. `commitTrim` and the switch, not wired

Files: `src/usage/archive-catalog.ts`, `src/usage/usage-generation.ts`, `src/server/usage-ledger-retention.ts` (`invalidateLedgerReaders` on a committed generation change).

The final section is synchronous, so no in-process append can interleave:
1. Recheck the captured source: same identity, size at least the captured size, and the captured range's boundary digest unchanged.
2. Copy the bytes appended since the capture into S and sync S.
3. Commit the catalog transaction from the expected old generation to the new generation plus the segment.
4. Bump the epoch and invalidate readers.

After an uncertain commit, reopening reads the catalog first, and a retry resolves the same pending operation.

Failing-first tests:
- an interrupt at each boundary, including commit-succeeded-before-acknowledgement;
- a fresh-process reopen through a worker that compares the ordered row occurrences and the raw bytes of P || S with the captured ledger (identical rows, unknown fields, torn suffix);
- an append during the prepare lands in S;
- a stale reader holding the old generation finishes on it and its next request gets the new one.

### 8. Enable

Files: `src/server/index.ts` (about 3 lines; it is at 876 of its 893-line cap), `src/server/usage-ledger-retention.ts`, `ledger-retention.ts`, `src/lib/config-ownership-removal.ts` (keep the store), `compose.yaml` (comment only), `structure/usage-archive.md` ("Suspended trim" becomes "Catalog trim"), `docs-site`.

At startup, a supported platform with the limit set binds the home. An append that crosses the limit schedules one single-flight background trim, prepare then commit. The status reports enforcement as `active` or `suspended` with a reason: unsupported platform, store unavailable, or foreign store directory.

Failing-first tests:
- `usage-archive-leftovers.test.ts`: a trim over the limit now commits a catalog segment while every legacy byte, link and operator file stays unchanged;
- `config-ownership-uninstall.test.ts`: the store and the live store file survive uninstall twice;
- a trim with the limit unset does nothing.

## Live hub rollout

Before deploying commit 8, I record:
- the hub's `usageLedgerRetentionStatus`: the limit, the current ledger size and available free bytes;
- that the archive mount's st_dev differs from the home's;
- sha256 of the 3 legacy segments and their totals.

Commits 1–7 can be deployed whenever they land, since none of them binds the home.

The first boot on commit 8 runs in this order:
1. **Binding.** It completes in milliseconds. A foreign `.opencodex-usage-store` would make it refuse and report; the trim stays suspended and nothing is written.
2. **First trim.** The ledger is over the limit, so the trim starts about a second after the first append. It writes P (the amount above the limit) and S (about the limit) into the store: roughly a ledger-sized copy, against hundreds of GB free. `usage.jsonl` is kept whole and read-only from then on; slice 4 reclaims it.
3. **Commit.** After the commit, the live ledger is the store's generation 1.
4. **Stale index.** The index already records a different source inode, so the verified minimum is unknown until it rebuilds. The next archive read that withholds a segment for that reason schedules a refresh, and the identity mismatch makes it a full rebuild of the new live ledger (about the limit) rather than of the original ledger.
5. **Archive answers.** Answers covering P report it pending until its v6 totals build finishes in the background. The 3 legacy segments are only read.

Until slice 4 lands, each later trim leaves its retired live file behind: about one limit's worth of bytes per trim. At about 0.47 GB of growth per day, that is weeks of headroom.

Rollback:
- **Before the first commit:** rolling back to any build is safe. Generation 0 is still `usage.jsonl`, and older builds ignore the binding and the store.
- **After the first commit:** roll back only to commit 3 or later, all of which resolve through the catalog. A build at d9e2d3c20 or earlier would append to the retired `usage.jsonl`, which the design forbids.
- **To stop trimming without a rollback:** unset the limit. The hub stays on its current generation.

## Measurements on the 1 GiB clone

- **Prepare** at the hub's append rate and at 10x: elapsed time, CPU, bytes read and written, and the longest event-loop gap on a 5 ms ticker.
- **Final synchronous section:** the size of the appended delta, each sync's latency, the catalog commit's latency, and the total stall.
- **Equality:** P || S matches the captured bytes by sha256, and the row occurrence order matches.
- **First boot:** binding time.
- **After the commit:** v6 totals build of P (elapsed time and longest gap), filter-index rebuild of S, first archive answer latency, and bytes a first-hour rows read takes with v6 hour ends versus reading to the segment's end. The segment-end case is the one that hit the 5 s deadline at about 465 MB in slice 2.
- **Recovery:** reopen time after a crash injected at each durable boundary.

## Defaults I will use unless you rule otherwise

- **Store unavailable after binding:** the append fails with the counted error and is never written to a fallback. Refusing requests before dispatch stays slice 4's admission work.
- **Cut policy:** keep the newest `maxBytes`, as the legacy trim did.
- **Commit 4's 409 token:** the GUI does not send it yet, so only callers that pass `generation=` can get the 409.