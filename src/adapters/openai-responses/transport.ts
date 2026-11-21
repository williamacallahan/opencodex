import type { HandleResponsesOptions } from "../../server/responses/core-options";
import type { CodexAuthContext } from "../../codex/auth-context";
import type { DataPlaneAdmission } from "../../server/auth-cors";
import { isPlainObject } from "../../lib/plain-data";
import type { IncomingMeta, ProviderAdapter } from "../base";
import type { OcxProviderConfig } from "../../types";
import {
  FORWARD_HEADERS,
  CODEX_ATTESTATION_HEADER,
  CODEX_RESPONSES_LITE_HEADER,
  isolateCodexPoolAccountHeaders,
} from "../../codex/forward-transport-headers";
import { isCanonicalOpenAiForwardProvider, responsesTransportUrl } from "../../providers/openai-tiers-destination";
import { copyForwardedClientHeaders, forwardableClientHeaders } from "../../lib/provider-client-headers";
import { AGENT_ASSERTION_HEADER } from "../../lib/authorization-scheme";
import { isCodexLbResponsesEndpoint } from "../../providers/quota/codex-lb-url";
import { isThreadSpawnRequest } from "../../server/effort-policy";
import { callerSessionAlias, claudeTranscriptQualifier, safeCallerSessionId, scopedWireHash } from "../../server/caller-session-identity";
import { agentServingThreadKey } from "../../oauth/session-affinity-key";

export { responsesTransportUrl };
export { FORWARD_HEADERS } from "../../codex/forward-transport-headers";

/** Copy the provider's opted-in client metadata onto already-materialized auth headers, never credentials. */
export function copyConfiguredClientHeaders(target: Headers, incoming: Headers, provider: OcxProviderConfig): void {
  for (const [name, value] of forwardableClientHeaders(provider.forwardClientHeaders, incoming)) {
    if (!target.has(name)) target.set(name, value);
  }
}

/** Carry permitted client metadata across an internal compact handoff, never credentials. */
export function copyResponsesClientMetadata(target: Headers, incoming: Headers, provider: OcxProviderConfig): void {
  const userAgent = incoming.get("user-agent");
  if (userAgent && !target.has("user-agent")) target.set("user-agent", userAgent);
  copyConfiguredClientHeaders(target, incoming, provider);
}

/** Normalize caller aliases only on native egress; preserve ingress and fallback identity. */
export function withClaudeNativeSession(headers: Headers, provider: OcxProviderConfig, sessionId?: string): Headers {
  // Empty values count as absent, matching materializeCodexUpstreamAuth, so first attempts and
  // retries rebuilt from caller headers pick the same identity.
  if (!isCanonicalOpenAiForwardProvider(provider) || headers.get("session_id")) return headers;
  // A sanitized caller-header copy can still carry the original x-session-id. Do not turn
  // its distinct thread into a contradictory session alias before an account retry reads it.
  const alias = ["session-id", "x-session-id", "thread-id"].find(name => headers.get(name));
  const nativeSession = alias ? safeCallerSessionId(headers.get(alias)) : sessionId;
  // A non-empty invalid alias suppresses weaker metadata identity.
  if (!nativeSession) return headers;
  const forwarded = new Headers(headers);
  forwarded.set("session_id", nativeSession);
  return forwarded;
}

