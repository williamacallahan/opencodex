import { normalizeProxyAddress } from "../config/dashboard-trusted-proxy";
import { deriveClientWorkloadLabel, HUB_WORKLOAD_OPERATION, isDeclaredGatewayIdentity } from "../lib/provider-client-headers";
import { sanitizeLogMetadataString } from "../lib/redact";
import { classifyUsageClient, normalizeRecordedClient, type UsageClient } from "../usage/client";
import { safeCallerSessionId } from "./caller-session-identity";

/**
 * Who sent a request, as the caller declared it and as the listener observed it. Every value is
 * observational: admission, routing, account selection, and cache keys never read it.
 */
export interface RequestAttribution {
  /** The caller's User-Agent (the harness), sanitized and capped. */
  userAgent?: string;
  /** The kernel-observed socket peer of the listener. */
  peerAddress?: string;
  /** The IP entries of X-Forwarded-For, in order. */
  forwardedFor?: string;
  /** The caller's address: the proxy-appended X-Forwarded-For entry behind a local proxy, else the peer. */
  clientAddress?: string;
  /** The harness, classified once from the original request. */
  client?: UsageClient;
  /** The harness's own session id from its native header, read before any session rewriting. */
  harnessSessionId?: string;
  /** The harness's own agent or thread id within that session, when it sends one. */
  harnessAgentId?: string;
  /** The declared `X-User-ID`, else `<harness>:<harnessSessionId>`, else the hub-derived `<product>:via-opencodex` label. */
  workload?: string;
  /** Which of the three `workload` came from. Rows written before it existed carry none. */
  workloadSource?: WorkloadSource;
  /** The declared `X-LGW-Cache-Key` conversation identity. */
  conversationKey?: string;
  /** The declared `X-LGW-Client-Host` device name. */
  clientHost?: string;
}

/** `declared`: the caller's `X-User-ID`; `harness`: built from its native session id; `hub`: the hub's fallback label. */
export type WorkloadSource = "declared" | "harness" | "hub";
const WORKLOAD_SOURCES: ReadonlySet<string> = new Set<WorkloadSource>(["declared", "harness", "hub"]);

// The first one present names the session; a present value that fails validation is dropped, never
// replaced by a later header. Account and installation identifiers are never read.
const NATIVE_SESSION_HEADERS = ["x-claude-code-session-id", "x-amp-thread-id", "x-opencode-session", "session_id", "session-id"] as const;

const MAX_USER_AGENT_LENGTH = 512;
const MAX_FORWARDED_FOR_LENGTH = 256;
const MAX_WORKLOAD_LENGTH = 256;
const CLIENT_HOST = /^[A-Za-z0-9-]{1,63}$/;
const ADDRESS_FIELDS = ["peerAddress", "clientAddress"] as const;

function ipAddress(value: string | null | undefined): string | undefined {
  return value ? normalizeProxyAddress(value) ?? undefined : undefined;
}

function forwardedForChain(header: string | null): string[] {
  const chain: string[] = [];
  let length = 0;
  for (const raw of header?.split(",") ?? []) {
    const address = ipAddress(raw);
    if (!address) continue;
    length += address.length + (chain.length ? 2 : 0);
    if (length > MAX_FORWARDED_FOR_LENGTH) break;
    chain.push(address);
  }
  return chain;
}

function declaredGatewayIdentity(headers: Headers, name: "x-user-id" | "x-lgw-cache-key"): string | undefined {
  const value = headers.get(name)?.trim();
  return value && isDeclaredGatewayIdentity(value) ? value : undefined;
}

function nativeSessionId(headers: Headers): string | undefined {
  const name = NATIVE_SESSION_HEADERS.find(candidate => headers.has(candidate));
  return name ? safeCallerSessionId(headers.get(name)) : undefined;
}

