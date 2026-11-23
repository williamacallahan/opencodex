/**
 * Antigravity CLI pass-through: `agy` with `CLOUD_CODE_URL=<hub>/agy/<key>` talks to Google through the hub.
 *
 * The hub forwards each Cloud Code call exactly as agy sent it: method, `v1internal` path, query,
 * every end-to-end header (agy's own `User-Agent` included) and the request bytes. It changes one
 * thing, the bearer, to a pooled account's token; that swap is the load balancing. It strips only
 * what agy did not send to Google: the `/agy/<key>` prefix (agy cannot add a header, so the hub key
 * rides in the path), hop-by-hop framing, Host, and the headers the hub's own ingress proxies add.
 * Google's answer, errors and SSE streams included, returns with its status and bytes unchanged.
 *
 * One physical send per agy request (`agy-passthrough-send.ts`): no retry, no failover to another
 * account mid-request (the body names its account's project), no translation. The lane serves only
 * while `nativeHarnessOnly` is on, because only then does the hub itself send Google nothing faked.
 * `agy-passthrough-accounts.ts` owns the account choice.
 */
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate, zstdDecompress } from "node:zlib";
import { admissionFields, resolveDataPlaneAdmissionSecret, type DataPlaneAdmission } from "./auth-cors";
import { readBoundedRequestBytes } from "./index/bounded-request";
import { isDraining, tryAdmitTurn } from "./lifecycle";
import { messagesEndToEndHeaders } from "./messages-native-integrity";
import { disableResponsesRequestTimeout } from "./responses/fetch-helpers";
import { addFinalRequestLog, nextRequestLogId, type RequestLogContext } from "./request-log";
import { chooseAgyAccount, learnAgyAccountProject, noteAgySent, type AgyAccountChoice } from "./agy-passthrough-accounts";
import { AgyUpstreamSendError, sendExactly, type ExactResponse } from "./agy-passthrough-send";
import { forceRefreshOAuthAccessSnapshot, getValidAccessSnapshotForAccount } from "../oauth";
import { rotateGenericOAuthAccountOn429 } from "../oauth/generic-account-failover";
import { extractProjectId } from "../oauth/google-antigravity";
import { oauthAccountLogLabel } from "../codex/account-label";
import { nativeHarnessOnly } from "../lib/native-harness";
import { ANTIGRAVITY_OAUTH_STORE_KEY } from "../providers/antigravity-quota-identity";
import { PROVIDER_REGISTRY } from "../providers/registry";
import { observedAntigravityAccountQuota, recordPassiveAccountQuota } from "../providers/quota/account-cache";
import { antigravityLoginIdentity } from "../providers/antigravity-quota-identity";
import { getAccountCredential } from "../oauth/store";
import { antigravityQuotaFromRelayedAnswer } from "../providers/quota/antigravity";
import { captureConfigGeneration } from "../lib/state-store-sweeper";
import { classifyUsageClient } from "../usage/client";
import type { OcxConfig, OcxProviderConfig } from "../types";

const MAX_AGY_REQUEST_BYTES = 32 * 1024 * 1024;
/** Bound on a relayed answer copied for reading; a larger one is not read (agy still gets it whole). */
const MAX_OBSERVED_ANSWER_BYTES = 4 * 1024 * 1024;
/** agy's own quota calls; Google's answers to them are this pool's only quota reading. */
const QUOTA_METHODS = new Set(["retrieveUserQuotaSummary", "fetchAvailableModels"] as const);
type QuotaMethod = typeof QUOTA_METHODS extends Set<infer M> ? M : never;
const isQuotaMethod = (method: string): method is QuotaMethod => QUOTA_METHODS.has(method as QuotaMethod);

/** The sign-in a pooled slot holds now; undefined when the slot is gone or has no credential. */
function agyLogin(accountId: string): string | undefined {
  const credential = getAccountCredential(ANTIGRAVITY_OAUTH_STORE_KEY, accountId);
  return credential ? antigravityLoginIdentity(accountId, credential) : undefined;
}
const CLOUD_CODE_METHOD = /^\/v1internal:[A-Za-z]+$/;
/** Generation calls always carry their account's project; refusing a project-less one keeps them off rotation. */
const PROJECT_REQUIRED = /^\/v1internal:(?:streamGenerateContent|generateContent|countTokens)$/;
const AGY_USER_AGENT = /^antigravity\/cli\//;
const REGISTRY_ORIGIN = new URL(PROVIDER_REGISTRY.find(entry => entry.id === ANTIGRAVITY_OAUTH_STORE_KEY)!.baseUrl).origin;