/** Format a 32-hex cache key as a uuid-shaped session id (version/variant nibbles forced). */
export function claudeWireSessionId(hex32: string): string {
  const h = (hex32 + "0".repeat(32)).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Only these two Responses endpoints serve Codex relay requests, not arbitrary paths on the same host. */
export function isCodexRelaySend(provider: OcxProviderConfig, target?: string): boolean {
  return !!provider.apiKey && isCodexLbResponsesEndpoint(provider, provider.adapter, target);
}

function withoutCallerContinuity(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  for (const name of ["session_id", "session-id", "x-session-id", "thread-id", "x-codex-parent-thread-id"]) headers.delete(name);
  return headers;
}

/** Project the admitted caller's identity at each build, without changing the parsed request
 * or the selected account's credential headers. The retry must start with its scrubbed body. */
export function bindSharedCodexWireIdentity(
  adapter: ProviderAdapter, provider: OcxProviderConfig, callerHeaders: Headers,
  admission: DataPlaneAdmission | undefined, accountKind: CodexAuthContext["kind"], claudeWire?: HandleResponsesOptions["claudeCodexWire"],
): void {
  if (claudeWire && (isCodexRelaySend(provider) || isCanonicalOpenAiForwardProvider(provider))) {
    const session = accountKind === "main" && isCanonicalOpenAiForwardProvider(provider)
      ? claudeWire.ownedDirectSessionId ?? claudeWire.sessionId : claudeWire.sessionId;
    const build = adapter.buildRequest.bind(adapter);
    adapter.buildRequest = (parsed, incoming) => {
      const headers = withoutCallerContinuity(incoming.headers);
      if (session !== null) {
        const thread = safeCallerSessionId(incoming.headers.get("thread-id"));
        for (const [name, id] of Object.entries(claudeWirePair(session, thread, parsed._claudeAgentId))) headers.set(name, id);
      }
      if (claudeWire.cacheKey === undefined) return build({ ...parsed, _sessionScopedCacheKey: undefined }, { ...incoming, headers });
      // A rejected alias cannot fall back to the generic translator's metadata-derived key.
      const key = claudeWire.cacheKey ?? undefined;
      const raw = parsed._rawBody;
      return build({ ...parsed, _sessionScopedCacheKey: undefined, _promptCacheKeyIsSharedCohort: false,
        options: { ...parsed.options, promptCacheKey: key },
        _rawBody: isPlainObject(raw) ? { ...raw, prompt_cache_key: key } : raw,
      }, { ...incoming, headers });
    };
    return;
  }
  if (!admission || admission.kind === "loopback") return;
  const shared = isCodexRelaySend(provider) || (isCanonicalOpenAiForwardProvider(provider)
    && (accountKind !== "main" || admission.source === "bearer"));
  if (!shared) return;
  const principal = admission.contextPrincipalId;
  const admittedAlias = callerSessionAlias(callerHeaders, admission);
  const build = adapter.buildRequest.bind(adapter);
  adapter.buildRequest = (requestParsed, incoming) => {
    if (requestParsed._sessionScopedCacheKey) return build(requestParsed, incoming);
    const original = incoming.headers;
    const headers = withoutCallerContinuity(original);
    if (principal && admittedAlias !== null) {
      const thread = safeCallerSessionId(original.get("thread-id"));
      const parent = safeCallerSessionId(original.get("x-codex-parent-thread-id"));
      const session = admittedAlias ?? thread;
      if (session) {
        const wireSession = scopedWireHash(principal, session);
        headers.set("session_id", wireSession);
        headers.set("session-id", wireSession);
        if (!thread && !parent) headers.set("thread-id", wireSession);
      }
      if (thread) headers.set("thread-id", scopedWireHash(principal, thread));
      if (parent) headers.set("x-codex-parent-thread-id", scopedWireHash(principal, parent));
    }
    let wireParsed = requestParsed;
    const raw = requestParsed._rawBody;
    if (isPlainObject(raw) && typeof raw.prompt_cache_key === "string") {
      const key = principal ? scopedWireHash(principal, raw.prompt_cache_key) : undefined;
      wireParsed = { ...requestParsed, _rawBody: { ...raw, prompt_cache_key: key }, options: { ...requestParsed.options, promptCacheKey: key } };
    }
    return build(wireParsed, { ...incoming, headers });
  };
}

function claudeWirePair(session: string, thread: string | undefined, agent: string | undefined) {
  return { session_id: session, "session-id": session, "thread-id": agentServingThreadKey(session, claudeTranscriptQualifier(thread, agent)) };
}

/** Project stable conversation identity independently of per-turn state. */
export function applyCodexLbThreadHeaders(
  provider: OcxProviderConfig, headers: Record<string, string>, incoming: Headers,
  identity: { sessionScopedCacheKey?: string; claudeAgentId?: string },
): void {
  const relay = isCodexRelaySend(provider);
  if (!relay && !isCanonicalOpenAiForwardProvider(provider)) return;
  const root = identity.sessionScopedCacheKey;
  const thread = safeCallerSessionId(incoming.get("thread-id"));
  if (root) {
    if (isThreadSpawnRequest(incoming) && !thread) return;
    const session = claudeWireSessionId(root);
    // A translated caller did not authenticate the upstream tuple. Replace, don't adopt it.
    for (const name of Object.keys(headers)) {
      if (["session_id", "session-id", "thread-id", "x-codex-parent-thread-id"].includes(name.toLowerCase())) delete headers[name];
    }
    Object.assign(headers, claudeWirePair(session, thread, identity.claudeAgentId));
    return;
  }
  if (!relay) return;
  const alias = callerSessionAlias(incoming);
  const parent = safeCallerSessionId(incoming.get("x-codex-parent-thread-id"));
  if (alias === null || (!thread && incoming.has("thread-id")) || (!parent && incoming.has("x-codex-parent-thread-id"))) return;
  const session = alias ?? thread ?? parent;
  if (!session) return;
  if (parent) headers["x-codex-parent-thread-id"] = parent;
  headers.session_id = headers["session-id"] = session;
  headers["thread-id"] = thread ?? session;
}

/** Shared Responses URL/auth/header construction; capabilities never grant auth authority. */
export function buildResponsesTransport(provider: OcxProviderConfig, incoming: Pick<IncomingMeta, "headers">): {
  url: string; headers: Record<string, string>;
} {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const url = responsesTransportUrl(provider);
  if (provider.authMode === "forward") {
    const mayForwardCallerCredentials = isCanonicalOpenAiForwardProvider(provider);
    if (provider.headers) Object.assign(headers, provider.headers);
    const runtimeProvider = provider as {
      _codexAccountOverride?: { accessToken: string; chatgptAccountId: string; kind?: "pool" | "main-pool" };
      _codexAccountRequired?: boolean;
    };
    if (mayForwardCallerCredentials && runtimeProvider._codexAccountRequired && !runtimeProvider._codexAccountOverride) {
      throw new Error("Codex pool account auth is required but unavailable");
    }
    if (mayForwardCallerCredentials) {
      // Caller-existence gates also apply when provider defaults use mixed casing.
      for (const name of Object.keys(headers)) {
        if (["x-codex-installation-id", "x-codex-turn-metadata", CODEX_ATTESTATION_HEADER].includes(name.toLowerCase())) delete headers[name];
      }
      for (const name of FORWARD_HEADERS) {
        const value = incoming.headers.get(name);
        if (value === null) continue;
        if (name === CODEX_RESPONSES_LITE_HEADER) {
          for (const existing of Object.keys(headers)) {
            if (existing.toLowerCase() === name) delete headers[existing];
          }
        }
        headers[name] = value;
      }
    }
    const override = runtimeProvider._codexAccountOverride;
    if (override && mayForwardCallerCredentials) {
      const selected = new Headers(headers);
      selected.set("authorization", `Bearer ${override.accessToken}`);
      selected.set("chatgpt-account-id", override.chatgptAccountId);
      selected.delete(CODEX_ATTESTATION_HEADER);
      if (override.kind !== "main-pool") isolateCodexPoolAccountHeaders(selected, override.chatgptAccountId);
      // Replace every casing of managed fields after static headers and caller headers merge.
      for (const name of Object.keys(headers)) delete headers[name];
      selected.forEach((value, name) => { headers[name] = value; });
    } else if (mayForwardCallerCredentials) {
      // dual_header runtime assertion: first-party Direct only, beside the caller's own Bearer.
      // A pool override above never carries it, and non-canonical transports never see it.
      const assertion = incoming.headers.get(AGENT_ASSERTION_HEADER);
      if (assertion) headers[AGENT_ASSERTION_HEADER] = assertion;
    }
  } else {
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    if (provider.headers) Object.assign(headers, provider.headers);
  }
  copyForwardedClientHeaders(provider.forwardClientHeaders, headers, incoming.headers);
  if (!Object.keys(headers).some(name => name.toLowerCase() === "user-agent")) {
    const userAgent = incoming.headers.get("user-agent");
    if (userAgent) headers["User-Agent"] = userAgent;
  }
  return { url, headers };
}
