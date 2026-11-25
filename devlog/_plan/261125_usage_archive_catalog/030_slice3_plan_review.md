# Slice 3 plan review

## Verdict: REJECT

Keep trimming suspended. The plan is not ready to implement because intermediate builds could change behavior for unbound homes, rollback can write into retired data, crash recovery and durable commit semantics are underspecified, and the serving path can still perform unbounded work. The required changes are:

1. **Preserve unbound behavior at every intermediate commit.** Retain v4/v5 decoding, defer the generation-token wire change, and test every intermediate revision against an unbound fixture.
2. **Enforce a durable format floor outside the image.** The deploy and startup supervisor must prevent older builds from appending to retired `usage.jsonl`. Protect that retired path and qualify one pinned rollback digest.
3. **Define binding authority at every crash boundary.** Replace the marker atomically and sync it; probe durability on the actual mounts. A malformed bound state must never be interpreted as unbound.
4. **Use one durable trim state machine.** Keep fixed operation ids under the lease generation. If commit acknowledgement is uncertain, pause appends and consult the catalog before releasing the fence. Never recreate an object whose commit succeeded.
5. **Prove source bytes under an append-only writer contract.** Frame the torn suffix so a syntactically valid JSON fragment without LF is never counted as a complete row.
6. **Refuse new work before dispatch when its usage record cannot be retained.** Use bounded reservations and a durable replay queue; pull this admission work forward from slice 4.
7. **Keep expensive trim work off the serving loop.** Move boundary search, bulk I/O, syncs and catalog commit off that loop. Cap the final delta and specify pass/fail event-loop stall budgets.
8. **Correct cadence and capacity accounting.** Trigger at the ceiling and trim below it (the old trimmer targeted 90%). Budget both mounts and the shared backing pool, cap retries, and back up the binding, catalog and segments as one set.
9. **Pin one catalog snapshot for each complete read.** Keep it pinned across every read, page, retry and background publication. Passive reads never initialize or write. Return `409 usage_generation_changed` before work when the requested generation is stale.
10. **Preserve archive trust across every trim.** Combine coverage across all catalog prefixes and retain full revision checks.
11. **Preserve uninstall history and report incomplete totals.** Preserve history on uninstall before binding, and mark live-only totals incomplete once archived data overlaps the requested window.

## Why slices 3 and 4 were deferred

With trimming suspended, no usage row is deleted, which satisfies the 30-day retention order. The ledger grows about 0.47 GB per day against hundreds of GB free, so the current design leaves substantial headroom while the slice 3 and 4 requirements are resolved.

## Alternative ideas (non-binding)

1. Archive byte ranges of the retired ledger `[0, cut)` instead of copying P; this saves the initial copy but duplicates retained suffix bytes and requires range-aware totals and scans.
2. Bound disk-full retries: reserve worst-case space, back off, and remove objects from never-committed operations only after reopen proves they were not committed (the plan leaves every failed copy for slice 4).
3. Inject crashes inside operations (short write, delta catch-up, fsync, SQLite commit), not only at durable boundaries; partial objects must remain invisible and retries idempotent.
4. Byte-limit trimming does not guarantee 30 days during bursts; base deletion eligibility on durable sealing/arrival metadata and test clock skew.
5. Add a rollback guard by atomically replacing retired `usage.jsonl` with a symlink to a tombstone directory, so an older build's append fails with `EISDIR`; test that rollback fails closed.
