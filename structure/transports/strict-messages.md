# Strict Messages Transport

The public listener exposes `/strict/v1/messages` and `/strict/v1/messages/count_tokens` through
`src/server/index/serve-options.ts`. These use a request-local strict configuration, retain the
normal authentication/origin/admission checks, and remove only the `/strict` route prefix upstream.
They neither mutate shared configuration nor expand the other listeners' route allowlists.

`claudeCode.strictPassthrough` in `src/types/config.ts` is an opt-in boolean preserved by the
Claude configuration block. Set it in config.json and restart to make the ordinary endpoints strict
too. Absence/false retains their legacy behavior; any other present value refuses ordinary
Messages/count_tokens rather than silently translating.
It needs no separate native-rollout flag.

## Hybrid Messages ingress

The public listener also exposes `/hybrid/v1/messages` and `/hybrid/v1/messages/count_tokens`.
`src/server/claude-messages.ts` reads each body once with the bounded reader and retains the wire
bytes. An unchanged `claude-` model accepted by the strict route predicate enters the strict handler
with those bytes, unless a Desktop 3P registry entry or a nonempty exact/date-stripped `modelMap`
entry claims it. Those claimed selectors receive 400. A current `ocx-claude-` or `ocx-claude2-`
alias, or a decoded legacy `claude-ocx-` or `claude-ocx2-` alias, resolving outside Anthropic enters
the existing bridge; its caller-credential passthrough, managed native and Antigravity direct lanes
are disabled. Every combo candidate must resolve outside Anthropic; policy or nested combo
candidates are refused. The same route predicate checks the settled bridge route after fast/effort
row rewrites. Other selectors receive a local 400 before any upstream request.
Native counts forward the original bytes; routed counts use the root endpoint's local estimate.
Only the bridge promotes the caller session header. Bridge responses and logged refusals before
lane selection carry the request-log response header; strict responses do not.
The hybrid turn defers its session-lane capacity check until lane selection, then claims the
selected lane through its existing lease. The strict lane keeps the original session identity and headers. Cancelling the bounded read returns 499.
`tests/claude-integration/messages-hybrid.test.ts` exercises these public HTTP boundaries with
synthetic pooled credentials and a streaming Chat upstream.

## Byte-preserving transport

`claudeCode.strictPassthrough: true` selects the strict variant of
`src/server/messages-native.ts` for both Messages POST endpoints, before caller passthrough or
managed-client transformations. The public listener and enabled intercept listener share this
branch. Interception cannot bypass it through client classification or opt-out.

`src/server/messages-native-integrity.ts` owns the bounded original HTTP entity bytes, including
request content coding, original query and end-to-end headers. Parsed JSON supplies only routing,
authorization and observations. The destination must resolve to the exact unchanged model on a
direct managed Anthropic route. Cross-wire, combo/policy, provider-header overrides, custom fetch,
TLS-profile and SOCKS transports are refused. Strict mode overrides optional prompt/tool/cache
transformations; it never repairs ids, inserts account metadata, filters unknown fields or adds betas.

Authentication is replaced with the selected managed credential. Cookies and `x-opencodex-*`
headers are removed, as are hop-by-hop fields (including Connection nominations), Host and framing.
The request header filter also excludes ingress topology/identity: `Forwarded`, `X-Real-IP`,
`X-Forwarded-*`, `Tailscale-User-*` and `Tailscale-Headers-Info`. These reserved ingress fields
are not application headers; other caller application headers and response end-to-end fields remain intact.
Fetch owns header casing/order, framing, and connection freshness; gateway CORS/security response
headers remain gateway policy. These exceptions do not permit request-body changes.
The final physical-send boundary asserts bytes, method, approved URL, headers, credential currentness,
manual redirects and disabled decompression after plugin hooks. A mutation or throwing hook refuses
the send before spend commitment. Nested policy layers defer that commitment to the innermost
executor check. Plugins are trusted process code, not a security sandbox.

Managed admission, model/Advisor scope, pacing, pre-send account selection/refresh, quota attribution,
spend and cancellation stay with their existing owners. There is one physical send: no reset retry,
response-triggered resend, redirect following or translation fallback. A distributed key's terminal
refusal still records its cooldown for subsequent independent requests. OAuth refusals use the existing
generation-fenced refusal owner with `canRetry: false`: revoked-token reauthentication, account cooldowns,
rate admission and affinity settlement affect subsequent requests only. No recovery candidate is selected
or refreshed by that observation. Optional auto-pause retains its existing policy and incarnation fences. The first response retains
its status and entity bytes, including malformed SSE tails, unknown fields and errors. Transport
failure terminates the body without synthetic frames. Bounded usage observation decodes gzip/deflate
separately from forwarding; unsupported or malformed coding and inspection overflow leave usage
unresolved rather than inventing it. Counting goes upstream and settles as non-generation work.
Body/turn leases last through response completion or cancellation for both endpoints.
Passive refusal inspection opts into the existing bounded-body reader and bounded request-content decoder
for identity, gzip/x-gzip, deflate, br and zstd. Both compressed input and inflated output are capped;
malformed, unsupported, oversized or interrupted bodies cannot authorize body-based refusal changes. This clone-only
inspection never changes the original encoded response bytes or relaxes the separate usage-inspection limits.
The private wire snapshot and the separate outbound copy each consume the existing 32 MiB retained-turn
budget; inbound admission is a separate ceiling, not permission to exceed retained-memory limits.

The strict blocks in `tests/claude-integration/messages-native.test.ts` and
`tests/claude-integration/messages-native-oauth.test.ts` use synthetic credentials and actual loopback
HTTP boundaries. They compare bytes independently of production serializers and test fail-closed
mutations, scope, OAuth selection, first-response errors and cancellation.
