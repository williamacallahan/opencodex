import {
  ACCOUNT_IMPORT_MAX_BYTES,
  ACCOUNT_IMPORT_MAX_EMAIL_LENGTH,
  ACCOUNT_IMPORT_MAX_PROJECT_ID_LENGTH,
  ACCOUNT_IMPORT_MAX_RECORDS,
  ACCOUNT_IMPORT_MAX_REFRESH_TOKEN_BYTES,
  type AccountImportDocumentParseResult,
  type CockpitAccountRecord,
  type ParsedAccountImportRecord,
} from "./types";

const encoder = new TextEncoder();
const ALLOWED_RECORD_KEYS = new Set(["email", "refresh_token", "project_id", "tags", "notes"]);
// Google Cloud project id grammar: a lowercase letter, then lowercase letters, digits or hyphens,
// not ending in a hyphen. Exact match only — no trimming, so whitespace or controls are rejected.
const PROJECT_ID_SHAPE = /^[a-z][a-z0-9-]*[a-z0-9]$/;

export type CockpitDocumentParseResult = AccountImportDocumentParseResult<CockpitAccountRecord>;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializedDocumentSize(document: unknown): number | null {
  try {
    const serialized = JSON.stringify(document);
    return serialized === undefined ? null : encoder.encode(serialized).byteLength;
  } catch {
    return null;
  }
}

export function validEmail(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > ACCOUNT_IMPORT_MAX_EMAIL_LENGTH) return false;
  if (value !== value.trim() || /[\x00-\x20\x7f]/.test(value)) return false;
  const at = value.indexOf("@");
  return at > 0 && at === value.lastIndexOf("@") && at < value.length - 1;
}

/** A bearer or refresh token as one bounded, whitespace-free string. */
export function validToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && encoder.encode(value).byteLength <= ACCOUNT_IMPORT_MAX_REFRESH_TOKEN_BYTES
    && !/[\s\x7f]/.test(value);
}

function validMetadata(record: Record<string, unknown>): boolean {
  if (record.tags !== undefined && (
    !Array.isArray(record.tags)
    || record.tags.some(tag => typeof tag !== "string")
  )) return false;
  return record.notes === undefined || typeof record.notes === "string";
}

function validProjectId(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  return typeof value === "string"
    && value.length >= 6
    && value.length <= ACCOUNT_IMPORT_MAX_PROJECT_ID_LENGTH
    && PROJECT_ID_SHAPE.test(value);
}

function parseCockpitRecord(value: unknown): CockpitAccountRecord | null {
  if (!isPlainRecord(value)) return null;
  if (Object.keys(value).some(key => !ALLOWED_RECORD_KEYS.has(key))) return null;
  if (!validEmail(value.email) || !validToken(value.refresh_token) || !validProjectId(value.project_id) || !validMetadata(value)) {
    return null;
  }
  return {
    email: value.email.toLowerCase(),
    refreshToken: value.refresh_token,
    ...(typeof value.project_id === "string" ? { projectId: value.project_id } : {}),
  };
}

/**
 * The document envelope every import format shares: a bounded JSON array of 1–25 records, one
 * per email. `parseRecord` owns the format's record schema and returns null for a record it rejects.
 */
export function parseAccountImportDocument<AccountRecord extends { email: string }>(
  document: unknown,
  parseRecord: (value: unknown) => AccountRecord | null,
): AccountImportDocumentParseResult<AccountRecord> {
  const size = serializedDocumentSize(document);
  if (size === null || size > ACCOUNT_IMPORT_MAX_BYTES) return { ok: false, code: "invalid_document" };
  if (!Array.isArray(document) || document.length === 0 || document.length > ACCOUNT_IMPORT_MAX_RECORDS) {
    return { ok: false, code: "invalid_document" };
  }
  const seen = new Set<string>();
  const records = document.map((value, index): ParsedAccountImportRecord<AccountRecord> => {
    const record = parseRecord(value);
    if (!record || seen.has(record.email)) return { index, code: "invalid_record" };
    seen.add(record.email);
    return { index, record };
  });
  return { ok: true, records };
}

export function parseCockpitAccountDocument(document: unknown): CockpitDocumentParseResult {
  return parseAccountImportDocument(document, parseCockpitRecord);
}