function nativeAgentId(headers: Headers, session: string | undefined): string | undefined {
  const agent = safeCallerSessionId(headers.get("x-claude-code-agent-id"));
  if (agent) return agent;
  const thread = safeCallerSessionId(headers.get("thread-id"));
  return thread !== session ? thread : undefined;
}

/** The workload and its source: a declared `X-User-ID`, else the harness session, else the hub's label. */
export function resolveWorkload(headers: Headers, client: UsageClient, harnessSessionId: string | undefined): { workload: string; workloadSource: WorkloadSource } {
  const declared = declaredGatewayIdentity(headers, "x-user-id");
  if (declared) return { workload: declared, workloadSource: "declared" };
  const harness = harnessSessionId && `${client.replaceAll("_", "-")}:${harnessSessionId}`;
  if (harness && isDeclaredGatewayIdentity(harness)) return { workload: harness, workloadSource: "harness" };
  return { workload: deriveClientWorkloadLabel(headers), workloadSource: "hub" };
}

/**
 * The attribution of a harness that names its session only in the request body (agy): the session and
 * agent ids pass the same validation as a header-borne id, and an undeclared workload becomes
 * `<product>:<session>`, keeping the product half of the hub's own label. Fields that fail are dropped.
 */
export function withBodyHarnessSession(attribution: RequestAttribution, session: string | undefined, agent: string | undefined): RequestAttribution {
  const harnessSessionId = session === undefined ? undefined : safeCallerSessionId(session);
  if (!harnessSessionId) return attribution;
  const harnessAgentId = agent === undefined ? undefined : safeCallerSessionId(agent);
  const product = attribution.workloadSource === "hub" ? attribution.workload?.split(":", 1)[0] : undefined;
  const workload = product === undefined ? undefined : `${product}:${harnessSessionId}`;
  return {
    ...attribution, harnessSessionId, ...(harnessAgentId ? { harnessAgentId } : {}),
    ...(workload !== undefined && isDeclaredGatewayIdentity(workload) ? { workload, workloadSource: "harness" as const } : {}),
  };
}

/**
 * The hub's own label with a fixed operation in place of `via-opencodex` (`antigravity:quota`), so a class of
 * calls that names no session can be filtered on its own. Only a hub-sourced workload changes; a declared or
 * harness workload, and every other field, stay as they are.
 */
export function withHubWorkloadOperation(attribution: RequestAttribution, operation: string | undefined): RequestAttribution {
  if (operation === undefined || attribution.workloadSource !== "hub" || attribution.workload === undefined) return attribution;
  return { ...attribution, workload: `${attribution.workload.split(":", 1)[0]}:${operation}` };
}

/**
 * The workload an internal hop carries for its caller: the admitted attribution's, else the same rule
 * applied to the caller's own request. The hop's rebuilt headers lose the caller's User-Agent and
 * native session, so neither may be derived from them.
 */
export function requestWorkload(req: Request, attribution: RequestAttribution | undefined): string {
  return attribution?.workload
    ?? resolveWorkload(req.headers, classifyUsageClient(req.headers, new URL(req.url).pathname), nativeSessionId(req.headers)).workload;
}

/**
 * The one computation of a request's attribution. `peerAddress` is the listener's `requestIP()`.
 * Forwarding headers name the caller only when `peerIsTrustedProxy` (the peer is one of
 * `dashboardTrustedProxy.proxyAddresses`): then the rightmost X-Forwarded-For entry, which that
 * proxy appended itself, else its X-Real-IP. A caller connecting directly, from loopback or a LAN
 * included, could write either header, so its own peer address is recorded instead.
 */
