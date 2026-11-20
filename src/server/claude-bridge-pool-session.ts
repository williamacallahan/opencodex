/** Selection identities are private to the admitted caller. The original wire headers never change. */
import { createHmac, randomBytes } from "node:crypto";
import { contextPrincipalIdOf, type DataPlaneAdmission } from "./auth-cors";
import { callerSessionAlias, safeCallerSessionId } from "./caller-session-identity";
import { isThreadSpawnRequest } from "./effort-policy";
import type { RouteResult } from "../router";
import type { HandleResponsesOptions } from "./responses/core-options";

/** This key separates internal selection identifiers from reproducible wire identifiers. */
const BRIDGE_POOL_KEY = randomBytes(32);

/** The admission scope a Claude session identity is bound to; undefined when a non-loopback caller has no principal. */
function claudeAdmissionScope(admission: DataPlaneAdmission): string | string[] | undefined {
  if (admission.kind === "loopback") return "loopback";
  const principal = contextPrincipalIdOf(admission);
  return principal ? ["principal", principal] : undefined;
}

export function scopedConversationKey(admission: DataPlaneAdmission | undefined, component: string): string | undefined {
  if (!admission) return undefined;
  const scope = claudeAdmissionScope(admission);
  return scope === undefined ? undefined : createHmac("sha256", BRIDGE_POOL_KEY)
    .update(JSON.stringify(["opencodex-claude-bridge-pool-v1", scope, component])).digest("hex");
}

/** Private transcript key for combo recall and account selection, never a wire or cache key. */
export function resolveClaudeBridgePoolSession(args: {
  ingress: Headers; replay: Headers; metadataSessionId?: string; admission?: DataPlaneAdmission;
}): string | undefined {
  const { ingress, replay, metadataSessionId, admission } = args;
  if (!admission) return undefined;
  const session = callerSessionAlias(ingress, admission);
  if (session === null) return undefined;
  const thread = safeCallerSessionId(ingress.get("thread-id"));
  const parent = safeCallerSessionId(ingress.get("x-codex-parent-thread-id"));
  if ((!thread && ingress.has("thread-id")) || (!parent && ingress.has("x-codex-parent-thread-id"))) return undefined;
  if (!thread && !parent && (isThreadSpawnRequest(ingress) || (ingress !== replay && isThreadSpawnRequest(replay)))) return undefined;
  if (!session && (ingress.has("session_id") || ingress.has("session-id") || ingress.has("x-session-id"))) return undefined;
  const anchor = thread ?? session ?? parent ?? safeCallerSessionId(metadataSessionId ?? ingress.get("x-claude-code-session-id"));
  if (!anchor) return undefined;
  return scopedConversationKey(admission, anchor);
}

const identityHeaders = ["session_id", "session-id", "x-session-id", "thread-id", "x-codex-parent-thread-id"] as const;

type SelectionOptions = Pick<HandleResponsesOptions, "claudeBridgePoolSession" | "admission" | "inboundWire">;

export function completeClaudeBridgePoolIdentity(headers: Headers, options: SelectionOptions): Headers {
  const { admission } = options;
  const transcript = "claudeBridgePoolSession" in options ? options.claudeBridgePoolSession
    : resolveClaudeBridgePoolSession({ ingress: headers, replay: headers, admission });
  if (!transcript && !admission) return headers;
  const hasIdentity = identityHeaders.some(name => headers.has(name));
  if (!transcript && !hasIdentity) return headers;
  const completed = new Headers(headers);
  for (const name of identityHeaders) completed.delete(name);
  if (!transcript) return completed;
  const parent = safeCallerSessionId(headers.get("x-codex-parent-thread-id"));
  const thread = safeCallerSessionId(headers.get("thread-id"));
  if (admission && (parent || thread) && options.inboundWire !== "anthropic") {
    const session = callerSessionAlias(headers, admission);
    if (session) completed.set("session-id", scopedConversationKey(admission, session)!);
    if (parent) completed.set("x-codex-parent-thread-id", scopedConversationKey(admission, parent)!);
    if (thread) completed.set("thread-id", transcript);
    if (!session && !parent) completed.set("session-id", transcript);
  } else {
    completed.set("session-id", transcript);
    completed.set("thread-id", transcript);
  }
  return completed;
}

export function applyClaudeBridgePoolSession(headers: Headers, route: Pick<RouteResult, "codexAccountMode">,
  options: SelectionOptions): Headers {
  return route.codexAccountMode !== undefined ? completeClaudeBridgePoolIdentity(headers, options) : headers;
}
