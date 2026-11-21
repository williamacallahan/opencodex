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
Among eligible seats, the router prefers a fresh reported grant below 100% or a completed Reserve
turn observed within 15 minutes on the current credential. ChatGPT serves `gpt-reserve` without
reporting a grant, so when neither kind of evidence is available, one real turn at a time can try
an unreported seat. The scoped probe lease paces those trials at least five minutes apart per seat;
there is no additional usage poll.
The same holds for every Reserve judgment: a missing grant window, a `pro_rate_limit_reached` banner,
an absent catalog row or one refused request never shows that Reserve is unavailable; only served
`gpt-reserve` requests show that it works. The hub's request log records the requested `gpt-6-luna`
for an automatic pool Reserve turn, not the wire model, so it cannot count them; codex-lb's request
log can, and its `/v1/usage` `luna_reserve.served_*` fields report them for the codex-lb route. A
stored window that is full, elapsed or stale keeps the seat out, and `poolReserveHoldResetAt` holds a
selected seat in that state for 60 seconds rather than sending. A thread bound to a seat with included
capacity does not keep Luna there: a soft binding never outranks Reserve, while a thread already
served by Reserve keeps that seat. A genuine completion on an alternate establishes Reserve affinity
without changing shared affinity. An operator pin requires a fresh reported grant both at selection
and at dispatch, because a pinned request cannot move after a refusal.
A Reserve refusal cools only the seat's `reserve` health scope and leaves its shared quota untouched.
That cool ignores the refusal's announced reset, which names the seat's spent plan window rather than
Reserve: ChatGPT never discloses Reserve capacity and its refusals come and go per seat, so only an
explicit Retry-After holds the scope past the default minute, and the seat is asked again once the
5-minute probe interval passes (`src/codex/routing.ts`).
Ordinary Luna has one account move: another verified Reserve seat, then included Luna. It never probes an unknown seat on that retry.
A portable Luna combo's `reserve-only` leg snapshots the spent seats it may try. Before output, a seat-local 429 (`rate_limit_exceeded` or `usage_limit_reached`) cools that seat and can move the turn to another untried seat, including a leased unreported seat. The move rechecks that included quota is still spent and that the seat remains selectable at dispatch. A candidate lost before any send is removed from this request and selection resumes; a pool-window or spend refusal ends placement. Routed portable compaction uses the same account walk but keeps its summarizer request and compaction-item encoder. Only `gpt-reserve` may leave the strict leg. If the shared pool window denies a move, the leg releases the unused permit and probe lease and yields to the relay without waiting. If placement expires before a replacement send, the alternate seat’s complete refusal remains its outcome; caller cancellation and failures after physical dispatch do not reuse that refusal. [Reserve retry accounting](transports/responses-spend.md) describes the body and send bounds. A local `CodexReserveUnavailableError` means the proposed send was not admitted; refused sends are not evidence that the provider has no Reserve capacity. The `ordinary-only` leg never consults Reserve. An `owner-only` turn restricts placement to the credential proved by its turn-state handle, explicit selector or recorded issuer; it does not rotate on refusal. Without a usable owner it fails closed. Coverage: `tests/server/server-combo-luna-reserve-order.test.ts` and `tests/codex-integration/codex-pool-reserve.test.ts`.
Before the selector changes scope, `src/codex/auth-context.ts` still adopts a live legacy parent binding onto the current cohort key in the existing quota scope; it decides the seat only when no seat is offerable for Reserve.
The existing selector still enforces pause, plan, credential, failure-window and account-wide holds.
Reserve uses its independent quota scope; shared Responses serialization changes only the wire model
to `gpt-reserve` for HTTP and WebSocket. The canonical Responses routing hint is derived from the final wire body, including the Reserve model and any service tier. Ordinary headers cannot renew its five-minute WHAM observation,
and Reserve headers do not overwrite ordinary quota, even when an optional Pool history writer was not
captured. The header publisher uses the normalized wire model and automatic Reserve request mode;
writer availability does not determine which quota the response describes. At the physical send, a
stored seat must still have live evidence or own the current trial; a grant that expires in the queue
cannot become an unleased trial. The trial ends on completion, failure, or cancellation. Streamed
quota refusals retain upstream retry timing. Explicit Desktop Reserve and native-main authorization
remain separate and unchanged.
The native `__main__` login has no stored row and is outside the automatic Reserve candidate set.
Without a live credential it is never chosen at all. With one it joins only the included
Luna fallback, after every seat that can serve Reserve, and it is still held at its own 100% usage.
Coverage: `tests/codex-integration/codex-pool-reserve.test.ts` and `codex-pool-reserve-main.test.ts`.

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
