/**
 * Devin CLI pass-through: `devin` with `WINDSURF_API_SERVER_URL=<hub>/devin/<key>` talks to
 * Cognition/Windsurf Connect-RPC (`server.codeium.com`) through the hub's pooled `devin` accounts.
 *
 * The hub forwards each Connect-RPC call preserving method, RPC path, query, end-to-end headers,
 * and every protobuf field outside `Metadata.api_key` (and `Metadata.user_jwt`). It swaps only
 * the credential in `Authorization` (when present) and `Metadata.api_key` to a pooled `devin`
 * account, balancing callers round-robin with sticky session affinity and rotating on 429s.
 */
import { createHash, randomInt } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { admissionFields, resolveDataPlaneAdmissionSecret, type DataPlaneAdmission } from "./auth-cors";
import { readBoundedRequestBytes } from "./index/bounded-request";
import { isDraining, tryAdmitTurn } from "./lifecycle";
import { messagesEndToEndHeaders } from "./messages-native-integrity";
import { disableResponsesRequestTimeout } from "./responses/fetch-helpers";
import { addFinalRequestLog, nextRequestLogId, type RequestLogContext } from "./request-log";
import { sendExactly, type ExactResponse } from "./agy-passthrough-send";
import { getAccountCredential, listAccounts } from "../oauth/store";
import {
  eligibleFailoverAccounts,
  genericFailoverRetryAfterSeconds,
  rotateGenericOAuthAccountOn429,
} from "../oauth/generic-account-failover";
import { DEVIN_DEFAULT_API_SERVER } from "../oauth/devin";
import { normalizeDevinSessionToken } from "../adapters/devin/cloud-direct/metadata";
import { decodeVarint, encodeMessage, encodeString } from "../adapters/devin/cloud-direct/wire";
import { oauthAccountLogLabel } from "../codex/account-label";
import { classifyUsageClient } from "../usage/client";
import type { OcxConfig, OcxProviderConfig } from "../types";

const DEVIN_PROVIDER = "devin";
const MAX_DEVIN_REQUEST_BYTES = 32 * 1024 * 1024;
const CALLER_AFFINITY_LIMIT = 1024;
const CALLER_AFFINITY_TTL_MS = 6 * 60 * 60_000;
const DEVIN_RPC_PATH = /^\/exa\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/;

const callerAccounts = new Map<string, { accountId: string; at: number }>();
let rotationCursor = randomInt(1_000_000);

export interface DevinPassthroughContext {
  readonly config: OcxConfig;
  readonly draining: boolean;
  readonly server?: Parameters<typeof disableResponsesRequestTimeout>[1];
}

const CONNECT_CODE: Record<number, string> = {
  400: "invalid_argument",
  401: "unauthenticated",
  403: "permission_denied",
  404: "not_found",
  405: "unimplemented",
  413: "resource_exhausted",
  415: "invalid_argument",
  429: "resource_exhausted",
  499: "canceled",
  502: "unavailable",
  503: "unavailable",
};

function refuse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({ code: CONNECT_CODE[status] ?? "internal", message: `opencodex: ${message}` }),
    { status, headers: { "content-type": "application/json; charset=UTF-8", ...headers } },
  );
}

/** The path after `/devin/<key>`, and the key; undefined when the path is not that shape. */
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
  | { kind: "account"; accountId: string }
  | { kind: "pool-empty" }
  | { kind: "pool-exhausted"; retryAfterSeconds: number | null };

function chooseDevinAccount(key: string, now = Date.now()): DevinAccountChoice {
  const all = listAccounts(DEVIN_PROVIDER);
  if (all.length === 0) return { kind: "pool-empty" };
  const eligible = eligibleFailoverAccounts(DEVIN_PROVIDER, now);
  if (eligible.length === 0) {
    return { kind: "pool-exhausted", retryAfterSeconds: genericFailoverRetryAfterSeconds(DEVIN_PROVIDER, now) };
  }
  const previous = callerAccounts.get(key);
  if (previous && now - previous.at <= CALLER_AFFINITY_TTL_MS && eligible.includes(previous.accountId)) {
    rememberCaller(key, previous.accountId, now);
    return { kind: "account", accountId: previous.accountId };
  }
  const chosen = eligible[rotationCursor++ % eligible.length]!;
  rememberCaller(key, chosen, now);
  return { kind: "account", accountId: chosen };
}

/** Test seam: forget process-local caller affinity and rotation cursor. */
export function resetDevinAccountState(): void {
  callerAccounts.clear();
  rotationCursor = 0;
}

interface RawField {
  readonly num: number;
  readonly wire: number;
  readonly raw: Buffer;
  readonly payload?: Buffer;
}

