/**
 * Devin CLI pass-through: `devin` with `WINDSURF_API_SERVER_URL=<hub>/devin/<key>` talks to
 * Cognition/Windsurf Connect-RPC (`server.codeium.com`, or per-account EU/FedStart tenant)
 * through the hub's pooled `devin` accounts.
 */
import { createHash, randomInt } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { admissionFields, resolveDataPlaneAdmissionSecret, type DataPlaneAdmission } from "./auth-cors";
import { readBoundedRequestBytes } from "./index/bounded-request";
import { isDraining, tryAdmitTurn } from "./lifecycle";
import { messagesEndToEndHeaders } from "./messages-native-integrity";
import { disableResponsesRequestTimeout } from "./responses/fetch-helpers";
import { addFinalRequestLog, nextRequestLogId, type RequestLogContext } from "./request-log";
import { AgyUpstreamSendError, describeUpstreamTransportError, sendExactly, type ExactResponse } from "./agy-passthrough-send";
import { getAccountCredential, listAccounts } from "../oauth/store";
import { forceRefreshOAuthAccessSnapshot, getValidAccessSnapshotForAccount } from "../oauth";
import { eligibleFailoverAccounts, genericFailoverRetryAfterSeconds, rotateGenericOAuthAccountOn429 } from "../oauth/generic-account-failover";
import { DEVIN_DEFAULT_API_SERVER, validateDevinApiBaseUrl } from "../oauth/devin/api-base";
import { normalizeDevinSessionToken } from "../adapters/devin/cloud-direct/metadata";
import { encodeMessage, encodeString } from "../adapters/devin/cloud-direct/wire";
import { oauthAccountLogLabel } from "../codex/account-label";
import { classifyUsageClient } from "../usage/client";
import type { OcxConfig, OcxProviderConfig } from "../types";

const DEVIN_PROVIDER = "devin";
const MAX_DEVIN_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_CONNECT_FRAMES = 64;
const MAX_OBSERVED_TRAILER_BYTES = 64 * 1024;
const MAX_VARINT_BYTES = 10;
const CALLER_AFFINITY_LIMIT = 1024;
const CALLER_AFFINITY_TTL_MS = 6 * 60 * 60_000;
const DEVIN_RPC_PATH = /^\/exa\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const CONNECT_CODE: Record<number, string> = {
  400: "invalid_argument", 401: "unauthenticated", 403: "permission_denied", 404: "not_found",
  405: "unimplemented", 413: "resource_exhausted", 415: "invalid_argument", 429: "resource_exhausted",
  499: "canceled", 502: "unavailable", 503: "unavailable",
};

const callerAccounts = new Map<string, { accountId: string; at: number }>();
let rotationCursor = randomInt(1_000_000);

export interface DevinPassthroughContext {
  readonly config: OcxConfig;
  readonly draining: boolean;
  readonly server?: Parameters<typeof disableResponsesRequestTimeout>[1];
}

function refuse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ code: CONNECT_CODE[status] ?? "internal", message: `opencodex: ${message}` }), {
    status, headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}

function splitDevinPath(pathname: string): { key: string; rpcPath: string } | undefined {
  const rest = pathname.slice("/devin/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  try {
    return { key: decodeURIComponent(rest.slice(0, slash)), rpcPath: rest.slice(slash) };
  } catch {
    return undefined;
  }
}

function callerKey(admission: DataPlaneAdmission, authorization: string): string {
  const principal = admission.kind === "configured" ? `configured:${admission.keyId}` : admission.kind;
  return createHash("sha256").update(principal).update("\0").update(authorization).digest("hex");
}

function rememberCaller(key: string, accountId: string, now: number): void {
  callerAccounts.delete(key);
  callerAccounts.set(key, { accountId, at: now });
  while (callerAccounts.size > CALLER_AFFINITY_LIMIT) {
    const oldest = callerAccounts.keys().next().value;
    if (oldest === undefined) break;
    callerAccounts.delete(oldest);
  }
}

type DevinAccountChoice =
  | { kind: "account"; accountId: string; apiKey: string; apiBaseUrl?: string }
  | { kind: "pool-empty" }
  | { kind: "pool-unavailable" }
  | { kind: "pool-exhausted"; retryAfterSeconds: number };

