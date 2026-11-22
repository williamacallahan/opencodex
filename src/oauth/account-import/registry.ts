import { createClaudeSetupTokenImportAdapter, parseClaudeSetupTokenDocument } from "./claude-setup-token-adapter";
import { createAntigravityAccountImportAdapter } from "./google-antigravity-adapter";
import {
  ACCOUNT_IMPORT_FORMAT,
  ACCOUNT_IMPORT_PROVIDER,
  CLAUDE_SETUP_TOKEN_IMPORT_FORMAT,
  CLAUDE_SETUP_TOKEN_IMPORT_PROVIDER,
  type AccountImportAdapter,
  type AccountImportDocumentParseResult,
  type ClaudeSetupTokenRecord,
} from "./types";

/** A resolved import: the Cockpit Tools format, or a format that brings its own document parser. */
export type AccountImportRegistryResult =
  | { ok: true; adapter: AccountImportAdapter }
  | {
    ok: true;
    adapter: AccountImportAdapter<ClaudeSetupTokenRecord>;
    parse(document: unknown): AccountImportDocumentParseResult<ClaudeSetupTokenRecord>;
  }
  | { ok: false; code: "unsupported_provider" | "unsupported_format" };

const antigravityAdapter = createAntigravityAccountImportAdapter();
const claudeSetupTokenAdapter = createClaudeSetupTokenImportAdapter();

export function resolveAccountImportAdapter(provider: string, format: string): AccountImportRegistryResult {
  if (provider === ACCOUNT_IMPORT_PROVIDER) {
    return format === ACCOUNT_IMPORT_FORMAT ? { ok: true, adapter: antigravityAdapter } : { ok: false, code: "unsupported_format" };
  }
  if (provider === CLAUDE_SETUP_TOKEN_IMPORT_PROVIDER) {
    return format === CLAUDE_SETUP_TOKEN_IMPORT_FORMAT
      ? { ok: true, adapter: claudeSetupTokenAdapter, parse: parseClaudeSetupTokenDocument }
      : { ok: false, code: "unsupported_format" };
  }
  return { ok: false, code: "unsupported_provider" };
}
