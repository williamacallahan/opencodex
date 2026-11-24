import { normalizeProxyAddress } from "../config/dashboard-trusted-proxy";
import { assessUrlDestination } from "../lib/destination-policy";
import { deriveClientWorkloadLabel, forwardedClientHeaderValueAllowed } from "../lib/provider-client-headers";
import { sanitizeLogMetadataString } from "../lib/redact";

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
  /** The declared `X-User-ID` in a launcher's form, else the hub-derived `<product>:via-opencodex` label. */
  workload?: string;
  /** The declared `X-LGW-Cache-Key` conversation identity. */
  conversationKey?: string;
  /** The declared `X-LGW-Client-Host` device name. */
  clientHost?: string;
}

const MAX_USER_AGENT_LENGTH = 512;
const MAX_FORWARDED_FOR_LENGTH = 256;
const MAX_WORKLOAD_LENGTH = 256;
const CLIENT_HOST = /^[A-Za-z0-9-]{1,63}$/;
const ADDRESS_FIELDS = ["peerAddress", "clientAddress"] as const;

function ipAddress(value: string | null | undefined): string | undefined {
  return value ? normalizeProxyAddress(value) ?? undefined : undefined;
}

function isLocalPeer(address: string): boolean {
  const kind = assessUrlDestination(`http://${address.includes(":") ? `[${address}]` : address}/`)?.kind;
  return kind === "loopback" || kind === "private";
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
  return value && forwardedClientHeaderValueAllowed(name, value) ? value : undefined;
}

/**
 * The one computation of a request's attribution. `peerAddress` is the listener's `requestIP()`;
 * X-Forwarded-For is trusted for the client address only when that peer is loopback or private,
 * and then only its rightmost entry, which the local proxy appended itself.
 */
export function computeRequestAttribution(req: Request, peerAddress: string | undefined): RequestAttribution {
  const headers = req.headers;
  const peer = ipAddress(peerAddress);
  const rawForwarded = headers.get("x-forwarded-for");
  const forwarded = forwardedForChain(rawForwarded);
  const proxied = peer !== undefined && isLocalPeer(peer) ? ipAddress(rawForwarded?.split(",").at(-1)) : undefined;
  const clientAddress = proxied ?? peer;
  const userAgent = sanitizeLogMetadataString(headers.get("user-agent"), MAX_USER_AGENT_LENGTH);
  const conversationKey = declaredGatewayIdentity(headers, "x-lgw-cache-key");
  const clientHost = headers.get("x-lgw-client-host")?.trim();
  return {
    ...(userAgent ? { userAgent } : {}),
    ...(peer ? { peerAddress: peer } : {}),
    ...(forwarded.length ? { forwardedFor: forwarded.join(", ") } : {}),
    ...(clientAddress ? { clientAddress } : {}),
    workload: declaredGatewayIdentity(headers, "x-user-id") ?? deriveClientWorkloadLabel(headers),
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
  const fields: RequestAttribution = {
    ...(userAgent ? { userAgent } : {}),
    ...(forwardedFor ? { forwardedFor } : {}),
    ...(workload ? { workload } : {}),
    ...(conversationKey ? { conversationKey } : {}),
    ...(typeof source.clientHost === "string" && CLIENT_HOST.test(source.clientHost) ? { clientHost: source.clientHost } : {}),
  };
  for (const name of ADDRESS_FIELDS) {
    const address = typeof source[name] === "string" ? ipAddress(source[name]) : undefined;
    if (address) fields[name] = address;
  }
  return fields;
}
