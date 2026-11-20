/** Promote third-party conversation markers after ingress authentication and origin checks. */
import type { DataPlaneAdmission } from "./auth-cors";

const SESSION_HEADERS = ["session_id", "session-id", "thread-id"] as const;
const SAFE_CALLER_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function safeCallerSessionId(raw: string | null): string | undefined {
  const value = raw?.trim();
  return value && SAFE_CALLER_SESSION_ID.test(value) ? value : undefined;
}

/** null means conflicting or unsafe aliases, not an invitation to use a weaker identity. */
export function callerSessionAlias(headers: Headers, admission?: DataPlaneAdmission): string | null | undefined {
  const underscore = headers.get("session_id");
  const hyphen = headers.get("session-id");
  const external = headers.get("x-session-id");
  if (underscore && hyphen && underscore !== hyphen) return null;
  const native = underscore || hyphen;
  if (native && external && native !== external) {
    const principal = admission && admission.kind !== "loopback" && admission.contextPrincipalId;
    if (!principal || native !== promotedCallerSession(principal, external)) return null;
    return safeCallerSessionId(external) ?? null;
  }
  const alias = native || external;
  return alias ? safeCallerSessionId(alias) ?? null : undefined;
}

/** Neither admitted component permits NUL, so an agent alone cannot impersonate a thread/agent pair. */
export function claudeTranscriptQualifier(thread: string | undefined, agent: string | undefined): string | undefined {
  return thread ? `${thread}\0${agent ?? ""}` : agent;
}

/** A wire digest is reproducible within the admitted principal, but is not a private pool key. */
export function scopedWireHash(principal: string, component: string): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(["opencodex-wire-session-v1", principal, component])).digest("hex");
}

export function promotedCallerSession(principal: string, conversation: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(["opencodex-caller-session-v1", principal, conversation])).digest("hex");
}

export function callerSessionId(headers: Headers): string | undefined {
  if (SESSION_HEADERS.some(name => headers.has(name))) return undefined;
  return safeCallerSessionId(headers.get("x-session-id"));
}

/** Authenticated callers share continuity only within their trusted credential principal. */
export function withCallerSessionIdentity(req: Request, admission: DataPlaneAdmission): Request {
  const conversation = callerSessionId(req.headers);
  if (!conversation) return req;
  let sessionId = conversation;
  if (admission.kind !== "loopback") {
    const principal = admission.contextPrincipalId;
    if (!principal) return req;
    sessionId = promotedCallerSession(principal, conversation);
  }
  const headers = new Headers(req.headers);
  headers.set("session_id", sessionId);
  // Preserve the unread body stream and propagate the original request's abort signal.
  return new Request(req, { headers });
}
