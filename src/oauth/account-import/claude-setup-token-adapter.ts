import { getAccountSet, upsertCredentialByIdentity } from "../store";
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

export interface ClaudeSetupTokenImportAdapterDeps {
  accounts(): readonly ProviderAccount[];
  upsert(credential: OAuthCredentials): Promise<"inserted" | "updated">;
  now(): number;
}

function sameEmail(account: ProviderAccount, email: string): boolean {
  return account.credential.email?.trim().toLowerCase() === email;
}

/**
 * A setup token is inference-only, so neither the profile nor the usage endpoint will name its
 * account, and the hub sends no inference of its own to find out. The operator-supplied email is
 * therefore the identity: it selects the account's existing slot, or opens a new one.
 */
export function createClaudeSetupTokenImportAdapter(
  deps: ClaudeSetupTokenImportAdapterDeps = {
    accounts: () => getAccountSet(CLAUDE_SETUP_TOKEN_IMPORT_PROVIDER)?.accounts ?? [],
    upsert: credential => upsertCredentialByIdentity(CLAUDE_SETUP_TOKEN_IMPORT_PROVIDER, credential),
    now: Date.now,
  },
): AccountImportAdapter<ClaudeSetupTokenRecord> {
  return {
    provider: CLAUDE_SETUP_TOKEN_IMPORT_PROVIDER,
    format: CLAUDE_SETUP_TOKEN_IMPORT_FORMAT,
    async importRecord(record: ClaudeSetupTokenRecord, signal?: AbortSignal) {
      throwIfAccountImportAborted(signal);
      if (record.expiresAt <= deps.now() + MINIMUM_REMAINING_LIFETIME_MS) return { status: "failed", code: "credential_rejected" };
      const slots = deps.accounts().filter(account => sameEmail(account, record.email));
      if (slots.length > 1) return { status: "failed", code: "identity_mismatch" };
      const slot = slots[0];
      // A working renewable login outlives any setup token; only a slot that already needs a
      // new sign-in, or already holds a setup token, is replaced.
      if (slot && slot.credential.refresh !== "" && slot.needsReauth !== true) return { status: "failed", code: "persist_failed" };
      try {
        const disposition = await deps.upsert({
          access: record.setupToken,
          refresh: "",
          expires: record.expiresAt,
          email: record.email,
          source: "manual",
          // The slot's verified account id keeps the import on that slot instead of opening a second one.
          ...(slot?.credential.accountId ? { accountId: slot.credential.accountId } : {}),
          ...(slot?.credential.plan !== undefined ? { plan: slot.credential.plan } : {}),
        });
        return disposition === "updated"
          ? { status: "updated", code: "updated" }
          : { status: "imported", code: "imported" };
      } catch {
        return { status: "failed", code: "persist_failed" };
      }
    },
  };
}
