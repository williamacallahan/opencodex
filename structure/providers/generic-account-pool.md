# Generic OAuth Account Pool

`src/oauth/store.ts` flushes the replacement credential file before its atomic rename. A file
flush failure leaves the prior store in place; the subsequent parent-directory flush is best
effort on POSIX and unavailable on Windows.

Readers share one parsed store while the file's stat signature is unchanged and at least 50 ms
old. Only a completed read or a completed write fills that cache: `mutateStore` reads past it and
edits its own copy in place, so a write that fails leaves every reader on the bytes still on disk
(`tests/oauth/oauth-store-cache.test.ts`).

An `auth.json` that exists but cannot be loaded serves an empty account pool, which is otherwise
indistinguishable from every account having signed out. `loadAuthStoreInternal` in
`src/oauth/store.ts` therefore copies it to `auth.json.invalid-<timestamp>` and prints
`[opencodex] level=error OAuth account store unreadable; serving an empty pool reason=<reason>`
once per distinct unreadable content, not once per load: requests load the store continuously, and
a copy per load fills the config directory. `reason` is `empty_file` (zero bytes), `invalid_json`
(bytes that do not parse) or `read_failed` (the read itself threw); the line never carries file
content. A load that succeeds, an absent file and any store write clear that record, so a file
that goes bad again is copied and reported again. An absent file stays a silent empty pool, and a
passive read leaves the file for the Home's own load.

`GET /readyz` does not report this. Its status is the startup-sync enum of `src/server/readiness.ts`
and a holding gate in front of a hub treats `pending` as a drain, so a not-ready answer would stop
every provider, including those that never read `auth.json`. `ocx doctor` reports it instead:
`collectOAuthDoctorChecks` in `src/cli/doctor.ts` reads the file observe-only through
`peekAuthStoreUnreadableReason` and adds a `FAIL` check naming the reason, which fails the command.

## Conversation affinity

`src/oauth/generic-session-affinity.ts` owns opt-in generic-pool conversation bindings. Provider-local
`oauthAccountFailover.sessionAffinity: "conversation"` requires proactive enablement; it does not
change reactive failover activation. Bindings are scoped to configuration home, provider and caller
principal, store only a hashed session key, account ID and selection receipt, and expire after 24 idle
hours within a process-wide 2,000-entry bound. Pause, reauth, model/family ineligibility and persisted
selection-revision changes release them. Cross-process revisions are checked on every lookup.
`src/oauth/session-affinity-key.ts` supplies the existing client-thread/header/cache-key precedence
for both generic and Anthropic callers; shared Desktop cache cohorts do not establish identity.

`src/server/responses/request-transport.ts` admits every automatic generic affinity-mode choice
without persisting an active-account change, including new/unkeyed sessions and failovers. The
operator's saved selection/revision fences queued sends independently of each conversation's serving
snapshot and credential generation. An unchanged selection with a renewed credential re-resolves
that same account; a changed selection follows the operator. Off-active 401 refresh remains bound
to the sent account. Admitted replacements rebind; affinity hits do not advance round-robin.
Fill-first has a bounded process-local cursor and prefers below-threshold alternatives without
moving the persisted selection. Kiro capacity retains wait/refusal semantics. Codex and Anthropic
are excluded. `tests/oauth/generic-session-affinity.test.ts` and
`tests/server/server-generic-oauth-affinity.test.ts` exercise these boundaries with synthetic accounts.

`src/types/provider.ts` declares the optional `sessionAffinity` mode; omission keeps existing behavior.

## Combo sibling probes

Antigravity sibling discovery passes its root/cache authority through `src/oauth/index.ts` to
generic refresh dispatch. After the account lock is acquired and newer credentials are adopted,
stale discovery stops before the token request without marking the account for reauthentication.
A rotation already dispatched still persists its result under the existing credential CAS.
An independent consumer sharing a discovery-cancelled flight releases its waiter permit before
one new resolution attempt. Callers carrying discovery authority keep the cancellation; unknown
stale outcomes, including post-dispatch uncertainty, never receive this automatic retry.

Antigravity model routing in `src/oauth/generic-account-failover.ts` ranks siblings by configured strategy or family headroom only within the best readiness/model-support tier. A known omission stays excluded, and unknown support stays usable. Reactive model-404 rotation excludes accounts already attempted in the request and prefers positive support before unknown support without changing account-wide auth or cooldown state.

`src/server/responses/core-combo.ts` asks `src/oauth/generic-account-failover.ts` whether a refused
account has an eligible sibling before cooling the whole target. This probe records the refused
account's cooldown but passes `commit: false`, so it only peeks at a round-robin pool. An unsent
sibling does not consume a sticky turn. Dispatching callers retain the default committed pick.
`tests/oauth/generic-oauth-combo-account-cooldown.test.ts` covers this distinction.
