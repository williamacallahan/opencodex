const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BLOCKED_FORWARDED_CLIENT_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-amz-security-token",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "x-oai-attestation",
  "x-openai-agent-assertion",
]);

// The last two are the LLM gateway's per-session cost and Langfuse identity: the hub cannot
// derive them from the body, so an opted-in gateway provider receives the client's own.
const ALLOWED_FORWARDED_CLIENT_HEADERS = new Set([
  "originator", "x-client-request-id", "x-codex-app-version", "user-agent", "x-lgw-cache-key", "x-user-id",
]);
const MAX_FORWARDED_CLIENT_HEADERS = 64;

/** Normalize one opt-in caller header while refusing credential and transport-owned fields. */
export function normalizeForwardedClientHeaderName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (!name || !HEADER_NAME_PATTERN.test(name) || !ALLOWED_FORWARDED_CLIENT_HEADERS.has(name)) return null;
  return name;
}

/** Validate provider.forwardClientHeaders without ever admitting credential-bearing headers. */
export function providerForwardClientHeadersConfigError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "forwardClientHeaders must be an array of header names";
  if (value.length > MAX_FORWARDED_CLIENT_HEADERS) {
    return `forwardClientHeaders must contain at most ${MAX_FORWARDED_CLIENT_HEADERS} names`;
  }
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim() || !HEADER_NAME_PATTERN.test(raw.trim())) {
      return "forwardClientHeaders must use valid HTTP header names";
    }
    const name = raw.trim().toLowerCase();
    if (BLOCKED_FORWARDED_CLIENT_HEADERS.has(name)) {
      return `forwardClientHeaders must not include credential or transport-owned header "${raw.trim()}"`;
    }
    if (!ALLOWED_FORWARDED_CLIENT_HEADERS.has(name)) {
      return "forwardClientHeaders must use the supported client metadata allowlist";
    }
    if (seen.has(name)) return `forwardClientHeaders must not repeat header "${raw.trim()}"`;
    seen.add(name);
  }
  return null;
}

// The hub's own launchers send `<launcher>:<label>` (`claude-av:<session>`, `pi-av:<session>`,
// `claude-code:codeAgent`). Anything else is a caller choosing its own gateway identity.
const GATEWAY_IDENTITY_VALUE = /^(?:claude|pi)[a-z0-9-]*:[A-Za-z0-9._:-]{1,128}$/;
export const GATEWAY_IDENTITY_HEADERS: ReadonlySet<string> = new Set(["x-lgw-cache-key", "x-user-id"]);

/** Whether a caller's value may be forwarded under this header name: gateway identities need a launcher's form. */
export function forwardedClientHeaderValueAllowed(name: string, value: string): boolean {
  return !GATEWAY_IDENTITY_HEADERS.has(name) || GATEWAY_IDENTITY_VALUE.test(value);
}

/** The provider's opted-in caller metadata that passes the name allowlist and the value gate, in configured order. */
export function forwardableClientHeaders(
  forwardClientHeaders: readonly string[] | undefined, incoming: Headers,
): Array<[name: string, value: string]> {
  if (!Array.isArray(forwardClientHeaders)) return [];
  const forwardable: Array<[string, string]> = [];
  for (const rawName of forwardClientHeaders.slice(0, MAX_FORWARDED_CLIENT_HEADERS)) {
    const name = normalizeForwardedClientHeaderName(rawName);
    const value = name === null ? null : incoming.get(name);
    if (name !== null && value && forwardedClientHeaderValueAllowed(name, value)) forwardable.push([name, value]);
  }
  return forwardable;
}

/** Copy the provider's opted-in caller metadata onto outbound headers it has not already set. */
export function copyForwardedClientHeaders(
  forwardClientHeaders: readonly string[] | undefined, headers: Record<string, string>, incoming: Headers,
): void {
  for (const [name, value] of forwardableClientHeaders(forwardClientHeaders, incoming)) {
    if (!Object.keys(headers).some(existing => existing.toLowerCase() === name)) headers[name] = value;
  }
}