export interface AgyPassthroughContext {
  readonly config: OcxConfig;
  readonly draining: boolean;
  readonly server?: Parameters<typeof disableResponsesRequestTimeout>[1];
}

const GOOGLE_STATUS: Record<number, string> = {
  400: "FAILED_PRECONDITION", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED", 413: "INVALID_ARGUMENT", 415: "INVALID_ARGUMENT", 429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED", 503: "UNAVAILABLE",
};

/** A refusal in Google's own error shape, so agy shows the message; it never reaches Google. */
function refuse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code: status, message: `opencodex: ${message}`, status: GOOGLE_STATUS[status] } }), {
    status, headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}

function choiceRefusal(choice: Exclude<AgyAccountChoice, { kind: "account" }>): Response {
  switch (choice.kind) {
    case "pool-empty":
      return refuse(503, "no Antigravity account is signed in to this hub");
    case "pool-exhausted":
      return refuse(429, "every pooled Antigravity account is cooling down",
        choice.retryAfterSeconds === null ? {} : { "retry-after": String(choice.retryAfterSeconds) });
    case "project-unowned":
      return refuse(400, "this request names a Cloud Code project no pooled account owns; restart agy so it asks the hub for its project");
    case "project-account-unavailable":
      return refuse(503, "every pooled account that owns this project is paused or needs sign-in; restart agy to move to another account");
  }
}

/** The path after `/agy/<key>`, and the key; undefined when the path is not that shape. */
function splitAgyPath(pathname: string): { key: string; method: string } | undefined {
  const rest = pathname.slice("/agy/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  try {
    return { key: decodeURIComponent(rest.slice(0, slash)), method: rest.slice(slash) };
  } catch {
    return undefined;
  }
}

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);
const zstdDecompressAsync = promisify(zstdDecompress);
const utf8Decoder = new TextDecoder();

/**
 * Extract one top-level string field from raw UTF-8 JSON bytes without constructing
 * an AST or decoding the whole request buffer into UTF-16.
 */
export function extractTopLevelJsonStringField(bytes: Uint8Array, field: string): string | undefined {
  const skipWs = (pos: number): number => {
    while (pos < bytes.length) {
      const b = bytes[pos]!;
      if (b !== 0x20 && b !== 0x09 && b !== 0x0A && b !== 0x0D) break;
      pos += 1;
    }
    return pos;
  };
  const scanStr = (start: number): { end: number; escaped: boolean } | null => {
    if (bytes[start] !== 0x22) return null;
    let escaped = false;
    let pos = start + 1;
    while (pos < bytes.length) {
      const b = bytes[pos]!;
      if (b === 0x5C) {
        escaped = true;
        pos += 2;
        continue;
      }
      if (b === 0x22) return { end: pos, escaped };
      pos += 1;
    }
    return null;
  };
  const skipVal = (start: number): number => {
    const b = bytes[start];
    if (b === undefined) return -1;
    if (b === 0x22) {
      const str = scanStr(start);
      return str ? str.end + 1 : -1;
    }
    if (b === 0x7B || b === 0x5B) {
      let depth = 1;
      let pos = start + 1;
      while (pos < bytes.length && depth > 0) {
        const ch = bytes[pos]!;
        if (ch === 0x22) {
          const str = scanStr(pos);
          if (!str) return -1;
          pos = str.end + 1;
          continue;
        }
        if (ch === 0x7B || ch === 0x5B) depth += 1;
        else if (ch === 0x7D || ch === 0x5D) depth -= 1;
        pos += 1;
      }
      return depth === 0 ? pos : -1;
    }
    let pos = start;
    while (pos < bytes.length) {
      const ch = bytes[pos]!;
      if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D || ch === 0x2C || ch === 0x7D || ch === 0x5D) break;
      pos += 1;
    }
    return pos > start ? pos : -1;
  };

  let pos = skipWs(0);
  if (bytes[pos] !== 0x7B) return undefined;
  pos += 1;
  const fieldBytes = Buffer.from(field, "utf8");
  while (pos < bytes.length) {
    pos = skipWs(pos);
    if (bytes[pos] === 0x7D) return undefined;
    const keyToken = scanStr(pos);
    if (!keyToken) return undefined;
    let matched = false;
    if (!keyToken.escaped) {
      const rawKeyLen = keyToken.end - (pos + 1);
      if (rawKeyLen === fieldBytes.length) {
        matched = true;
        for (let i = 0; i < rawKeyLen; i += 1) {
          if (bytes[pos + 1 + i] !== fieldBytes[i]) {
            matched = false;
            break;
          }
        }
      }
    } else {
      try {
        matched = JSON.parse(utf8Decoder.decode(bytes.subarray(pos, keyToken.end + 1))) === field;
      } catch {
        return undefined;
      }
    }
    pos = skipWs(keyToken.end + 1);
    if (bytes[pos] !== 0x3A) return undefined;
    pos = skipWs(pos + 1);
    if (pos >= bytes.length) return undefined;
    if (matched) {
      if (bytes[pos] !== 0x22) return undefined;
      const valToken = scanStr(pos);
      if (!valToken) return undefined;
      if (!valToken.escaped) {
        if (valToken.end === pos + 1) return undefined;
        return utf8Decoder.decode(bytes.subarray(pos + 1, valToken.end));
      }
      try {
        const value: unknown = JSON.parse(utf8Decoder.decode(bytes.subarray(pos, valToken.end + 1)));
        return typeof value === "string" && value.length > 0 ? value : undefined;
      } catch {
        return undefined;
      }
    }
    pos = skipVal(pos);
    if (pos < 0) return undefined;
    pos = skipWs(pos);
    if (bytes[pos] === 0x2C) {
      pos += 1;
      continue;
    }
    if (bytes[pos] === 0x7D) return undefined;
    return undefined;
  }
  return undefined;
}

