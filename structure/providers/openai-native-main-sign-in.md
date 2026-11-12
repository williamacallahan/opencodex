# Native Main Device Sign-In

The native main slot (`__main__`) is the Codex login in `CODEX_HOME`'s `auth.json`. A headless hub
has no Codex App, no `codex` binary and no OS keyring, so the OpenAI deviceauth grant is the only
way to sign that slot in from the hub itself. `src/codex/main-device-reauth.ts` owns the flow,
`src/codex/main-device-reauth-api.ts` serves it as `/api/codex-auth/main/reauth-device`
(start/status/cancel), and `ocx account main reauth` and the dashboard's Main Account card are its
two clients. Refreshing a login that exists is a different contract: the
[rotation contract](openai-accounts.md#native-main-refresh-cancellation).

## Flow

The flow uses the deviceauth grant already used for pool accounts, but nothing routes through the
pool login surface: `/api/codex-auth/login` keeps rejecting `__main__`. One flow is active per
process. Preparation runs at start, before the human opens the device page, so a home that can be
neither reauthenticated nor signed in fails at once with `native_main_unavailable`. No claim is
held while the human completes the device page, and no DTO, log, or error carries tokens, emails,
or raw account ids.

The commit runs inside the owner-independent exclusive claim, because a headless hub runs no owner
lifecycle, and refuses while startup or recovery blocks native main traffic. Cancellation is bound
to that claim and is rechecked immediately before publication, so a cancel delivered while the
claim is contended aborts the wait and a cancelled flow cannot write `auth.json` or clear the
reauthentication quarantine. A cancel that arrives after the write still reports `succeeded`: the
credential was written, so that is the honest terminal.

## Reauthentication of an existing login

When `auth.json` holds a ChatGPT login, the grant must be for the same account. The commit is a
sibling of the refresh write: a same-identity check against the snapshot captured at start,
path/hash/inode re-verification inside the claim, and one atomic write of access/refresh/id token
+ account_id. The old identity token is never retained beside the new grant, and every other field
of the file is preserved. A different account ends `identity_mismatch`; a file that changed since
start ends `credential_changed`.

## First login

When `CODEX_HOME` holds no `auth.json` and the Codex credential store is `file`, the same flow is
that home's first login. This is the state of a hub that has only ever served pool accounts, and
without it such a hub could be signed in only by running `codex login` in a shell on the host.

A first login has no identity to match and no snapshot to protect, so its fence is absence:

- Preparation requires the read the profile doctor reports as `authStatus: "missing"`. An
  `auth.json` that exists without a ChatGPT login (an API-key login, an unreadable or invalid file)
  is somebody's credential and refuses with `native_main_unavailable`.
- A keyring-mode home refuses the same way: there, a missing file says nothing about whether a
  login exists.
- The write is an exclusive, no-replace publication of the `auth.json` shape `codex login` writes
  for a ChatGPT account, owner-only. A login that appears while the device page is open is kept,
  and the flow ends `credential_changed`.

Replacing a login that exists with a different account therefore stays impossible through this
surface; that is the native profile workflow, which needs the OS key store.

The account list reports the absent login on the main row as `reauthReason: "missing_credential"`
with `hasCredential: false`. The dashboard reads that cause, not the health projection (which has
no reason for a login that never existed), to label the card "Not signed in" and offer the device
sign-in; the native profile panel points to the same card instead of offering a save.
