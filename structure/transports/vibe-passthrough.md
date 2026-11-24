# Mistral Vibe CLI Pass-through (`/vibe`)

The native Mistral Vibe CLI reaches the hub on `/vibe/*` (`api_base = <hub>/vibe/v1`,
`vibe_base_url = <hub>/vibe/chat` with `backend = "mistral"` and `preserve_api_base = true`).
`src/server/vibe-passthrough.ts` serves the `/vibe/` prefix on the public listener only, wired via
one branch in `src/server/index/serve-options.ts`.

- **Allowlisted routes.** Only `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/models/<id>`,
  `GET /v1/connectors/bootstrap`, `GET /v1/billing/budget`, `GET /v1/users/me` (targeting
  `https://api.mistral.ai`), and `GET /chat/api/v1/code/managed-config` (targeting
  `https://chat.mistral.ai/api/v1/code/managed-config`) are admitted. Traversal sequences, unsafe
  escapes, and unknown subpaths fail with 404; mismatched methods fail with 405.
- **Admission and zero spoofing.** Data-plane Bearer keys are validated via `resolveApiAuth` and
  restricted by `allowedProviders` (`"mistral-vibe"`). Every request must carry a genuine
  `mistral-client-python/Mistral-Vibe/*` User-Agent (with `python-httpx2/*` additionally accepted
  only on `/v1/connectors/bootstrap` and `/chat/api/v1/code/managed-config`). Incoming headers
  and body bytes are never rewritten or synthesized other than replacing `Authorization` with the
  pooled upstream key and stripping ingress/hop-by-hop headers.
- **Key pool and bounded failover.** `src/server/vibe-passthrough-keys.ts` manages the `mistral-vibe`
  `apiKeyPool`: O(1) bounded LRU affinity by `x-affinity` (2048 entries, 6-hour TTL), clamped 429
  cooldowns (`Retry-After` / `x-ratelimit-reset-*`), and calendar-month 402 parks
  (`billing_vibe_budget_exhausted` / code `2304`, persisted in `vibe-key-cooldowns.json`). When a
  pooled key fails pre-output with 401/402(budget)/429/502/503/504 and a distinct healthy sibling
  exists, the lane performs at most one byte-identical pre-output retry. An inference request
  authenticated by a key scoped only to `mistral-vibe` may set `X-OpenCodex-Max-Sends: 1` to
  disable all retries. The header is never forwarded upstream. Logged inference responses carry
  `X-OpenCodex-Request-Id`, matching the request log row. `spend.sends` counts socket-ready send
  attempts, not confirmed provider receipt; a counted failure before response headers is transport-ambiguous.
- **Reservation.** When `nativeHarnessOnly` in `src/lib/native-harness.ts` is on, `mistral-vibe`
  reports `nativeHarness: "vibe"` in `/api/providers`, is excluded from bare routing, catalog
  discovery, key quota probes, and translated Chat/Responses/Messages dispatch, while metered
  `mistral` remains unaffected.