/** Decode a copy for reading only; null when the coding is one this lane does not read. */
async function decoded(bytes: Uint8Array, contentEncoding: string | null, maxOutputLength = MAX_AGY_REQUEST_BYTES): Promise<Uint8Array | null> {
  const coding = contentEncoding?.trim().toLowerCase();
  // Bounded: a small compressed body must not inflate past the caller's limit.
  const bound = { maxOutputLength };
  try {
    if (!coding || coding === "identity") return bytes;
    if (coding === "gzip" || coding === "x-gzip") return await gunzipAsync(bytes, bound);
    if (coding === "deflate") return await inflateAsync(bytes, bound);
    if (coding === "br") return await brotliDecompressAsync(bytes, bound);
    if (coding === "zstd") return await zstdDecompressAsync(bytes, bound);
  } catch {
    return null;
  }
  return null;
}

/** Read-only routing view of the body: the `project` it names. The forwarded bytes stay the originals. */
async function projectNamedBy(bytes: Uint8Array, contentEncoding: string | null): Promise<string | undefined | null> {
  const plain = await decoded(bytes, contentEncoding);
  if (plain === null) return null;
  if (plain.byteLength === 0) return undefined;
  return extractTopLevelJsonStringField(plain, "project");
}

/**
 * agy's default Cloud Code origin from the registry. An operator's `google-antigravity` row may
 * name another HTTPS origin, or a loopback one; nothing else may receive a pooled token.
 */
function cloudCodeOrigin(config: OcxConfig): string {
  const row = config.providers[ANTIGRAVITY_OAUTH_STORE_KEY];
  if (!row?.baseUrl) return REGISTRY_ORIGIN;
  try {
    const url = new URL(row.baseUrl);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.username || url.password) return REGISTRY_ORIGIN;
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.origin : REGISTRY_ORIGIN;
  } catch {
    return REGISTRY_ORIGIN;
  }
}

/** A bounded, decoded copy of a relayed JSON answer; undefined when it is too large or not a JSON object. */
async function readRelayedJson(copy: ReadableStream<Uint8Array>, contentEncoding: string | null): Promise<Record<string, unknown> | undefined> {
  const reader = copy.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OBSERVED_ANSWER_BYTES) return undefined;
      chunks.push(value);
    }
    // The decoded copy has the same bound, so a small compressed answer cannot expand past it.
    const plain = await decoded(Buffer.concat(chunks), contentEncoding, MAX_OBSERVED_ANSWER_BYTES);
    if (!plain) return undefined;
    const parsed: unknown = JSON.parse(utf8Decoder.decode(plain));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Read a relayed answer agy asked for: the project Google handed this account (`loadCodeAssist`)
 * or the account's quota (agy's own quota calls). The client's bytes are never touched.
 */