export function computeRequestAttribution(req: Request, peerAddress: string | undefined, peerIsTrustedProxy = false): RequestAttribution {
  const headers = req.headers;
  const client = classifyUsageClient(headers, new URL(req.url).pathname);
  const harnessSessionId = nativeSessionId(headers);
  const harnessAgentId = nativeAgentId(headers, harnessSessionId);
  const peer = ipAddress(peerAddress);
  const rawForwarded = peerIsTrustedProxy ? headers.get("x-forwarded-for") : null;
  const forwarded = forwardedForChain(rawForwarded);
  const proxied = peerIsTrustedProxy ? ipAddress(rawForwarded?.split(",").at(-1)) ?? ipAddress(headers.get("x-real-ip")) : undefined;
  const clientAddress = proxied ?? peer;
  const userAgent = sanitizeLogMetadataString(headers.get("user-agent"), MAX_USER_AGENT_LENGTH);
  const conversationKey = declaredGatewayIdentity(headers, "x-lgw-cache-key");
  const clientHost = headers.get("x-lgw-client-host")?.trim();
  return {
    ...(userAgent ? { userAgent } : {}),
    ...(peer ? { peerAddress: peer } : {}),
    ...(forwarded.length ? { forwardedFor: forwarded.join(", ") } : {}),
    ...(clientAddress ? { clientAddress } : {}),
    client,
    ...(harnessSessionId ? { harnessSessionId } : {}),
    ...(harnessAgentId ? { harnessAgentId } : {}),
    ...resolveWorkload(headers, client, harnessSessionId),
    ...(conversationKey ? { conversationKey } : {}),
    ...(clientHost && CLIENT_HOST.test(clientHost) ? { clientHost } : {}),
  };
}

/**
 * The attribution fields of a stored or in-flight row, re-bounded so a hand-edited usage file
 * cannot widen them. Rows written before attribution existed carry none and project to `{}`.
 */
export function requestAttributionLogFields(source: RequestAttribution | undefined): RequestAttribution {
  if (!source) return {};
  const userAgent = sanitizeLogMetadataString(source.userAgent, MAX_USER_AGENT_LENGTH);
  const forwardedFor = sanitizeLogMetadataString(source.forwardedFor, MAX_FORWARDED_FOR_LENGTH);
  const workload = sanitizeLogMetadataString(source.workload, MAX_WORKLOAD_LENGTH);
  const conversationKey = sanitizeLogMetadataString(source.conversationKey, MAX_WORKLOAD_LENGTH);
  const harnessSessionId = typeof source.harnessSessionId === "string" ? safeCallerSessionId(source.harnessSessionId) : undefined;
  const harnessAgentId = typeof source.harnessAgentId === "string" ? safeCallerSessionId(source.harnessAgentId) : undefined;
  const fields: RequestAttribution = {
    ...(userAgent ? { userAgent } : {}),
    ...(forwardedFor ? { forwardedFor } : {}),
    ...(harnessSessionId ? { harnessSessionId } : {}),
    ...(harnessAgentId ? { harnessAgentId } : {}),
    ...(workload ? { workload } : {}),
    ...(typeof source.workloadSource === "string" && WORKLOAD_SOURCES.has(source.workloadSource) ? { workloadSource: source.workloadSource } : {}),
    ...(conversationKey ? { conversationKey } : {}),
    ...(typeof source.clientHost === "string" && CLIENT_HOST.test(source.clientHost) ? { clientHost: source.clientHost } : {}),
  };
  for (const name of ADDRESS_FIELDS) {
    const address = typeof source[name] === "string" ? ipAddress(source[name]) : undefined;
    if (address) fields[name] = address;
  }
  return fields;
}

/** The attribution filters `/api/request-history` and `/api/usage` accept. */
export interface RequestAttributionFilter {
  workload?: string;
  clientHost?: string;
  clientAddress?: string;
  /** Only rows from this harness (`client`). */
  harness?: UsageClient;
  /** Only rows carrying this native harness session id. */
  harnessSession?: string;
  /** Only rows whose caller declared no workload: its source is `harness` or `hub`. */
  undeclared?: boolean;
}