function chooseDevinAccount(key: string, now = Date.now()): DevinAccountChoice {
  if (listAccounts(DEVIN_PROVIDER).length === 0) return { kind: "pool-empty" };
  const eligible = eligibleFailoverAccounts(DEVIN_PROVIDER, now).filter(id => Boolean(getAccountCredential(DEVIN_PROVIDER, id)?.access));
  if (eligible.length === 0) {
    const retryAfter = genericFailoverRetryAfterSeconds(DEVIN_PROVIDER, now);
    return retryAfter !== null ? { kind: "pool-exhausted", retryAfterSeconds: retryAfter } : { kind: "pool-unavailable" };
  }
  const previous = callerAccounts.get(key);
  const accountId = previous && now - previous.at <= CALLER_AFFINITY_TTL_MS && eligible.includes(previous.accountId)
    ? previous.accountId
    : eligible[rotationCursor++ % eligible.length]!;
  const cred = getAccountCredential(DEVIN_PROVIDER, accountId)!;
  rememberCaller(key, accountId, now);
  return { kind: "account", accountId, apiKey: normalizeDevinSessionToken(cred.access), apiBaseUrl: cred.apiBaseUrl };
}

/** Test seam: forget process-local caller affinity and rotation cursor. */
export function resetDevinAccountState(): void {
  callerAccounts.clear();
  rotationCursor = 0;
}

/** Bounded protobuf varint decoder (at most 10 bytes, preventing unbounded BigInt DoS). */
function decodeBoundedVarint(buf: Buffer, offset: number): [bigint, number] | null {
  let res = 0n, shift = 0n, i = offset, count = 0;
  while (i < buf.length && count < MAX_VARINT_BYTES) {
    const b = buf[i++]!;
    res |= BigInt(b & 0x7f) << shift;
    count++;
    if (!(b & 0x80)) return [res, i];
    shift += 7n;
  }
  return null;
}

interface RawField { readonly num: number; readonly wire: number; readonly raw: Buffer; readonly payload?: Buffer; }

function scanRawFields(buf: Buffer): RawField[] | null {
  const fields: RawField[] = [];
  let i = 0;
  while (i < buf.length) {
    const start = i;
    const tagDecoded = decodeBoundedVarint(buf, i);
    if (!tagDecoded) return null;
    const [tagBig, afterTag] = tagDecoded;
    if (tagBig <= 0n || tagBig > 0xffffffffn) return null;
    i = afterTag;
    const num = Number(tagBig >> 3n);
    const wire = Number(tagBig & 7n);
    if (num <= 0) return null;
    if (wire === 0) {
      const valDecoded = decodeBoundedVarint(buf, i);
      if (!valDecoded) return null;
      i = valDecoded[1];
      fields.push({ num, wire, raw: buf.subarray(start, i) });
    } else if (wire === 1) {
      if (i + 8 > buf.length) return null;
      i += 8;
      fields.push({ num, wire, raw: buf.subarray(start, i) });
    } else if (wire === 2) {
      const lenDecoded = decodeBoundedVarint(buf, i);
      if (!lenDecoded) return null;
      const [lenBig, valStart] = lenDecoded;
      const len = Number(lenBig);
      if (!Number.isSafeInteger(len) || len < 0 || valStart + len > buf.length) return null;
      i = valStart + len;
      fields.push({ num, wire, raw: buf.subarray(start, i), payload: buf.subarray(valStart, i) });
    } else if (wire === 5) {
      if (i + 4 > buf.length) return null;
      i += 4;
      fields.push({ num, wire, raw: buf.subarray(start, i) });
    } else {
      return null;
    }
  }
  return fields;
}

/**
 * Swap `Metadata.api_key` (field 3) and strip `Metadata.user_jwt` (field 21) across every top-level
 * field 1 (`Metadata`) chunk, preserving all other protobuf fields byte-for-byte. Returns `null`
 * if the protobuf wire format is malformed so authenticated RPCs fail closed.
 */
export function rewriteDevinProtoCredentials(proto: Buffer, apiKey: string): Buffer | null {
  if (proto.length === 0) return proto;
  const topFields = scanRawFields(proto);
  if (!topFields) return null;
  let changed = false;
  const out: Buffer[] = [];
  for (const field of topFields) {
    if (field.num === 1 && field.wire === 2 && field.payload) {
      const metaFields = scanRawFields(field.payload);
      if (!metaFields) return null;
      const metaOut: Buffer[] = [];
      for (const mf of metaFields) {
        if (mf.num === 3 && mf.wire === 2) { metaOut.push(encodeString(3, apiKey)); changed = true; }
        else if (mf.num === 21 && mf.wire === 2) { changed = true; }
        else { metaOut.push(mf.raw); }
      }
      out.push(encodeMessage(1, Buffer.concat(metaOut)));
      continue;
    }
    out.push(field.raw);
  }
  return changed ? Buffer.concat(out) : proto;
}

