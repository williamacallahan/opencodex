import type { RequestAttribution } from "../server/request-attribution";

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
  // Preserve caller-supplied identifiers only when the provider explicitly opts in.
  // Do not admit arbitrary x-codex-* fields or authentication evidence.
  "x-codex-window-id", "x-codex-installation-id",
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

const USER_ID_HEADER = "x-user-id";
const MAX_WORKLOAD_PRODUCT_LENGTH = 40;
/** Operation half of every hub-derived workload label: the request reached the gateway through the hub. */
export const HUB_WORKLOAD_OPERATION = "via-opencodex";
// The hub's own derived label survives the hub's internal header rebuilds, which re-apply this gate; its fixed
// operation always shows the label was assigned by the hub.
const HUB_DERIVED_WORKLOAD_VALUE = new RegExp(`^[a-z0-9-]{1,40}:(?:${HUB_WORKLOAD_OPERATION}|hub-internal)$`);
// A launcher sends `<launcher>:<session or operation>` (`claude-av:<session>`, `codex-oc:<id>`,
// `claude-code:codeAgent`): a lowercase launcher name of at most 32 characters, then the label.
const GATEWAY_IDENTITY_VALUE = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9._:-]{1,128}$/;
const HUB_OPERATION_SUFFIXES = [`:${HUB_WORKLOAD_OPERATION}`, ":hub-internal"];
export const GATEWAY_IDENTITY_HEADERS: ReadonlySet<string> = new Set(["x-lgw-cache-key", "x-user-id"]);

/**
 * Whether a caller's own gateway identity has a launcher's form. A value ending in one of the
 * hub's operations is not declarable: that suffix is how a hub-derived label is recognized.
 */
export function isDeclaredGatewayIdentity(value: string): boolean {
  return GATEWAY_IDENTITY_VALUE.test(value) && !HUB_OPERATION_SUFFIXES.some(suffix => value.endsWith(suffix));
}

/**
 * Whether a provider row opted in to gateway attribution: its `forwardClientHeaders` names `x-user-id` or
 * `x-lgw-cache-key`. Only such a row (an LLM gateway or the codex-lb relay) receives the caller's workload,
 * conversation, machine name or address; every other row receives none of them.
 */
export function optsInToGatewayAttribution(forwardClientHeaders: readonly string[] | undefined): boolean {
  return Array.isArray(forwardClientHeaders) && forwardClientHeaders.slice(0, MAX_FORWARDED_CLIENT_HEADERS)
    .some(raw => { const name = normalizeForwardedClientHeaderName(raw); return name !== null && GATEWAY_IDENTITY_HEADERS.has(name); });
}

/** Whether a caller's value may be forwarded under this header name: gateway identities need a launcher's form. */
export function forwardedClientHeaderValueAllowed(name: string, value: string): boolean {
  if (!GATEWAY_IDENTITY_HEADERS.has(name)) return true;
  return isDeclaredGatewayIdentity(value) || (name === USER_ID_HEADER && HUB_DERIVED_WORKLOAD_VALUE.test(value));
}

/** The gateway attribution headers (`X-User-ID` and every `X-LGW-*`), which no vendor pass-through forwards. */
export function isGatewayAttributionHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === USER_ID_HEADER || lower.startsWith("x-lgw-");
}

/** Product half of a workload label from the caller's own User-Agent (else originator): `claude-cli/2.1 (...)` is `claude-code`. */
function clientProductFromHeaders(incoming: Headers): string {
  for (const raw of [incoming.get("user-agent"), incoming.get("originator")]) {
    const token = (raw ?? "").trim().toLowerCase().split(/[\/\s(]/, 1)[0]!.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!token) continue;
    if (token.startsWith("claude")) return "claude-code";
    if (token.startsWith("codex")) return "codex";
    return token.slice(0, MAX_WORKLOAD_PRODUCT_LENGTH);
  }
  return "unknown-client";
}

/**
 * The gateway workload label ('<product>:<operation>') for a caller that sent none in a launcher's form:
 * its client product, derived by the hub, plus the fixed operation naming the hub path. No incoming
 * request at all is a hub-originated call.
 */
export function deriveClientWorkloadLabel(incoming: Headers | undefined): string {
  return incoming ? `${clientProductFromHeaders(incoming)}:${HUB_WORKLOAD_OPERATION}` : "opencodex:hub-internal";
}

/**
 * The provider's opted-in caller metadata that passes the name allowlist and the value gate, in configured order.
 * An opted-in `x-user-id` is never absent. With the admitted request's attribution it is that attribution's
 * workload (declared, else the harness session, else the hub label) and `x-lgw-cache-key` is only the caller's
 * declared one; without it (a hub-originated call) the incoming value or the derived label is used. An
 * opted-in `user-agent` absent from the incoming headers (an internal hop) is the attribution's recorded one. A row opted in
 * to either gateway identity header is an LLM gateway row, so it also gets the caller's validated machine name and
 * the address the hub observed. No other row receives any of these.
 */
export function forwardableClientHeaders(
  forwardClientHeaders: readonly string[] | undefined, incoming: Headers | undefined, attribution?: RequestAttribution,
): Array<[name: string, value: string]> {
  if (!Array.isArray(forwardClientHeaders)) return [];
  const forwardable: Array<[string, string]> = [];
  for (const rawName of forwardClientHeaders.slice(0, MAX_FORWARDED_CLIENT_HEADERS)) {
    const name = normalizeForwardedClientHeaderName(rawName);
    if (name === null) continue;
    const identity = attribution && GATEWAY_IDENTITY_HEADERS.has(name);
    // An internal hop's rebuilt headers lose the caller's User-Agent; the admitted request recorded it, sanitized.
    const value = identity ? (name === USER_ID_HEADER ? attribution.workload : attribution.conversationKey)
      : name === "user-agent" ? incoming?.get(name) ?? attribution?.userAgent : incoming?.get(name);
    if (value && forwardedClientHeaderValueAllowed(name, value)) forwardable.push([name, value]);
    else if (name === USER_ID_HEADER) forwardable.push([name, deriveClientWorkloadLabel(incoming)]);
  }
  const gatewayRow = optsInToGatewayAttribution(forwardClientHeaders);
  if (gatewayRow && attribution?.clientHost) forwardable.push(["x-lgw-client-host", attribution.clientHost]);
  if (gatewayRow && attribution?.clientAddress) forwardable.push(["x-lgw-client-address", attribution.clientAddress]);
  return forwardable;
}

/** Copy the provider's opted-in caller metadata onto outbound headers it has not already set. */
export function copyForwardedClientHeaders(
  forwardClientHeaders: readonly string[] | undefined, headers: Record<string, string>, incoming: Headers | undefined,
  attribution?: RequestAttribution,
): void {
  for (const [name, value] of forwardableClientHeaders(forwardClientHeaders, incoming, attribution)) {
    if (!Object.keys(headers).some(existing => existing.toLowerCase() === name)) headers[name] = value;
  }
}