/** The attribution filters in a management query string; blank values are absent. */
export function parseAttributionFilter(params: URLSearchParams): RequestAttributionFilter {
  const workload = params.get("workload")?.trim();
  const clientHost = params.get("clientHost")?.trim();
  const clientAddress = ipAddress(params.get("clientAddress")) ?? params.get("clientAddress")?.trim();
  // An unrecognized harness filters to `unknown` rows, the same normalization a stored row gets.
  const harness = params.get("harness")?.trim() ? normalizeRecordedClient(params.get("harness")?.trim()) : undefined;
  const harnessSession = params.get("harnessSession")?.trim();
  return {
    ...(workload ? { workload } : {}),
    ...(clientHost ? { clientHost } : {}),
    ...(clientAddress ? { clientAddress } : {}),
    ...(harness ? { harness } : {}),
    ...(harnessSession ? { harnessSession } : {}),
    ...(params.get("undeclared") === "true" ? { undeclared: true } : {}),
  };
}

/** The suffix that marks a workload label the hub derived for an undeclared caller. */
export const UNDECLARED_WORKLOAD_SUFFIX = `:${HUB_WORKLOAD_OPERATION}`;

/**
 * A row's workload source. Rows written before `workloadSource` existed are classified by the
 * old rule: a workload ending in the hub's suffix was derived by the hub, any other was declared.
 */
export function rowWorkloadSource(row: Pick<RequestAttribution, "workload" | "workloadSource">): WorkloadSource | undefined {
  if (row.workloadSource) return row.workloadSource;
  if (!row.workload) return undefined;
  return row.workload.endsWith(UNDECLARED_WORKLOAD_SUFFIX) ? "hub" : "declared";
}

/** The workload sources `undeclared=true` selects. */
export const UNDECLARED_WORKLOAD_SOURCES = ["harness", "hub"] as const satisfies ReadonlyArray<WorkloadSource>;

/** Whether a row's attribution satisfies every set filter. */
export function matchesAttributionFilter(row: RequestAttribution, filter: RequestAttributionFilter): boolean {
  if (filter.workload !== undefined && row.workload !== filter.workload) return false;
  if (filter.clientHost !== undefined && row.clientHost !== filter.clientHost) return false;
  if (filter.clientAddress !== undefined && row.clientAddress !== filter.clientAddress) return false;
  if (filter.harness !== undefined && row.client !== filter.harness) return false;
  if (filter.harnessSession !== undefined && row.harnessSessionId !== filter.harnessSession) return false;
  const source = rowWorkloadSource(row);
  return !filter.undeclared || (source !== undefined && source !== "declared");
}

/** Set `name` unless the outbound headers already carry it in any casing. */
function setIfAbsent(headers: Record<string, string>, name: string, value: string | undefined): void {
  if (value !== undefined && !Object.keys(headers).some(existing => existing.toLowerCase() === name.toLowerCase())) headers[name] = value;
}

/**
 * The caller's identity on an outbound request to the codex-lb relay, which records it per row.
 * Configured or forwarded values win for the caller-declared headers; X-LGW-Client-Address is the
 * hub's own observation, so every caller-supplied casing of it is dropped first. A caller that
 * declared no conversation but sent a native session gets its harness workload as X-LGW-Cache-Key:
 * codex-lb reads that header only as the logged conversation id of a request with none of its own,
 * never as a sticky or prompt-cache routing input.
 * Session, thread, and prompt-cache identity are not touched.
 */
export function applyCodexLbAttributionHeaders(headers: Record<string, string>, attribution: RequestAttribution): void {
  for (const name of Object.keys(headers)) if (name.toLowerCase() === "x-lgw-client-address") delete headers[name];
  if (attribution.clientAddress) headers["X-LGW-Client-Address"] = attribution.clientAddress;
  setIfAbsent(headers, "User-Agent", attribution.userAgent);
  setIfAbsent(headers, "X-User-ID", attribution.workload);
  setIfAbsent(headers, "X-LGW-Cache-Key", attribution.conversationKey
    ?? (attribution.workloadSource === "harness" ? attribution.workload : undefined));
  setIfAbsent(headers, "X-LGW-Client-Host", attribution.clientHost);
}