function rewriteRequestBody(
  bytes: Uint8Array, contentType: string | null, contentEncoding: string | null,
  connectContentEncoding: string | null, apiKey: string,
): Buffer | null {
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (ct === "application/connect+proto") {
    const enc = connectContentEncoding?.trim().toLowerCase();
    if (enc && enc !== "identity" && enc !== "gzip") return null;
    const out: Buffer[] = [];
    let i = 0, frameCount = 0, totalDecompressed = 0;
    try {
      while (i + 5 <= buf.length) {
        if (++frameCount > MAX_CONNECT_FRAMES) return null;
        const flags = buf[i]!;
        const len = buf.readUInt32BE(i + 1);
        if (i + 5 + len > buf.length) return null;
        const rawPayload = buf.subarray(i + 5, i + 5 + len);
        i += 5 + len;
        if (flags & 0x02) {
          const hdr = Buffer.alloc(5); hdr[0] = flags; hdr.writeUInt32BE(rawPayload.length, 1);
          out.push(hdr, rawPayload);
          continue;
        }
        const remaining = MAX_DEVIN_REQUEST_BYTES - totalDecompressed;
        if (remaining <= 0) return null;
        const plain = flags & 0x01 ? gunzipSync(rawPayload, { maxOutputLength: remaining }) : rawPayload;
        totalDecompressed += plain.length;
        if (totalDecompressed > MAX_DEVIN_REQUEST_BYTES) return null;
        const rewritten = rewriteDevinProtoCredentials(plain, apiKey);
        if (rewritten === null) return null;
        const wirePayload = flags & 0x01 ? gzipSync(rewritten) : rewritten;
        const hdr = Buffer.alloc(5); hdr[0] = flags; hdr.writeUInt32BE(wirePayload.length, 1);
        out.push(hdr, wirePayload);
      }
      return i === buf.length ? Buffer.concat(out) : null;
    } catch { return null; }
  }

  if (ct === "application/proto") {
    const coding = contentEncoding?.trim().toLowerCase();
    try {
      if (!coding || coding === "identity") return rewriteDevinProtoCredentials(buf, apiKey);
      if (coding === "gzip" || coding === "x-gzip") {
        const plain = gunzipSync(buf, { maxOutputLength: MAX_DEVIN_REQUEST_BYTES });
        const rewritten = rewriteDevinProtoCredentials(plain, apiKey);
        return rewritten === null ? null : gzipSync(rewritten);
      }
      return null;
    } catch { return null; }
  }
  return null;
}

/**
 * Resolve upstream base URL preserving tenant path prefixes (EU/FedStart `/_route/api_server`).
 * Loopback overrides require explicit `providers.devin.allowPrivateNetwork: true`; every other
 * host must pass the Cognition allowlist in `validateDevinApiBaseUrl`.
 */
export function resolveDevinPassthroughBaseUrl(config: OcxConfig, accountBaseUrl?: string): string {
  const row = config.providers[DEVIN_PROVIDER];
  if (row?.allowPrivateNetwork && row.baseUrl) {
    try {
      const url = new URL(row.baseUrl);
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
      if (!url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
        return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
      }
    } catch { /* fall through to Cognition allowlist */ }
  }
  return validateDevinApiBaseUrl(accountBaseUrl) ?? validateDevinApiBaseUrl(row?.baseUrl) ?? DEVIN_DEFAULT_API_SERVER;
}

function cooldownDevinAccount(config: OcxConfig, accountId: string, retryAfter: string | null): void {
  try {
    const poolRow: OcxProviderConfig = { adapter: "devin", authMode: "oauth", baseUrl: DEVIN_DEFAULT_API_SERVER };
    const poolView: OcxConfig = { ...config, providers: { ...config.providers, [DEVIN_PROVIDER]: poolRow } };
    rotateGenericOAuthAccountOn429(poolView, DEVIN_PROVIDER, accountId, retryAfter, Date.now(), null, false);
  } catch { /* disk failure must never break relay or leak lease */ }
}

