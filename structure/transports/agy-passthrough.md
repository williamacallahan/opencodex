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
  project-less calls. Local refusals use Google's error shape with an `opencodex:` message prefix.
- **No provider row.** The pool is the `google-antigravity` OAuth store. The lane needs no
  `config.providers["google-antigravity"]` row, so nothing translated can route to the pool unless an
  operator adds one.

## Account choice

`src/server/agy-passthrough-accounts.ts` keeps every body valid for the token it is sent with:

- A body naming `project` goes to the account that owns that project: the stored
  `credential.projectId`, or the project Google returned on a `loadCodeAssist` this lane relayed for
  that account. An unowned project is a local 400; a paused or reauth-marked owner is a local 503.
- A project-less call (`loadCodeAssist`, `writeTrajectoryAcls`) stays on the account this caller last
  used, keyed by a SHA-256 of the caller's own bearer, unless that account is cooling down; otherwise it
  takes the next eligible account in rotation. agy calls `loadCodeAssist` at least once per turn, so a
  cooled account loses new turns at that boundary and the project agy caches then matches.
- Both maps are process-local and bounded; a restart forgets them and the next `loadCodeAssist`
  rebuilds them.

## `nativeHarnessOnly`

`src/lib/native-harness.ts` owns the top-level switch, bound once from the live config by
`setLiveStateStoreConfig`. A malformed hand edit parses as on. When it is on:

- Antigravity accounts serve only the `/agy` lane. Building a Cloud Code request in the Google adapter
  (`src/adapters/google.ts`), Cloud Code image generation (`src/server/images.ts`), Cloud Code model
  discovery for the catalog (`src/codex/catalog/gather-capture.ts`), quota probes
  (`src/providers/quota/antigravity.ts`) and login/refresh project discovery
  (`src/oauth/google-antigravity.ts`) refuse or skip before any send. A Google login does not add a
  `google-antigravity` provider row (`upsertOAuthProvider`), and account import admits a credential
  with no project, because the lane learns it from agy's own traffic.
  The Gemini web-search sidecar, sibling model discovery (`src/codex/catalog/antigravity-discovery.ts`,
  `mayResolveModelsOAuth`), the provider connectivity test and Lab live probes skip Antigravity too.
- Token refresh at Google's standard OAuth endpoint and the import identity read remain.
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

## Physical send

`src/server/agy-passthrough-send.ts` sends with the Node HTTP client because `fetch` adds a wildcard
`Accept` to a request that has none; the Node client adds only `Host` and connection framing, follows
no redirect and decodes nothing. The response streams back through a wrapper that writes the request
log and releases the active-turn lease when the body ends or the client cancels, so a hub drain waits
for open streams. A 401 from Google forces a token refresh for the next request.

Coverage: `tests/server/agy-passthrough.test.ts` drives the real public listener against a loopback
Cloud Code capture with synthetic accounts: byte, path, query and header preservation; caller
affinity and project learning; 429 pass-through and cooldown; refusals before any upstream call; and
a translated Responses turn refused with the switch on.
