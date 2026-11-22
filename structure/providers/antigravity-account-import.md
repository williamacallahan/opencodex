# Antigravity account import

Owner of the Cockpit Tools import for `google-antigravity` (`src/oauth/account-import/`): the
document schema, per-record admission and what is persisted. The CLI and dashboard entry points
call `importAccounts` in `src/oauth/account-import/service.ts`; the public workflow lives in the
providers guide.

- **Document.** `parseCockpitAccountDocument` (`src/oauth/account-import/parser.ts`) accepts a
  JSON array of 1–25 records, at most 256 KiB serialized. A record allows only `email`,
  `refresh_token`, `project_id`, `tags` and `notes`; any other key, a duplicate email, or a
  field outside its bound marks that record `invalid_record` without validating it.
- **`project_id` schema.** Optional. When present it must be a string of 6–30 characters matching
  the Google Cloud project grammar (a lowercase letter, then lowercase letters, digits or hyphens,
  not ending in a hyphen), compared exactly with no trimming. Wrong types, blanks, padding,
  controls, domain-scoped ids and oversize values are `invalid_record`.
- **Identity.** `validateAntigravityImportCredential` refreshes the token and reads the email
  from Google's userinfo endpoint; a mismatch with the record's email is `identity_mismatch`, so
  one token can never land in another account's slot.
- **Project precedence.** The project discovered for the refreshed token (`loadCodeAssist`, then
  `onboardUser`) always wins, and a record's `project_id` is then ignored. Only when discovery finds
  none does `project_id` become a candidate, and it is admitted only after
  `verifyAntigravityImportProject` (`src/oauth/account-import/google-antigravity-adapter.ts`) runs
  the account quota probe (`probeAntigravityUsageQuota`) with that account's own access token
  against that project and gets a parsed quota answer. Denial, rate limiting, transport failure, an
  unusable body or a thrown probe all end as `missing_project`. There is no shared default project.
- **No write on failure.** Every failed record and a cancelled request persist nothing. Cancellation
  is checked after the probe as well, so a probe that admits after the request was cancelled still
  returns `import_cancelled` without a write.
- **Persistence.** An admitted record is upserted by identity with the resolved `projectId` and
  `source: "credential-file"`. A later token refresh that discovers no project keeps the stored
  one (`merged` in `src/oauth/index.ts`).
- **Output.** Results carry only fixed codes and counts; no token, email or upstream text.

## Claude setup tokens

`POST /api/oauth/accounts/import` with provider `anthropic` and format `claude-setup-token` loads
`claude setup-token` credentials into the Anthropic pool
(`src/oauth/account-import/claude-setup-token-adapter.ts`). It shares the document envelope above
through `parseAccountImportDocument`; a record allows only `email`, `setup_token` and `expires_at`
(epoch ms), all required.

- **No upstream call.** A setup token is inference-only: the profile and usage endpoints refuse it,
  and the hub sends no inference of its own. The operator-supplied email is the identity, and the
  first genuine Claude Code request is what proves the token.
- **Slot.** The email selects the pool slot, under the store lock (`upsertCredentialByEmailSlot`).
  A slot marked for a new sign-in, or one already holding a setup token, is replaced in place and
  keeps its account id and plan label. A slot holding a working renewable login is left alone and
  the record fails `login_kept`. Two slots with one email fail `identity_mismatch`. No slot means a
  new account stored by email alone, and a later browser sign-in as the same person takes that
  slot instead of opening a second one.
- **Stored shape.** `refresh` is empty, `expires` is the record's `expires_at`, `source` is
  `manual`. A token inside one minute of its expiry fails `credential_rejected`.
- **Life in the pool.** `detectOAuthWarning` reports the row healthy while unexpired;
  `fetchAnthropicAccountQuota` and `fetchAnthropicQuota` never send it to the usage endpoint and
  serve the reading response headers recorded, so a 429 cooldown on it cannot lift early; at expiry `refreshAnthropicAccountWithLock` marks it for a new token and posts no grant.
  Importing a new token for the same email clears that mark.
- **Limits.** A token Anthropic rejects before its stated expiry is marked only when the refusal
  is the revoked-token answer; any other 401 leaves the row selectable until it is paused or
  replaced. With no account proof, the cross-pool duplicate guard sees only an identical token.

Coverage: `tests/server/account-import-claude-setup-token.test.ts` (a real temporary store; no
live calls).

## Antigravity coverage

Coverage: `tests/server/account-import.test.ts` and
`tests/server/account-import-project-fallback.test.ts` (fakes for validation, probe and upsert;
no live calls).
