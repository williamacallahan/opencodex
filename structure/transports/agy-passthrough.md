# Antigravity CLI Pass-through and Native Harness Accounts

## The `/agy` lane

`agy` reaches the hub with `CLOUD_CODE_URL=<hub>/agy/<key>`; the CLI keeps that path prefix on every
Cloud Code call (`POST /agy/<key>/v1internal:<method>`). `src/server/agy-passthrough.ts` serves the
prefix on the public listener only, through one dynamic-import line in
`src/server/index/serve-options.ts`.

- **Admission.** The path segment after `/agy/` is the data-plane key, resolved by
  `resolveDataPlaneAdmissionSecret`; the CLI cannot add a header. A key whose `allowedProviders` omits
  `google-antigravity` is refused. The inbound `User-Agent` must start with `antigravity/`. Only
  `POST /v1internal:<method>` paths exist; anything else is a local 404.
- **What changes.** The bearer becomes a pooled account's access token. The `/agy/<key>` prefix,
  hop-by-hop fields, Host, cookies, `x-opencodex-*` and the ingress forwarding headers
  (`messagesEndToEndHeaders(…, true)`) are removed. Everything else agy sent, its own `User-Agent`
  included, and the request bytes go to agy's default origin
  (`https://daily-cloudcode-pa.googleapis.com`, from the registry) unchanged. Google's status,
  headers and body return unchanged except for hop-by-hop framing; SSE streams pass through as bytes.
- **One send.** No retry, no translation, no failover to another account inside a request. A 429
  cools the account in the generic OAuth pool (`rotateGenericOAuthAccountOn429`) for later
  project-less calls. A 403 passes through while a bounded copy of its body is read: when
  `classifyAntigravityRefusal` (`src/adapters/antigravity-refusal.ts`) finds Google's verification
  demand, the account is marked `needs-reauth(verify)` with `markAccountNeedsReauthIfGeneration`,
  fenced to the sign-in that was sent, the same durable mark the translated lane writes. The chooser
  skips it until a new sign-in clears it; without the mark, an unused account ranks least used and
  drew every new caller. Any other 403 (a model or project refusal) leaves the account in the pool.
  Local refusals use Google's error shape with an `opencodex:` message prefix.
- **Provider row optional.** The pool is the `google-antigravity` OAuth store; the lane needs no
  `config.providers["google-antigravity"]` row. With the switch on, a row (a Google login adds one)
  is listed by `GET /api/providers` with `nativeHarness: "agy"`, the catalog lists none of its
  models, and any translated route to it refuses with a 400 naming the agy harness.

## Observed quota