/** Observe Connect-RPC EOS (`flags & 0x02`) trailers on a `tee()` branch to detect HTTP 200 quota exhaustion. */
async function observeConnectStreamTrailers(copy: ReadableStream<Uint8Array>, config: OcxConfig, accountId: string): Promise<void> {
  const reader = copy.getReader();
  let pending: Buffer = Buffer.alloc(0);
  let skipBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (skipBytes > 0) {
        if (chunk.length <= skipBytes) { skipBytes -= chunk.length; continue; }
        chunk = chunk.subarray(skipBytes); skipBytes = 0;
      }
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 5) {
        const flags = pending[0]!, len = pending.readUInt32BE(1);
        if ((flags & 0x02) === 0) {
          const total = 5 + len;
          if (pending.length >= total) { pending = pending.subarray(total); continue; }
          skipBytes = total - pending.length; pending = Buffer.alloc(0); break;
        }
        if (len > MAX_OBSERVED_TRAILER_BYTES) return;
        if (pending.length < 5 + len) break;
        const rawTrailer = pending.subarray(5, 5 + len);
        pending = pending.subarray(5 + len);
        const plain = flags & 0x01 ? gunzipSync(rawTrailer, { maxOutputLength: MAX_OBSERVED_TRAILER_BYTES }) : rawTrailer;
        const parsed = JSON.parse(plain.toString("utf8")) as { error?: { code?: string } };
        if (parsed.error?.code === "resource_exhausted") cooldownDevinAccount(config, accountId, null);
      }
    }
  } catch { /* best-effort observer */ } finally {
    await reader.cancel().catch(() => {});
  }
}

function settledBody(
  source: ReadableStream<Uint8Array>, settle: (status: number | "complete") => void,
  abort: () => void, cancelled: () => boolean, onError?: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { settle("complete"); controller.close(); return; }
        controller.enqueue(value);
      } catch (error) { onError?.(error); settle(cancelled() ? 499 : 502); controller.error(error); }
    },
    async cancel(reason) { settle(499); abort(); await reader.cancel(reason).catch(() => {}); },
  });
}

