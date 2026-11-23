import { decodeJwtPayload } from "../oauth/chatgpt-shared";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

/**
 * Proxy-owned handles for the Codex turn-state token.
 *
 * Codex reads `x-codex-turn-state` from a response (or the WebSocket upgrade) and sends it back on
 * later requests of the same turn, so the upstream can keep the turn on one backend. The client
 * receives a random handle this proxy generates instead of the upstream bytes. Each handle is bound
 * at issuance to the admitted caller, the selected provider and the outbound account, and maps back
 * to the upstream token here, in process memory, only at the physical send of a request with the
 * same binding. A mismatched, unknown or expired handle is not forwarded. The map is bounded (oldest
 * entries are evicted) and entries expire. Handles, tokens and bindings are never logged.
 */

export const TURN_STATE_HEADER = "x-codex-turn-state";
/** Where the provider fetch attaches a send's binding on the RequestInit it hands the WebSocket upstream. */
export const TURN_STATE_BINDING_INIT: unique symbol = Symbol("opencodex.turn-state-binding");
export const TURN_STATE_OWNER: unique symbol = Symbol("opencodex.required-turn-state-owner");
export type TurnStateOwner = NonNullable<ReturnType<typeof requiredTurnStateOwner>>;
export interface TurnStateConstrained { [TURN_STATE_OWNER]?: TurnStateOwner }
export class CodexTurnStateOwnerUnavailableError extends Error {
  constructor() { super("The credential for this send does not own a usable turn state; nothing was sent to it."); }
}
const HANDLE_PREFIX = "ocx-ts-";
const HANDLE = /^ocx-ts-[0-9a-f]{32}$/;
const MAX_HANDLES = 4096;
const HANDLE_TTL_MS = 6 * 60 * 60 * 1000;

type Entry = { value: string; binding: string; expiresAt: number };
const byHandle = new Map<string, Entry>();
const byBoundValue = new Map<string, string>();

// The admitted caller of the request being served. Admission records it; the provider fetch reads it.
type CallerScope = { caller?: string; owner?: ComboTurnStateOwner };
const callerScope = new AsyncLocalStorage<CallerScope>();

/** Run one request (or one WebSocket frame) with its own caller slot. */
export function runTurnStateCallerScope<T>(run: () => T): T {
  return callerScope.run({}, run);
}

/** The matched secret identifies the caller. A configured key id is shared across a pending rotation. */
export function noteTurnStateCaller(admission: { kind: string; keyId?: string; contextPrincipalId?: string }): void {
  const scope = callerScope.getStore();
  if (!scope) return;
  scope.caller = admission.kind === "loopback" ? "loopback" : `${admission.kind}:${admission.contextPrincipalId || randomUUID()}`;
}

/**
 * The binding of an outbound send: a digest of the admitted caller, the provider name and the account
 * the send goes out as. A workspace alone is not an owner: its members can use different seats.
 */
export function turnStateBinding(providerName: string, headers: Headers): string {
  return headerBinding(callerScope.getStore()?.caller ?? "unadmitted", providerName, headers);
}

function headerBinding(caller: string, providerName: string, headers: Headers): string {
  return accountBinding(caller, providerName, headers.get("chatgpt-account-id")?.trim() ?? "", headers.get("authorization") ?? "");
}

/** Only a consistent workspace/member pair on the same bearer can survive credential refresh.
 * A missing, malformed or conflicting claim restricts continuity to that exact credential. */
function verifiedMember(account: string, authorization: string): string | undefined {
  if (!account || authorization.length > 32_768 || !/^Bearer [^\s]+$/i.test(authorization)) return undefined;
  const payload = decodeJwtPayload(authorization.slice(7));
  const claims = payload?.["https://api.openai.com/auth"];
  if (!record(claims) || !payload) return undefined;
  const workspace = claims.chatgpt_account_id ?? payload.chatgpt_account_id;
  const member = claims.chatgpt_user_id ?? claims.user_id;
  if (workspace !== account || typeof member !== "string" || !member.trim()
    || (Object.hasOwn(payload, "chatgpt_account_id") && payload.chatgpt_account_id !== workspace)
    || (Object.hasOwn(claims, "chatgpt_account_id") && claims.chatgpt_account_id !== workspace)
    || (Object.hasOwn(claims, "chatgpt_user_id") && claims.chatgpt_user_id !== member)
    || (Object.hasOwn(claims, "user_id") && claims.user_id !== member)) return undefined;
  return member;
}

