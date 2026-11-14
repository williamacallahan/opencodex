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
Only automatic stored-account requests for `gpt-6-luna` may use it. Every such request goes first to
Reserve on a seat whose included usage is spent; only when no such seat can serve Reserve does it use
Luna on a seat with included usage, then previously consented fresh credits, then the existing refusal.
A seat is offered Reserve when it has a fresh reported grant below 100% or no stored Reserve window at
all: ChatGPT serves `gpt-reserve` to accounts whose usage response never lists a grant
(openai/codex#40939), so an unreported seat is tried and upstream stays the entitlement authority. A
stored window that is full, elapsed or stale keeps the seat out, and `poolReserveHoldResetAt` holds a
selected seat in that state for 60 seconds rather than sending. A thread bound to a seat with included
capacity does not keep Luna there: a soft binding never outranks Reserve, while a thread already
served by Reserve keeps that seat. An operator pin keeps its seat and is offered its own Reserve only on a fresh reported grant, because a
pinned request cannot move after a refusal.
A Reserve refusal is recorded in the seat's `reserve` health scope only, whatever timing evidence the 429
carries, and the request's single account move (`maxAlternateTargetSends: 1`) goes to included Luna
(`skipPoolReserve`); the other depleted seats are asked on later requests while the refused seat's Reserve
cools, and its shared scope is untouched.
Before the selector changes scope, `src/codex/auth-context.ts` still adopts a live legacy parent binding onto the current cohort key in the existing quota scope; it decides the seat only when no seat is offerable for Reserve.
The existing selector still enforces pause, plan, credential, failure-window and account-wide holds.
Reserve uses its independent quota scope; shared Responses serialization changes only the wire model
to `gpt-reserve` for HTTP and WebSocket. Ordinary headers cannot renew its five-minute WHAM observation,
and Reserve headers do not overwrite ordinary quota, even when an optional Pool history writer was not
captured. The header publisher uses the normalized wire model and automatic Reserve request mode;
writer availability does not determine which quota the response describes. Materialization and physical sends recheck the
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

When Reserve is offerable on a depleted seat, a Luna thread moves to it even from an eligible included owner; a live Reserve binding keeps its seat after the old owner's ordinary quota resets. The canonical legacy-lineage adoption preserves the original binding clocks, and the planner compares those last-use times; it creates no separate owner record.