async function observeRelayedAnswer(copy: ReadableStream<Uint8Array>, contentEncoding: string | null, accountId: string,
  method: string, writerGeneration: number, login: string | undefined): Promise<void> {
  const body = await readRelayedJson(copy, contentEncoding);
  if (!body) return;
  if (method === "loadCodeAssist") {
    const project = extractProjectId(body);
    if (project) learnAgyAccountProject(accountId, project, login);
    return;
  }
  if (!isQuotaMethod(method) || !login) return;
  const quota = antigravityQuotaFromRelayedAnswer(method, body);
  // The answer belongs to the sign-in whose token was sent; a slot now holding another login gets nothing.
  if (!quota || agyLogin(accountId) !== login) return;
  const kept = observedAntigravityAccountQuota(accountId);
  // A models answer carries per-model rows only; it never replaces a kept family reading, which is
  // what usage balancing ranks by (a summary within the routing horizon replaces it instead).
  if (method === "fetchAvailableModels" && kept?.customWindows?.some(window => window.modelId === undefined)) return;
  recordPassiveAccountQuota(ANTIGRAVITY_OAUTH_STORE_KEY, accountId, quota, writerGeneration, login);
}

/** The client's branch of the answer; it settles the request log and the turn lease exactly once. */
function settledBody(source: ReadableStream<Uint8Array>, settle: (status: number | "complete") => void, abort: () => void,
  cancelled: () => boolean): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { settle("complete"); controller.close(); return; }
        controller.enqueue(value);
      } catch (error) {
        settle(cancelled() ? 499 : 502);
        controller.error(error);
      }
    },
    async cancel(reason) {
      settle(499);
      abort();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/** One caller is one hub key plus the agy sign-in it presents; the bearer itself is never stored. */
function callerKey(admission: DataPlaneAdmission, authorization: string): string {
  const principal = admission.kind === "configured" ? `configured:${admission.keyId}` : admission.kind;
  return createHash("sha256").update(principal).update("\0").update(authorization).digest("hex");
}

export async function handleAgyPassthrough(req: Request, ctx: AgyPassthroughContext): Promise<Response> {
  const { config } = ctx;
  const url = new URL(req.url);
  const parts = splitAgyPath(url.pathname);
  if (!parts || !CLOUD_CODE_METHOD.test(parts.method)) return refuse(404, "unknown Antigravity pass-through path");
  if (ctx.draining) return refuse(503, "hub is restarting");
  const admission = resolveDataPlaneAdmissionSecret(parts.key, config, "dedicated");
  if (!admission) return refuse(401, "opencodex API key required in CLOUD_CODE_URL (/agy/<key>)");
  const keyEntry = admission.kind === "configured" ? config.apiKeys?.find(entry => entry.id === admission.keyId) : undefined;
  if (keyEntry?.allowedProviders?.length && !keyEntry.allowedProviders.includes(ANTIGRAVITY_OAUTH_STORE_KEY)) {
    return refuse(403, "this opencodex key may not use the Antigravity pool");
  }
  const authorization = req.headers.get("authorization") ?? "";
  if (!AGY_USER_AGENT.test(req.headers.get("user-agent") ?? "") || !/^Bearer \S+$/.test(authorization)
    || req.headers.has("origin") || [...req.headers.keys()].some(name => name.startsWith("sec-fetch-"))) {
    return refuse(403, "the Antigravity pool serves only the agy harness");
  }
  if (!nativeHarnessOnly()) return refuse(503, "the agy pass-through requires nativeHarnessOnly on this hub");
  if (req.method !== "POST") return refuse(405, "Cloud Code calls are POST");

  disableResponsesRequestTimeout(req, ctx.server);
  const bytes = await readBoundedRequestBytes(req, MAX_AGY_REQUEST_BYTES);
  if (bytes === null) return refuse(413, "request body exceeds the pass-through limit");
  const project = await projectNamedBy(bytes, req.headers.get("content-encoding"));
  if (project === null) return refuse(415, "unsupported request content-encoding");
  if (project === undefined && PROJECT_REQUIRED.test(parts.method)) return refuse(400, "a generation call must name its Cloud Code project");

  const choice = chooseAgyAccount({
    project, callerKey: callerKey(admission, authorization), mayRotate: parts.method === "/v1internal:loadCodeAssist",
  });
  if (choice.kind !== "account") return choiceRefusal(choice);
  // Captured with the account choice: a roster change or another sign-in in the slot fences the quota write.
  const quotaWriterGeneration = captureConfigGeneration();
  const quotaLogin = agyLogin(choice.accountId);
  let snapshot: Awaited<ReturnType<typeof getValidAccessSnapshotForAccount>>;
  try {
    snapshot = await getValidAccessSnapshotForAccount(ANTIGRAVITY_OAUTH_STORE_KEY, choice.accountId, { requireUsableAccount: true });
  } catch {
    return refuse(503, "could not refresh the chosen pooled Antigravity account; retry");
  }
  // An active turn, so a hub drain waits for this stream before the process swaps.
  const lease = tryAdmitTurn(undefined, req.signal);
  if (!lease) return refuse(503, "hub is at its active-turn limit or restarting");

  const headers = messagesEndToEndHeaders(req.headers, true);
  for (const name of [...headers.keys()]) {
    if (name === "authorization" || name === "cookie" || name.startsWith("x-opencodex-")) headers.delete(name);
  }
  headers.set("authorization", `Bearer ${snapshot.accessToken}`);

  const start = Date.now();
  const requestId = nextRequestLogId(start);
  const logCtx: RequestLogContext = {
    model: parts.method.slice("/v1internal:".length),
    provider: ANTIGRAVITY_OAUTH_STORE_KEY,
    client: classifyUsageClient(req.headers),
    accountLogLabel: oauthAccountLogLabel(choice.accountId, ANTIGRAVITY_OAUTH_STORE_KEY),
    ...admissionFields(admission),
  };
  const controller = new AbortController();
  const onClientAbort = () => controller.abort(req.signal.reason);
  req.signal.addEventListener("abort", onClientAbort, { once: true });
  lease.bindAbortController(controller);
  let settled = false;
  let upstreamStatus = 0;
  const settle = (status: number | "complete") => {
    if (settled) return;
    settled = true;
    req.signal.removeEventListener("abort", onClientAbort);
    lease.unbindAbortController(controller);
    lease.release();
    addFinalRequestLog(requestId, start, logCtx, status === "complete" ? upstreamStatus : status);
  };

  let upstream: ExactResponse;
  try {
    upstream = await sendExactly(new URL(cloudCodeOrigin(config) + parts.method + url.search), headers, bytes, controller.signal);
  } catch (error) {
    const cancelled = req.signal.aborted || controller.signal.aborted;
    const upstreamErr = error instanceof AgyUpstreamSendError ? error : undefined;
    const code = upstreamErr?.code ?? (error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined);
    console.warn("[agy-passthrough] upstream failure", {
      method: parts.method,
      account: logCtx.accountLogLabel,
      phase: upstreamErr?.phase ?? (cancelled ? "aborted" : "unknown"),
      code: code ?? null,
      elapsedMs: upstreamErr?.elapsedMs ?? Math.max(0, Date.now() - start),
      reusedSocket: upstreamErr?.reusedSocket ?? null,
      cancelled,
      draining: isDraining(),
    });
    settle(cancelled ? 499 : 502);
    if (isDraining()) return refuse(503, "hub is restarting");
    return cancelled ? refuse(499, "request cancelled") : refuse(503, "could not reach Google Cloud Code");
  }
  upstreamStatus = upstream.status;
  noteAgySent(choice.accountId, quotaLogin);
  if (upstream.status === 429) {
    // The pool needs no translatable provider row; give the cooldown owner the OAuth row it keys on.
    const poolRow: OcxProviderConfig = { adapter: "google", authMode: "oauth", baseUrl: REGISTRY_ORIGIN };
    const poolView: OcxConfig = { ...config, providers: { ...config.providers, [ANTIGRAVITY_OAUTH_STORE_KEY]: poolRow } };
    rotateGenericOAuthAccountOn429(poolView, ANTIGRAVITY_OAUTH_STORE_KEY, choice.accountId, upstream.headers.get("retry-after"), Date.now(), null, false);
  }
  // A token Google rejected before its recorded expiry: mint a fresh one for the next request.
  if (upstream.status === 401) void forceRefreshOAuthAccessSnapshot(snapshot).catch(() => {});
  let clientBody = upstream.body;
  const method = parts.method.slice("/v1internal:".length);
  if (upstream.status >= 200 && upstream.status < 300 && (method === "loadCodeAssist" || isQuotaMethod(method))) {
    const [forClient, forObserver] = upstream.body.tee();
    clientBody = forClient;
    void observeRelayedAnswer(forObserver, upstream.headers.get("content-encoding"), choice.accountId, method, quotaWriterGeneration, quotaLogin);
  }
  return new Response(settledBody(clientBody, settle, () => controller.abort(), () => req.signal.aborted), {
    status: upstream.status, statusText: upstream.statusText, headers: messagesEndToEndHeaders(upstream.headers),
  });
}