function accountBinding(caller: string, providerName: string, account: string, authorization: string): string {
  const member = verifiedMember(account, authorization);
  return (authorization ? routePrefix(caller, providerName) : "") + createHash("sha256")
    .update(JSON.stringify([caller, providerName, account, member, member ? null : authorization])).digest("hex");
}

function routePrefix(caller: string, provider: string): string {
  return createHash("sha256").update(JSON.stringify([caller, provider])).digest("hex") + ".";
}

function presentedHandles(headers: Headers, body: unknown): string[] {
  const metadata = record(body) && record(body.client_metadata) ? body.client_metadata : undefined;
  return [headers.get(TURN_STATE_HEADER), metadata?.[TURN_STATE_HEADER]]
    .filter((token): token is string => typeof token === "string" && token.startsWith(HANDLE_PREFIX));
}

export interface ComboTurnStateOwner {
  hasLiveHandle(): boolean;
  permitsProvider(providerName: string): boolean;
  forProvider(providerName: string): TurnStateOwner;
}

/** The caller/provider prefix selects a route, never a credential. Recheck the entire binding
 * and the lifetime of every presented handle at the physical executor. */
export function comboTurnStateOwner(headers: Headers, body: unknown): ComboTurnStateOwner | undefined {
  const handles = presentedHandles(headers, body);
  if (!handles.length) return;
  const caller = callerScope.getStore()?.caller ?? "unadmitted";
  const binding = live(handles[0]!, Date.now())?.binding;
  return {
    hasLiveHandle: () => handles.some(handle => live(handle, Date.now()) !== undefined),
    permitsProvider: provider => binding !== undefined && binding.startsWith(routePrefix(caller, provider))
      && handles.every(handle => live(handle, Date.now())?.binding === binding),
    forProvider: provider => ownerForHandles(provider, handles, caller),
  };
}
export function requiredComboSendOwner(provider: string): TurnStateOwner | undefined {
  return callerScope.getStore()?.owner?.forProvider(provider);
}
export function withComboTurnStateOwner<T>(owner: ComboTurnStateOwner | undefined, run: () => T): T {
  return owner ? callerScope.run({ ...callerScope.getStore(), owner }, run) : run();
}

/** A native Pool turn must satisfy every handle it carries, even without conversation affinity. */
export function requiredTurnStateOwner(providerName: string, headers: Headers, body: unknown) {
  const handles = presentedHandles(headers, body);
  if (!handles.length) return undefined;
  return ownerForHandles(providerName, handles, callerScope.getStore()?.caller ?? "unadmitted");
}

function ownerForHandles(providerName: string, handles: string[], caller: string) {
  const matches = (binding: string) => handles.every(handle => live(handle, Date.now())?.binding === binding);
  return {
    matchesCredential: (credential: { chatgptAccountId: string; accessToken: string }) =>
      matches(accountBinding(caller, providerName, credential.chatgptAccountId, `Bearer ${credential.accessToken}`)),
    assertHeaders(selected: Headers): void {
      if (!matches(headerBinding(caller, providerName, selected))) throw new CodexTurnStateOwnerUnavailableError();
    },
    handles: new Set(handles),
  };
}

function randomHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return HANDLE_PREFIX + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function boundKey(entry: { binding: string; value: string }): string {
  return entry.binding + "\0" + entry.value;
}

function live(handle: string, now: number): Entry | undefined {
  const entry = byHandle.get(handle);
  if (!entry) return undefined;
  if (entry.expiresAt > now) return entry;
  byHandle.delete(handle);
  if (byBoundValue.get(boundKey(entry)) === handle) byBoundValue.delete(boundKey(entry));
  return undefined;
}

/** True for a handle this proxy issued that has not expired. */
export function isLiveTurnStateHandle(value: string, now = Date.now()): boolean {
  return HANDLE.test(value) && live(value, now) !== undefined;
}

