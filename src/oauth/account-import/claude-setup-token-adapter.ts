import { upsertCredentialByEmailSlot, type EmailSlotUpsert } from "../store";
import type { OAuthCredentials, ProviderAccount } from "../types";
import { isPlainRecord, parseAccountImportDocument, validEmail, validToken } from "./parser";
import {
  CLAUDE_SETUP_TOKEN_IMPORT_FORMAT,
  CLAUDE_SETUP_TOKEN_IMPORT_PROVIDER,
  throwIfAccountImportAborted,
  type AccountImportAdapter,
  type AccountImportDocumentParseResult,
  type ClaudeSetupTokenRecord,
} from "./types";

const ALLOWED_RECORD_KEYS = new Set(["email", "setup_token", "expires_at"]);
/** The pool treats a credential inside this margin as expired, so importing one would add a dead account. */
const MINIMUM_REMAINING_LIFETIME_MS = 60_000;

function parseSetupTokenRecord(value: unknown): ClaudeSetupTokenRecord | null {
  if (!isPlainRecord(value)) return null;
  if (Object.keys(value).some(key => !ALLOWED_RECORD_KEYS.has(key))) return null;
  if (!validEmail(value.email) || !validToken(value.setup_token)) return null;
  if (typeof value.expires_at !== "number" || !Number.isSafeInteger(value.expires_at) || value.expires_at <= 0) return null;
  return { email: value.email.toLowerCase(), setupToken: value.setup_token, expiresAt: value.expires_at };
}

export function parseClaudeSetupTokenDocument(document: unknown): AccountImportDocumentParseResult<ClaudeSetupTokenRecord> {
  return parseAccountImportDocument(document, parseSetupTokenRecord);
}

/**
 * A working renewable login outlives any setup token, so only a slot that already needs a new
 * sign-in, or already holds a setup token, gives way to an imported one.
 */
function yieldsToSetupToken(slot: ProviderAccount): boolean {
  return slot.credential.refresh === "" || slot.needsReauth === true;
}

export interface ClaudeSetupTokenImportAdapterDeps {
  upsert(credential: OAuthCredentials, replaceable: (slot: ProviderAccount) => boolean): Promise<EmailSlotUpsert>;
  now(): number;
}

/**
 * A setup token is inference-only, so neither the profile nor the usage endpoint will name its
 * account, and the hub sends no inference of its own to find out. The operator-supplied email is
 * therefore the identity: it selects the account's existing slot, or opens a new one.
 */
export function createClaudeSetupTokenImportAdapter(
  deps: ClaudeSetupTokenImportAdapterDeps = {
    upsert: (credential, replaceable) => upsertCredentialByEmailSlot(CLAUDE_SETUP_TOKEN_IMPORT_PROVIDER, credential, replaceable),
    now: Date.now,
  },
): AccountImportAdapter<ClaudeSetupTokenRecord> {
  return {
    provider: CLAUDE_SETUP_TOKEN_IMPORT_PROVIDER,
    format: CLAUDE_SETUP_TOKEN_IMPORT_FORMAT,
    async importRecord(record: ClaudeSetupTokenRecord, signal?: AbortSignal) {
      throwIfAccountImportAborted(signal);
      if (record.expiresAt <= deps.now() + MINIMUM_REMAINING_LIFETIME_MS) return { status: "failed", code: "credential_rejected" };
      let disposition: EmailSlotUpsert;
      try {
        disposition = await deps.upsert({
          access: record.setupToken,
          refresh: "",
          expires: record.expiresAt,
          email: record.email,
          source: "manual",
        }, yieldsToSetupToken);
      } catch {
        return { status: "failed", code: "persist_failed" };
      }
      switch (disposition) {
        case "inserted": return { status: "imported", code: "imported" };
        case "updated": return { status: "updated", code: "updated" };
        case "login-kept": return { status: "failed", code: "login_kept" };
        case "ambiguous-email": return { status: "failed", code: "identity_mismatch" };
      }
    },
  };
}