function scanRawFields(buf: Buffer): RawField[] | null {
  const fields: RawField[] = [];
  let i = 0;
  try {
    while (i < buf.length) {
      const start = i;
      const [tagBig, afterTag] = decodeVarint(buf, i);
      i = afterTag;
      const tag = Number(tagBig);
      const num = tag >> 3;
      const wire = tag & 0x7;
      if (num <= 0) return null;
      if (wire === 0) {
        const [, afterVal] = decodeVarint(buf, i);
        i = afterVal;
        fields.push({ num, wire, raw: buf.subarray(start, i) });
      } else if (wire === 1) {
        if (i + 8 > buf.length) return null;
        i += 8;
        fields.push({ num, wire, raw: buf.subarray(start, i) });
      } else if (wire === 2) {
        const [lenBig, valStart] = decodeVarint(buf, i);
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
  } catch {
    return null;
  }
  return fields;
}

/**
 * Swap `Metadata.api_key` (field 3) and strip `Metadata.user_jwt` (field 21) inside top-level
 * field 1 (`Metadata`), keeping every other protobuf field byte-for-byte intact.
 */
export function rewriteDevinProtoCredentials(proto: Buffer, apiKey: string): Buffer {
  if (proto.length === 0) return proto;
  const topFields = scanRawFields(proto);
  if (!topFields) return proto;
  let changed = false;
  const out: Buffer[] = [];
  for (const field of topFields) {
    if (field.num === 1 && field.wire === 2 && field.payload) {
      const metaFields = scanRawFields(field.payload);
      const hasApiKey = metaFields?.some(f => f.num === 3 && f.wire === 2 && f.payload && f.payload.length > 0);
      if (metaFields && hasApiKey) {
        const metaOut: Buffer[] = [];
        for (const mf of metaFields) {
          if (mf.num === 3 && mf.wire === 2) {
            metaOut.push(encodeString(3, apiKey));
            changed = true;
          } else if (mf.num === 21 && mf.wire === 2) {
            changed = true;
          } else {
            metaOut.push(mf.raw);
          }
        }
        out.push(encodeMessage(1, Buffer.concat(metaOut)));
        continue;
      }
    }
    out.push(field.raw);
  }
  return changed ? Buffer.concat(out) : proto;
}

function rewriteRequestBody(
  bytes: Uint8Array,
  contentType: string | null,
  contentEncoding: string | null,
  apiKey: string,
): Buffer | null {
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bound = { maxOutputLength: MAX_DEVIN_REQUEST_BYTES };

  if (ct === "application/connect+proto") {
    const out: Buffer[] = [];
    let i = 0;
    try {
      while (i + 5 <= buf.length) {
        const flags = buf[i]!;
        const len = buf.readUInt32BE(i + 1);
        if (i + 5 + len > buf.length) return null;
        const rawPayload = buf.subarray(i + 5, i + 5 + len);
        i += 5 + len;
        if (flags & 0x02) {
          const hdr = Buffer.alloc(5);
          hdr[0] = flags;
          hdr.writeUInt32BE(rawPayload.length, 1);
          out.push(hdr, rawPayload);
          continue;
        }
        const plain = flags & 0x01 ? gunzipSync(rawPayload, bound) : rawPayload;
        const rewritten = rewriteDevinProtoCredentials(plain, apiKey);
        const wirePayload = flags & 0x01 ? gzipSync(rewritten) : rewritten;
        const hdr = Buffer.alloc(5);
        hdr[0] = flags;
        hdr.writeUInt32BE(wirePayload.length, 1);
        out.push(hdr, wirePayload);
      }
      if (i !== buf.length) return null;
      return Buffer.concat(out);
    } catch {
      return null;
    }
  }

  if (ct === "application/proto" || ct === "application/grpc-web+proto") {
    const coding = contentEncoding?.trim().toLowerCase();
    try {
      if (!coding || coding === "identity") return rewriteDevinProtoCredentials(buf, apiKey);
      if (coding === "gzip" || coding === "x-gzip") {
        return gzipSync(rewriteDevinProtoCredentials(gunzipSync(buf, bound), apiKey));
      }
      return null;
    } catch {
      return null;
    }
  }

  return buf;
}

function devinOrigin(config: OcxConfig, accountBaseUrl?: string): string {
  const candidate = config.providers[DEVIN_PROVIDER]?.baseUrl ?? accountBaseUrl;
  if (!candidate) return DEVIN_DEFAULT_API_SERVER;
  try {
    const url = new URL(candidate);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.username || url.password) return DEVIN_DEFAULT_API_SERVER;
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.origin : DEVIN_DEFAULT_API_SERVER;
  } catch {
    return DEVIN_DEFAULT_API_SERVER;
  }
}

function settledBody(
  source: ReadableStream<Uint8Array>,
  settle: (status: number | "complete") => void,
  abort: () => void,
  cancelled: () => boolean,
): ReadableStream<Uint8Array> {
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

export async function handleDevinPassthrough(req: Request, ctx: DevinPassthroughContext): Promise<Response> {
  const { config } = ctx;
  const url = new URL(req.url);
  const parts = splitDevinPath(url.pathname);
  if (!parts || !DEVIN_RPC_PATH.test(parts.rpcPath)) {
    return refuse(404, "unknown Devin pass-through RPC path");
  }
  if (ctx.draining) return refuse(503, "hub is restarting");

  const admission = resolveDataPlaneAdmissionSecret(parts.key, config, "dedicated");
  if (!admission) return refuse(401, "opencodex API key required in WINDSURF_API_SERVER_URL (/devin/<key>)");
  const keyEntry = admission.kind === "configured" ? config.apiKeys?.find(e => e.id === admission.keyId) : undefined;
  if (keyEntry?.allowedProviders?.length && !keyEntry.allowedProviders.includes(DEVIN_PROVIDER)) {
    return refuse(403, "this opencodex key may not use the Devin pool");
  }
  if (req.method !== "POST") return refuse(405, "Devin Connect-RPC calls are POST");

  disableResponsesRequestTimeout(req, ctx.server);
  const bytes = await readBoundedRequestBytes(req, MAX_DEVIN_REQUEST_BYTES);
  if (bytes === null) return refuse(413, "request body exceeds the pass-through limit");

  const incomingAuth = req.headers.get("authorization") ?? "";
  const choice = chooseDevinAccount(callerKey(admission, incomingAuth));
  if (choice.kind === "pool-empty") return refuse(503, "no Devin account is signed in to this hub");
  if (choice.kind === "pool-exhausted") {
    return refuse(429, "every pooled Devin account is cooling down",
      choice.retryAfterSeconds === null ? {} : { "retry-after": String(choice.retryAfterSeconds) });
  }

  const credential = getAccountCredential(DEVIN_PROVIDER, choice.accountId);
  if (!credential?.access) return refuse(503, "chosen pooled Devin account has no credential");
  const apiKey = normalizeDevinSessionToken(credential.access);

  const rewrittenBody = rewriteRequestBody(
    bytes,
    req.headers.get("content-type"),
    req.headers.get("content-encoding"),
    apiKey,
  );
  if (rewrittenBody === null) return refuse(415, "unsupported or malformed Devin Connect-RPC request body");

  const lease = tryAdmitTurn(undefined, req.signal);
  if (!lease) return refuse(503, "hub is at its active-turn limit or restarting");

  const headers = messagesEndToEndHeaders(req.headers, true);
  for (const name of [...headers.keys()]) {
    if (name === "authorization" || name === "cookie" || name.startsWith("x-opencodex-")) headers.delete(name);
  }
  if (incomingAuth.length > 0) {
    headers.set("authorization", `Basic ${apiKey}-${apiKey}`);
  }

  const start = Date.now();
  const requestId = nextRequestLogId(start);
  const rpcMethod = parts.rpcPath.slice(parts.rpcPath.lastIndexOf("/") + 1);
  const logCtx: RequestLogContext = {
    model: rpcMethod,
    provider: DEVIN_PROVIDER,
    client: classifyUsageClient(req.headers),
    accountLogLabel: oauthAccountLogLabel(choice.accountId, DEVIN_PROVIDER),
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
    const targetUrl = new URL(devinOrigin(config, credential.apiBaseUrl) + parts.rpcPath + url.search);
    upstream = await sendExactly(targetUrl, headers, rewrittenBody, controller.signal);
  } catch {
    const cancelled = req.signal.aborted || controller.signal.aborted;
    settle(cancelled ? 499 : 502);
    if (isDraining()) return refuse(503, "hub is restarting");
    return cancelled ? refuse(499, "request cancelled") : refuse(503, "could not reach Devin upstream");
  }
  upstreamStatus = upstream.status;
  if (upstream.status === 429) {
    const poolRow: OcxProviderConfig = { adapter: "devin", authMode: "oauth", baseUrl: DEVIN_DEFAULT_API_SERVER };
    const poolView: OcxConfig = { ...config, providers: { ...config.providers, [DEVIN_PROVIDER]: poolRow } };
    rotateGenericOAuthAccountOn429(
      poolView, DEVIN_PROVIDER, choice.accountId, upstream.headers.get("retry-after"), Date.now(), null, false,
    );
  }

  return new Response(settledBody(upstream.body, settle, () => controller.abort(), () => req.signal.aborted), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: messagesEndToEndHeaders(upstream.headers),
  });
}