/** The handle a client receives for an upstream turn-state token under `binding`; a live handle is returned as is. */
export function issueTurnStateHandle(value: string, binding: string, now = Date.now()): string {
  if (isLiveTurnStateHandle(value, now)) return value;
  const key = boundKey({ binding, value });
  const existing = byBoundValue.get(key);
  if (existing && live(existing, now)) return existing;
  const handle = randomHandle();
  byHandle.set(handle, { value, binding, expiresAt: now + HANDLE_TTL_MS });
  byBoundValue.set(key, handle);
  while (byHandle.size > MAX_HANDLES) {
    const [oldest, entry] = byHandle.entries().next().value as [string, Entry];
    byHandle.delete(oldest);
    if (byBoundValue.get(boundKey(entry)) === oldest) byBoundValue.delete(boundKey(entry));
  }
  return handle;
}

export type TurnStateResolution = { value: string } | { dropped: "unknown" | "mismatch" };

/**
 * What to forward for an inbound turn-state under `binding`: the upstream token for a live handle
 * with the same binding, nothing for an unknown, expired or differently bound handle, and any other
 * value unchanged (it did not come from a handle).
 */
export function resolveTurnStateHandle(value: string, binding: string, now = Date.now()): TurnStateResolution {
  if (!value.startsWith(HANDLE_PREFIX)) return { value };
  const entry = live(value, now);
  if (!entry) return { dropped: "unknown" };
  return entry.binding === binding ? { value: entry.value } : { dropped: "mismatch" };
}

/** Fixed service-log flag for a handle presented under a different binding; it never names the handle. */
export const TURN_STATE_MISMATCH_NOTICE = "[opencodex] turn_state_binding_mismatch: a turn-state handle was not forwarded";
const MISMATCH_NOTICE_INTERVAL_MS = 60_000;
let lastMismatchNotice = 0;

function redeem(value: string, binding: string): string | undefined {
  const resolution = resolveTurnStateHandle(value, binding);
  if ("value" in resolution) return resolution.value;
  if (resolution.dropped === "mismatch" && Date.now() - lastMismatchNotice >= MISMATCH_NOTICE_INTERVAL_MS) {
    lastMismatchNotice = Date.now();
    console.warn(TURN_STATE_MISMATCH_NOTICE);
  }
  return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Translate turn-state handles in an outbound send, after admission and routing: the request header
 * and `client_metadata["x-codex-turn-state"]` in a JSON body. The init is returned unchanged when it
 * carries no handle, so ordinary sends keep their exact headers and body bytes.
 */
export function redeemOutboundTurnState(init: RequestInit | undefined, binding: string | (() => string)): RequestInit | undefined {
  if (!init) return init;
  let resolved: string | undefined;
  const sendBinding = () => resolved ??= typeof binding === "string" ? binding : binding();
  let next: RequestInit = init;
  const headers = new Headers(init.headers);
  const header = headers.get(TURN_STATE_HEADER);
  if (header !== null && header.startsWith(HANDLE_PREFIX)) {
    const value = redeem(header, sendBinding());
    if (value === undefined) headers.delete(TURN_STATE_HEADER); else headers.set(TURN_STATE_HEADER, value);
    next = { ...next, headers };
  }
  if (typeof init.body === "string" && init.body.includes(HANDLE_PREFIX)) {
    let body: unknown;
    try { body = JSON.parse(init.body); } catch { return next; }
    const metadata = record(body) ? body.client_metadata : undefined;
    const handle = record(metadata) ? metadata[TURN_STATE_HEADER] : undefined;
    if (record(body) && record(metadata) && typeof handle === "string" && handle.startsWith(HANDLE_PREFIX)) {
      const value = redeem(handle, sendBinding());
      const nextMetadata = { ...metadata };
      if (value === undefined) delete nextMetadata[TURN_STATE_HEADER]; else nextMetadata[TURN_STATE_HEADER] = value;
      next = { ...next, body: JSON.stringify({ ...body, client_metadata: nextMetadata }) };
    }
  }
  return next;
}

export function resetTurnStateHandlesForTests(): void {
  byHandle.clear();
  byBoundValue.clear();
  lastMismatchNotice = 0;
}
