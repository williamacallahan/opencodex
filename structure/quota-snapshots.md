# Account Quota Snapshots

`src/codex/quota.ts` and `src/providers/account-quota-disk.ts` persist last-known account
quotas for restart recovery. The Codex snapshot also carries bounded observation history
and separately identity-bound main-policy evidence; provider snapshots include Kiro's
identity-bound exhaustion verdicts and Anthropic's private credential-generation digest in the
existing row snapshot. Anthropic hydration strips that metadata from public quota bars, keeps its
probe clock at zero, and treats missing or mismatched ownership as historical rather than current
routing evidence. Only matching current ownership is persisted. Existing expiry rules still apply.

## Automatic Pool Luna Reserve

Pool WHAM reads opt in with `x-openai-codex-luna-reserve: 1`, including a 401 replay.
`src/codex/pool-reserve.ts` reuses the Reserve grant predicates and stores an independently timed
`Luna Reserve` custom window with its own `observedAt`. A non-granting response retracts that window
without changing the ordinary weekly bar. The existing account DTO, persistence and dashboard carry it.
Only automatic stored-account requests for `gpt-6-luna` may use it. Reserve is Luna-only while
ordinary quota is shared with Sol and Astra, so fresh Reserve below 100% wins, then ordinary
capacity, then previously consented fresh credits, then the existing refusal. A thread bound to a
seat that still has ordinary capacity keeps Luna there.
The existing selector still enforces pause, plan, credential, failure-window and account-wide holds.
Reserve uses its independent quota scope; shared Responses serialization changes only the wire model
to `gpt-reserve` for HTTP and WebSocket. Ordinary headers cannot renew its five-minute WHAM observation,
and Reserve headers do not overwrite ordinary quota. Materialization and physical sends recheck the
grant, including after credential-refresh context copies. Explicit Desktop Reserve and native-main
authorization remain separate and unchanged. Coverage: `tests/codex-integration/codex-pool-reserve.test.ts`.

## Bounded write deferral

Both writers coalesce updates with a 250 ms idle debounce and a one-second maximum
deferral from the first pending update, measured on the monotonic clock. Continued
observations cannot postpone the scheduled write beyond that deadline; event-loop delays
and disk failures remain best-effort. This uses the same maximum deferral as the quota
reset ledger in `src/quota/reset-seen-store.ts` without making producer calls write synchronously.

The timer snapshots the latest accepted state and resolves the configured home when it
runs. Completion, failure, and cancellation reset the deadline. Clearing all Codex quotas
cancels its pending snapshot; clearing one account persists the remaining rows with the
existing deadline. Provider cancellation discards the pending row and verdict callbacks.
Atomic replacement and account identity checks stay with the existing writer and producer.

`tests/codex-integration/codex-quota-persistence.test.ts` and
`tests/providers/provider-account-quota-persistence.test.ts` check real disk contents under
controlled timers: idle debounce, consecutive sustained-update windows, cancellation and
home reset, removed rows, latest provider callbacks, and recovery after a failed write.