export async function handleDevinPassthrough(req: Request, ctx: DevinPassthroughContext): Promise<Response> {
  const { config } = ctx;
  const url = new URL(req.url);
  const parts = splitDevinPath(url.pathname);
  if (!parts || !DEVIN_RPC_PATH.test(parts.rpcPath)) return refuse(404, "unknown Devin pass-through RPC path");
  if (ctx.draining) return refuse(503, "hub is restarting");

  const admission = resolveDataPlaneAdmissionSecret(parts.key, config, "dedicated");
  if (!admission) return refuse(401, "opencodex API key required in WINDSURF_API_SERVER_URL (/devin/<key>)");
  const keyEntry = admission.kind === "configured" ? config.apiKeys?.find(e => e.id === admission.keyId) : undefined;
  if (keyEntry?.allowedProviders?.length && !keyEntry.allowedProviders.includes(DEVIN_PROVIDER)) {
    return refuse(403, "this opencodex key may not use the Devin pool");
  }
  if (req.headers.has("origin") || [...req.headers.keys()].some(name => name.startsWith("sec-fetch-"))) {
    return refuse(403, "the Devin pass-through serves only the Devin CLI");
  }
  if (req.method !== "POST") return refuse(405, "Devin Connect-RPC calls are POST");

  disableResponsesRequestTimeout(req, ctx.server);
  const bytes = await readBoundedRequestBytes(req, MAX_DEVIN_REQUEST_BYTES);
  if (bytes === null) return refuse(413, "request body exceeds the pass-through limit");

  const incomingAuth = req.headers.get("authorization") ?? "";
  const authenticated = incomingAuth.length > 0;
  const cKey = callerKey(admission, incomingAuth);
  const choice = chooseDevinAccount(cKey);
  if (choice.kind === "pool-empty") return refuse(503, "no Devin account is signed in to this hub");
  if (choice.kind === "pool-unavailable") return refuse(503, "every pooled Devin account is paused or needs sign-in");
  if (choice.kind === "pool-exhausted") {
    return refuse(429, "every pooled Devin account is cooling down", { "retry-after": String(choice.retryAfterSeconds) });
  }

  let outgoingBody: Uint8Array = bytes;
  if (authenticated) {
    const rewritten = rewriteRequestBody(
      bytes, req.headers.get("content-type"), req.headers.get("content-encoding"),
      req.headers.get("connect-content-encoding"), choice.apiKey,
    );
    if (rewritten === null) return refuse(415, "unsupported or malformed Devin Connect-RPC request body");
    outgoingBody = rewritten;
  }

  const lease = tryAdmitTurn(undefined, req.signal);
  if (!lease) return refuse(503, "hub is at its active-turn limit or restarting");

  const headers = messagesEndToEndHeaders(req.headers, true);
  for (const name of [...headers.keys()]) {
    if (name === "authorization" || name === "cookie" || name === "x-api-key" || name === "referer" || name.startsWith("x-opencodex-")) {
      headers.delete(name);
    }
  }
  if (authenticated) headers.set("authorization", `Basic ${choice.apiKey}-${choice.apiKey}`);

  const start = Date.now(), requestId = nextRequestLogId(start);
  const logCtx: RequestLogContext = {
    model: parts.rpcPath.slice(parts.rpcPath.lastIndexOf("/") + 1),
    provider: DEVIN_PROVIDER,
    client: classifyUsageClient(req.headers),
    accountLogLabel: oauthAccountLogLabel(choice.accountId, DEVIN_PROVIDER),
    ...admissionFields(admission),
  };

  const controller = new AbortController();
  const onClientAbort = () => controller.abort(req.signal.reason);
  req.signal.addEventListener("abort", onClientAbort, { once: true });
  lease.bindAbortController(controller);
  let settled = false, upstreamStatus = 0;
  const settle = (status: number | "complete") => {
    if (settled) return;
    settled = true;
    req.signal.removeEventListener("abort", onClientAbort);
    lease.unbindAbortController(controller);
    lease.release();
    addFinalRequestLog(requestId, start, logCtx, status === "complete" ? upstreamStatus : status);
  };

  const logUpstreamFailure = (defaultPhase: "unknown" | "body", error: unknown, reusedSocket?: boolean) => {
    const cancelled = req.signal.aborted || controller.signal.aborted;
    const upstreamErr = error instanceof AgyUpstreamSendError ? error : undefined;
    const detail = describeUpstreamTransportError(error);
    console.warn("[devin-passthrough] upstream failure", {
      rpcPath: parts.rpcPath,
      account: logCtx.accountLogLabel,
      phase: upstreamErr?.phase ?? (cancelled ? "aborted" : defaultPhase),
      code: upstreamErr?.code ?? detail.code,
      syscall: upstreamErr?.syscall ?? detail.syscall,
      message: detail.message,
      elapsedMs: upstreamErr?.elapsedMs ?? Math.max(0, Date.now() - start),
      reusedSocket: upstreamErr?.reusedSocket ?? reusedSocket ?? null,
      cancelled,
      draining: isDraining(),
    });
  };

  let upstream: ExactResponse;
  try {
    const targetUrl = new URL(resolveDevinPassthroughBaseUrl(config, choice.apiBaseUrl) + parts.rpcPath + url.search);
    upstream = await sendExactly(targetUrl, headers, outgoingBody, controller.signal);
  } catch (error) {
    const cancelled = req.signal.aborted || controller.signal.aborted;
    logUpstreamFailure("unknown", error);
    settle(cancelled ? 499 : 502);
    if (isDraining()) return refuse(503, "hub is restarting");
    return cancelled ? refuse(499, "request cancelled") : refuse(503, "could not reach Devin upstream");
  }

  try {
    upstreamStatus = upstream.status;
    if (upstream.status === 429) {
      cooldownDevinAccount(config, choice.accountId, upstream.headers.get("retry-after"));
    } else if (upstream.status === 401) {
      callerAccounts.delete(cKey);
      void getValidAccessSnapshotForAccount(DEVIN_PROVIDER, choice.accountId, { requireUsableAccount: true })
        .then(snap => forceRefreshOAuthAccessSnapshot(snap)).catch(() => {});
    }
    const respHeaders = messagesEndToEndHeaders(upstream.headers);
    if (NULL_BODY_STATUSES.has(upstream.status)) {
      settle("complete");
      void upstream.body.cancel().catch(() => {});
      return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
    }
    let clientBody = upstream.body;
    const respCt = (upstream.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (upstream.status === 200 && respCt === "application/connect+proto") {
      const [forClient, forObserver] = upstream.body.tee();
      clientBody = forClient;
      void observeConnectStreamTrailers(forObserver, config, choice.accountId);
    }
    return new Response(
      settledBody(clientBody, settle, () => controller.abort(), () => req.signal.aborted,
        error => logUpstreamFailure("body", error, upstream.reusedSocket)),
      { status: upstream.status, statusText: upstream.statusText, headers: respHeaders },
    );
  } catch {
    settle(502);
    void upstream.body.cancel().catch(() => {});
    return refuse(502, "failed to relay Devin response");
  }
}