Under `nativeHarnessOnly` the hub sends Google no quota probe, so the pool's quota comes only from
Google's answers to agy's own quota calls. `src/server/agy-passthrough.ts` copies a 2xx answer to
`retrieveUserQuotaSummary` or `fetchAvailableModels` (and `loadCodeAssist`, for its project) with a
`tee`, reads at most 4 MiB of the copy, and leaves agy's bytes untouched. The reading is parsed by
`antigravityQuotaFromRelayedAnswer` (`src/providers/quota/antigravity.ts`); a models answer keeps only
its per-model rows, because its Gem/Cla rows copy one model's counter. The reading is recorded for
the serving account with `recordPassiveAccountQuota`, fenced by the config generation captured at the
account choice and bound to that slot's sign-in (`antigravityLoginIdentity`, which an access-token
refresh keeps and another login in the slot changes). The sign-in is rechecked before the write and
rides beside the row on disk (the cache entry's `identity`), and `observedAntigravityAccountQuota`
returns a row only while it matches the slot's current sign-in, so a probe-era row or another login's
row is never shown as an observation. A models answer never replaces a kept reading that has family
windows, however old, because only the summary reports the 5-hour and weekly buckets that balancing ranks by. `hasPassiveAccountQuota` treats `google-antigravity` as observed while the switch
is on: the Accounts tab shows each account's last observation (or "not observed yet"), and the quota
bar's provider row (`fetchObservedAntigravityQuota`) is the freshest observation with family windows,
since agy rotates across the pool; reset detection skips that display row. An observation is persisted with its sign-in and kept on disk for 8 days rather than the account cache's 6 hours (`src/providers/account-quota-disk.ts`), because an account agy is not using gets no newer reading. That retention is for display: `getCachedProviderAccountQuota`, which routing ranking and the quota pool read, ignores an agy observation older than 6 hours, so a days-old reading never ranks accounts or reports an account as exhausted. The Accounts tab shows its age, and its note (`pws.agyAccountPolicy`) explains the account policy below. The hub's own probe
rechecks the switch before every physical send, so turning it on mid-probe stops the retry and the
fallback. `tests/server/agy-passthrough.test.ts` and
`tests/providers/provider-antigravity-quota-retry.test.ts` cover it.

## Account choice

`src/server/agy-passthrough-accounts.ts` keeps every body valid for the token it is sent with:

- A body naming `project` goes to an account that owns that project: the stored
  `credential.projectId`, or the project Google returned on a `loadCodeAssist` this lane relayed for
  that account. Google can hand several accounts the same project (two pooled sign-ins shared one on
  2026-11-22), so among owners the caller's own account wins; a caller with no account yet (a restart, or agy refreshing its own token about hourly) takes the least-used owner that is not cooling down, then the first usable owner. An
  unowned project is a local 400; a project whose owners are all paused or reauth-marked is a local 503.
- Accounts are balanced by usage: `bindingUsage` is an account's most-used current Gem or Cla window from agy's reading of the slot's current sign-in within the last 6 hours (an unread account, or one whose reading belongs to a replaced sign-in, counts as 0). A new caller starts on the least-used eligible account (ties take turns), and at `loadCodeAssist` a caller moves when another eligible account that owns the caller's current project is at least `BALANCE_MARGIN_PERCENT` (10) points less used. Only a same-project move keeps agy's cached project and open trajectories valid on the new token; accounts with different projects never trade callers mid-session.
- A project-less call (`loadCodeAssist`, `writeTrajectoryAcls`) stays on the account this caller last
  used, keyed by a SHA-256 of the caller's own bearer, unless that account is cooling down; otherwise it
  takes the least-used eligible account that owns the caller's current project, else the least-used eligible account. agy calls `loadCodeAssist` at least once per turn, so a
  cooled account loses new turns at that boundary and the project agy caches then matches.
- A learned project is bound to the sign-in it was returned to: another login in the slot voids it,
  and it is written back to the stored credential only while that sign-in still holds the slot. The caller map is process-local and
  bounded; a restart, or agy refreshing its own token (about hourly), starts a new caller, whose next
  `loadCodeAssist` may land on another account.
- The Accounts tab shows which account serves agy: `agyServing` reports, from these choices alone,
  whether an account served an agy sign-in in the last 10 minutes and when it last served one
  (process-local, so empty after a restart). agy's own screen shows its local sign-in's email, which
  the hub replaces on every call, so it never names the serving account.
- The catalog gather leaves a Cloud Code row out while the switch is on (`captureGatherFlight`), so an
  operator row left from before the switch neither lists models nor breaks other providers' listing.

## `nativeHarnessOnly`

`src/lib/native-harness.ts` owns the top-level switch, bound once from the live config by
`setLiveStateStoreConfig`. A malformed hand edit parses as on. When it is on:

- Antigravity accounts serve only the `/agy` lane. Building a Cloud Code request in the Google adapter
  (`src/adapters/google.ts`), Cloud Code image generation (`src/server/images.ts`), Cloud Code model
  discovery for the catalog (`src/codex/catalog/gather-capture.ts`), quota probes
  (`src/providers/quota/antigravity.ts`) and login/refresh project discovery
  (`src/oauth/google-antigravity.ts`) refuse or skip before any send. Quota is observed instead (see Observed quota). Account import admits a credential
  with no project, because the lane learns it from agy's own traffic.
  The Gemini web-search sidecar, sibling model discovery (`src/codex/catalog/antigravity-discovery.ts`,
  `mayResolveModelsOAuth`), the provider connectivity test and Lab live probes skip Antigravity too.
- Token refresh at Google's standard OAuth endpoint and the import identity read remain.
- `nativeHarnessFor` names the one client a row is reserved to (`agy` for a Cloud Code OAuth row,
  `claude-code` for an Anthropic OAuth row); `GET /api/providers` returns it as `nativeHarness`, and the
  dashboard's provider rail and details header show it as an "agy only" / "Claude Code only" badge.
- Anthropic subscription (OAuth) accounts serve inference only through the strict lane
  (`src/server/messages-native-integrity.ts`), which then also requires a `claude-cli/` User-Agent.
  The translated adapter (`createAnthropicAdapter().buildRequest`), the non-strict managed native
  builder (`buildAnthropicMessagesPassthroughRequest`), the Anthropic web-search and vision sidecars,
  the `claude-cli` adapter and Lab probes refuse. Account reads (usage, profile, reset grants, model
  list) are management, not inference, and are unchanged.
- The `/agy` lane itself refuses while the switch is off, so it never runs beside hub-originated
  Cloud Code traffic.

## Ingress headers

`messagesEndToEndHeaders(…, true)` strips the headers the hub's own ingress adds and no client sends:
`Forwarded`, `X-Real-IP`, `X-Forwarded-*`, Envoy's `X-Request-Id` and `X-Envoy-*`, and Tailscale
identity headers. The strict Claude lane and the `/agy` lane share it.

## Unlabelled generate diagnostic

When the body scan finds no session for a `streamGenerateContent` or `generateContent` request,
`src/server/agy-unlabelled-shape.ts` logs one `[opencodex] level=info event=agy.unlabelled_generate_shape`
line describing the body's shape and nothing in it: the top-level, `request` and `request.labels` key names in
order (identifier-shaped names only, else `<other>`, 40 at most), the JSON type of `request.sessionId`,
top-level `requestType` and `request.labels.trajectory_id` (strings add their byte length and one class of
`uuid`, `signed-digits`, `digits`, `hex`, `empty`, `other`), `requestType` itself when it matches
`^[A-Za-z_-]{1,24}$`, the character-class pattern of the top-level `requestId` (`request_id_pattern`: hex-digit runs `h<n>`, all-decimal runs `d<n>`, other letter runs `a<n>`, `/ - _ . :` kept, anything else `?`, `toolong` over 200 characters, `absent` when not a string; no character of the value survives and the pattern is part of the shape signature), and the body size rounded up to a power of two. Values, the project, request ids, prompt
text and headers are never read into it. It is bounded for the process lifetime (one line per distinct shape,
20 lines, 64 remembered shapes, nothing computed afterwards), runs one extra walk of the top level and of
`request`'s direct members only when no session was found, never throws, and leaves the forwarded bytes
untouched. `tests/server/agy-unlabelled-shape.test.ts` covers it.

## Physical send

`src/server/agy-passthrough-send.ts` sends with the Node HTTP client because `fetch` adds a wildcard
`Accept` to a request that has none; the Node client adds only `Host` and connection framing, follows
no redirect, reuses a bounded LIFO HTTP/HTTPS agent pool (`AGENT_OPTIONS`) with idle-only 20-second
keep-alive socket eviction (`DEFAULT_AGY_IDLE_SOCKET_TIMEOUT_MS`), enforces separate 15-second connect and
200-second response-header deadlines (`AgyUpstreamSendError`), and decodes nothing. Compressed ingress payloads
for the one-pass body scan (`scanAgyBody`: routing project and agy session, zero-AST UTF-8 byte walk; the trajectory UUID is preferred and the decimal `request.sessionId` is used only when no trajectory id is present) and relayed quota
answers decode asynchronously via promisified `node:zlib` helpers. Caught transport errors on send and mid-stream body reads emit a single-line JSON redacted
`[agy-passthrough] upstream failure` warning (recording `phase`, `code`, `syscall`, sanitized
`message`, `reusedSocket`, and `elapsedMs`, omitting clean client-aborted streams); non-cancelled pre-header
send failures return HTTP 503 while client-cancelled ones return HTTP 499. Cooled-down project
owners rotate onto another healthy owner of the same project in `src/server/agy-passthrough-accounts.ts`.
The response streams back through a wrapper that writes the request
log and releases the active-turn lease when the body ends or the client cancels, so a hub drain waits
for open streams. A 401 from Google forces a token refresh for the next request.

Coverage: `tests/server/agy-passthrough.test.ts` drives the real public listener against a loopback
Cloud Code capture with synthetic accounts: byte, path, query and header preservation; caller
affinity and project learning; usage balancing, same-project moves and sign-in-bound learned projects; 429 pass-through and cooldown; the verify-refusal quarantine and an untouched non-verify 403; refusals before any upstream call; and
a translated Responses turn refused with the switch on. `tests/server/agy-passthrough-resilience.test.ts`
covers zero-AST project extraction, cooled-down project-owner failover, async gzip/deflate/brotli decoding,
bounded header timeouts, and redacted upstream failure logging.
