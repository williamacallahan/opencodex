/**
 * Mistral Vibe CLI pass-through (`/vibe/*`).
 *
 * Forwards native Mistral Vibe HTTP calls byte-for-byte (swapping only the upstream `Authorization`
 * bearer and `Host`), strictly gated to genuine Vibe User-Agent identities on an explicit
 * path/method allowlist while reserving `mistral-vibe` pooled CHAT-plan keys away from hub-built
 * translated routes (`nativeHarnessOnly`).
 */
import {
  admissionFields,
  isApiAuthRequired,
  isLoopbackHostname,
  isLoopbackRequestHost,
  resolveApiAuth,
  type DataPlaneAdmission,
  type RequestPolicyView,
} from "./auth-cors";
import { readBoundedRequestBytes } from "./index/bounded-request";
import { isDraining, tryAdmitTurn } from "./lifecycle";
import { messagesEndToEndHeaders } from "./messages-native-integrity";
import { disableResponsesRequestTimeout } from "./responses/fetch-helpers";
import { addFinalRequestLog, nextRequestLogId, type RequestLogContext } from "./request-log";
import {
  createSettledPassthroughBody,
  logPassthroughUpstreamFailure,
  sendExactly,
  type ExactResponse,
} from "./agy-passthrough-send";
import { decodeBoundedPayload, extractTopLevelJsonStringField } from "./agy-passthrough";
import {
  chooseVibeKey,
  forgetVibeAffinity,
  isVibeBudgetExhausted402,
  parkVibeKeyUntilNextMonthUtc,
  recordVibe429Cooldown,
  recordVibeAuthFailureCooldown,
  rememberVibeAffinity,
  type VibeKeyChoice,
} from "./vibe-passthrough-keys";
import { nativeHarnessOnly, VIBE_PROVIDER_ID } from "../lib/native-harness";
import { sanitizeLogMetadataString } from "../lib/redact";
import { classifyUsageClient } from "../usage/client";
import type { OcxConfig, OcxUsage } from "../types";

const MAX_VIBE_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_MODEL_SNIFF_DECODE_BYTES = 4 * 1024 * 1024;
const MAX_RETRY_ERROR_PEEK_BYTES = 64 * 1024;
const MAX_OBSERVED_JSON_USAGE_BYTES = 512 * 1024;
const MAX_SSE_LINE_BYTES = 64 * 1024;
const CANONICAL_MISTRAL_API_ORIGIN = "https://api.mistral.ai";
const CANONICAL_MISTRAL_CHAT_ORIGIN = "https://chat.mistral.ai";
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const VIBE_CLI_UA_PATTERN = /^mistral-client-python\/Mistral-Vibe\/\S+/;
const VIBE_HTTPX_UA_PATTERN = /^python-httpx2\/\S+/;
const RETRYABLE_PRE_OUTPUT_STATUSES = new Set([401, 402, 429, 502, 503, 504]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export interface VibePassthroughContext {
  readonly config: OcxConfig;
  readonly policy: RequestPolicyView;
  readonly draining: boolean;
  readonly server?: Parameters<typeof disableResponsesRequestTimeout>[1];
}

interface VibeRouteMatch {
  readonly method: "GET" | "POST";
  readonly subPath: string;
  readonly targetUrl: URL;
  readonly uaPolicy: "vibe-cli" | "vibe-or-httpx";
  readonly logModel: string;
  readonly isInference: boolean;
}

function refuse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message: `opencodex: ${message}`, type: "invalid_request_error", code: status } }), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}

function keyChoiceRefusal(choice: Exclude<VibeKeyChoice, { kind: "key" }>): Response {
  switch (choice.kind) {
    case "pool-empty":
      return refuse(503, "no Mistral Vibe subscription key is configured on this hub");
    case "pool-unavailable":
      return refuse(503, "every pooled Mistral Vibe key is disabled or unavailable");
    case "pool-exhausted":
      return refuse(429, "every pooled Mistral Vibe key is cooling down or exhausted", {
        "retry-after": String(choice.retryAfterSeconds),
      });
  }
}

function resolveVibeOrigins(config: OcxConfig): { apiOrigin: string; chatOrigin: string; loopback: boolean } {
  const row = config.providers[VIBE_PROVIDER_ID];
  if (!row?.baseUrl) {
    return { apiOrigin: CANONICAL_MISTRAL_API_ORIGIN, chatOrigin: CANONICAL_MISTRAL_CHAT_ORIGIN, loopback: false };
  }
  try {
    const parsed = new URL(row.baseUrl);
    if (parsed.username || parsed.password) {
      return { apiOrigin: CANONICAL_MISTRAL_API_ORIGIN, chatOrigin: CANONICAL_MISTRAL_CHAT_ORIGIN, loopback: false };
    }
    if (row.allowPrivateNetwork === true && parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
      return { apiOrigin: parsed.origin, chatOrigin: `${parsed.origin}/chat`, loopback: true };
    }
    if (parsed.protocol === "https:" && parsed.origin === CANONICAL_MISTRAL_API_ORIGIN) {
      return { apiOrigin: CANONICAL_MISTRAL_API_ORIGIN, chatOrigin: CANONICAL_MISTRAL_CHAT_ORIGIN, loopback: false };
    }
  } catch {
    // Fall back to canonical endpoints on unparseable configuration.
  }
  return { apiOrigin: CANONICAL_MISTRAL_API_ORIGIN, chatOrigin: CANONICAL_MISTRAL_CHAT_ORIGIN, loopback: false };
}

function rawRequestPathname(rawUrl: string): string {
  const withoutOrigin = rawUrl.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/, "");
  const queryIdx = withoutOrigin.search(/[?#]/);
  return queryIdx === -1 ? withoutOrigin : withoutOrigin.slice(0, queryIdx);
}

function hasUnsafePathSequence(rawPathname: string): boolean {
  if (!rawPathname.startsWith("/vibe/")) return true;
  if (rawPathname.includes("//") || rawPathname.includes("\\")) return true;
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(rawPathname)) return true;
  if (/[\u0000-\u001f\u007f]/.test(rawPathname)) return true;
  if (/%2e|%2f|%5c|%00/i.test(rawPathname)) return true;
  return false;
}

function classifyVibeRoute(req: Request, config: OcxConfig): VibeRouteMatch | { kind: "not-found" } | { kind: "method-not-allowed"; allow: string } {
  const rawPathname = rawRequestPathname(req.url);
  if (hasUnsafePathSequence(rawPathname)) return { kind: "not-found" };
  const url = new URL(req.url);
  if (hasUnsafePathSequence(url.pathname)) return { kind: "not-found" };
  const subPath = url.pathname.slice("/vibe".length);
  const { apiOrigin, chatOrigin } = resolveVibeOrigins(config);

  const expectMethod = (
    allowed: "GET" | "POST",
    uaPolicy: "vibe-cli" | "vibe-or-httpx",
    targetUrl: URL,
    logModel: string,
    isInference: boolean,
  ): VibeRouteMatch | { kind: "method-not-allowed"; allow: string } => {
    if (req.method !== allowed) return { kind: "method-not-allowed", allow: allowed };
    return { method: allowed, subPath, targetUrl, uaPolicy, logModel, isInference };
  };

  if (subPath === "/v1/chat/completions") {
    return expectMethod("POST", "vibe-cli", new URL(`${apiOrigin}/v1/chat/completions`), "mistral-vibe", true);
  }
  if (subPath === "/v1/models") {
    return expectMethod("GET", "vibe-cli", new URL(`${apiOrigin}/v1/models`), "vibe:models", false);
  }
  if (subPath.startsWith("/v1/models/")) {
    const modelId = subPath.slice("/v1/models/".length);
    if (!SAFE_MODEL_ID_PATTERN.test(modelId)) return { kind: "not-found" };
    return expectMethod("GET", "vibe-cli", new URL(`${apiOrigin}/v1/models/${modelId}`), modelId, false);
  }
  if (subPath === "/v1/connectors/bootstrap") {
    return expectMethod("GET", "vibe-or-httpx", new URL(`${apiOrigin}/v1/connectors/bootstrap${url.search}`), "vibe:connectors", false);
  }
  if (subPath === "/v1/billing/budget") {
    return expectMethod("GET", "vibe-cli", new URL(`${apiOrigin}/v1/billing/budget`), "vibe:billing-budget", false);
  }
  if (subPath === "/v1/users/me") {
    return expectMethod("GET", "vibe-cli", new URL(`${apiOrigin}/v1/users/me`), "vibe:users-me", false);
  }
  if (subPath === "/chat/api/v1/code/managed-config") {
    return expectMethod("GET", "vibe-or-httpx", new URL(`${chatOrigin}/api/v1/code/managed-config${url.search}`), "vibe:managed-config", false);
  }
  return { kind: "not-found" };
}

async function extractModelReadOnly(bytes: Uint8Array, contentEncoding: string | null): Promise<string | undefined> {
  if (bytes.byteLength === 0) return undefined;
  const plain = await decodeBoundedPayload(bytes, contentEncoding, MAX_MODEL_SNIFF_DECODE_BYTES);
  if (!plain || plain.byteLength === 0) return undefined;
  return sanitizeLogMetadataString(extractTopLevelJsonStringField(plain, "model"), 128);
}

function parseMistralUsageObject(value: unknown): OcxUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const inputTokens = typeof raw.prompt_tokens === "number" && Number.isFinite(raw.prompt_tokens) ? raw.prompt_tokens : undefined;
  const outputTokens = typeof raw.completion_tokens === "number" && Number.isFinite(raw.completion_tokens) ? raw.completion_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(typeof raw.total_tokens === "number" && Number.isFinite(raw.total_tokens) ? { totalTokens: raw.total_tokens } : {}),
  };
}

function extractUsageFromJsonPayload(bytes: Uint8Array): OcxUsage | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OBSERVED_JSON_USAGE_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parseMistralUsageObject((parsed as Record<string, unknown>).usage);
  } catch {
    return undefined;
  }
}

/** Bounded SSE/JSON usage observer attached cleanly without altering streamed bytes. */
class BoundedUsageObserver {
  private readonly sseDecoder: TextDecoder | null;
  private pendingChunks: string[] = [];
  private pendingLength = 0;
  private droppingOversizedLine = false;
  private jsonChunks: Uint8Array[] | null;
  private jsonBytes = 0;
  private readonly sseMode: boolean;

  constructor(contentType: string | null, contentEncoding: string | null) {
    const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
    const unencoded = !contentEncoding || contentEncoding.trim().toLowerCase() === "identity";
    this.sseMode = unencoded && ct === "text/event-stream";
    this.sseDecoder = this.sseMode ? new TextDecoder() : null;
    this.jsonChunks = unencoded && ct === "application/json" ? [] : null;
  }

  observe(chunk: Uint8Array, onUsage: (usage: OcxUsage) => void): void {
    if (this.jsonChunks) {
      if (this.jsonBytes + chunk.byteLength > MAX_OBSERVED_JSON_USAGE_BYTES) {
        this.jsonChunks = null;
        return;
      }
      this.jsonChunks.push(chunk);
      this.jsonBytes += chunk.byteLength;
      return;
    }
    if (!this.sseMode || !this.sseDecoder) return;
    const text = this.sseDecoder.decode(chunk, { stream: true });
    let lineStart = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) !== 0x0A) continue;
      this.drainCompleteLine(text.slice(lineStart, i), onUsage);
      lineStart = i + 1;
    }
    this.appendPiece(text.slice(lineStart));
  }

  finish(onUsage: (usage: OcxUsage) => void): void {
    if (this.jsonChunks && this.jsonChunks.length > 0) {
      const joined = Buffer.concat(this.jsonChunks);
      this.jsonChunks = null;
      const usage = extractUsageFromJsonPayload(joined);
      if (usage) onUsage(usage);
      return;
    }
    if (!this.sseMode || !this.sseDecoder) return;
    const trailing = this.sseDecoder.decode();
    if (trailing || this.pendingLength > 0 || this.droppingOversizedLine) {
      this.drainCompleteLine(trailing, onUsage);
    }
  }

  private appendPiece(piece: string): void {
    if (this.droppingOversizedLine || piece.length === 0) return;
    if (this.pendingLength + piece.length > MAX_SSE_LINE_BYTES) {
      this.pendingChunks = [];
      this.pendingLength = 0;
      this.droppingOversizedLine = true;
      return;
    }
    this.pendingChunks.push(piece);
    this.pendingLength += piece.length;
  }

  private drainCompleteLine(tailPiece: string, onUsage: (usage: OcxUsage) => void): void {
    if (this.droppingOversizedLine) {
      this.droppingOversizedLine = false;
      this.pendingChunks = [];
      this.pendingLength = 0;
      return;
    }
    if (this.pendingLength + tailPiece.length > MAX_SSE_LINE_BYTES) {
      this.pendingChunks = [];
      this.pendingLength = 0;
      return;
    }
    const line = this.pendingChunks.length === 0 ? tailPiece : `${this.pendingChunks.join("")}${tailPiece}`;
    this.pendingChunks = [];
    this.pendingLength = 0;
    if (line) this.inspectSseLine(line, onUsage);
  }

  private inspectSseLine(rawLine: string, onUsage: (usage: OcxUsage) => void): void {
    const trimmed = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!trimmed.startsWith("data:")) return;
    const payloadText = trimmed.slice(5).trim();
    if (!payloadText || payloadText === "[DONE]") return;
    try {
      const parsed: unknown = JSON.parse(payloadText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const usage = parseMistralUsageObject((parsed as Record<string, unknown>).usage);
      if (usage) onUsage(usage);
    } catch {
      // Ignore partial/malformed SSE frames in the passive observer.
    }
  }
}

type BoundedPeekResult =
  | { complete: true; bytes: Uint8Array<ArrayBuffer> }
  | { complete: false; prefixChunks: Uint8Array[]; reader: ReadableStreamDefaultReader<Uint8Array> };

async function peekBoundedPrefix(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<BoundedPeekResult> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (chunks.length === 0) return { complete: true, bytes: new Uint8Array(0) };
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { complete: true, bytes: joined };
      }
      if (!value || value.byteLength === 0) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) {
        return { complete: false, prefixChunks: chunks, reader };
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

function replayPeekedStream(prefixChunks: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < prefixChunks.length) {
        controller.enqueue(prefixChunks[index++]!);
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value && value.byteLength > 0) controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function isAllowedVibeUserAgent(ua: string, policy: VibeRouteMatch["uaPolicy"]): boolean {
  if (VIBE_CLI_UA_PATTERN.test(ua)) return true;
  if (policy === "vibe-or-httpx" && VIBE_HTTPX_UA_PATTERN.test(ua)) return true;
  return false;
}

function buildOutgoingHeaders(source: Headers, upstreamApiKey: string): Headers {
  const headers = messagesEndToEndHeaders(source, true);
  for (const name of [...headers.keys()]) {
    if (
      name === "authorization"
      || name === "cookie"
      || name === "x-api-key"
      || name.startsWith("x-opencodex-")
    ) {
      headers.delete(name);
    }
  }
  headers.set("authorization", `Bearer ${upstreamApiKey}`);
  return headers;
}

export async function handleVibePassthrough(req: Request, ctx: VibePassthroughContext): Promise<Response> {
  const { config, policy } = ctx;
  const route = classifyVibeRoute(req, config);
  if ("kind" in route) {
    if (route.kind === "not-found") return refuse(404, "unknown Mistral Vibe pass-through path");
    if (req.headers.has("origin") || [...req.headers.keys()].some(name => name.startsWith("sec-fetch-"))) {
      return refuse(403, "the Mistral Vibe pool serves only native Mistral Vibe CLI requests");
    }
    // Authenticate before exposing 405 on valid paths when auth is required.
    const authorization = req.headers.get("authorization") ?? "";
    if (isApiAuthRequired(policy) && (!/^Bearer \S+$/i.test(authorization) || !resolveApiAuth(req, policy))) {
      return refuse(401, "opencodex API key required for /vibe pass-through");
    }
    if (!isApiAuthRequired(policy) && !isLoopbackRequestHost(req.headers.get("Host"))) {
      return refuse(403, "non-loopback Host header rejected");
    }
    return refuse(405, `Mistral Vibe ${route.allow} endpoint only`, { allow: route.allow });
  }
  if (ctx.draining) return refuse(503, "hub is restarting");

  const authorization = req.headers.get("authorization") ?? "";
  if (isApiAuthRequired(policy) && !/^Bearer \S+$/i.test(authorization)) {
    return refuse(401, "opencodex Bearer API key required in Authorization header");
  }
  const admission: DataPlaneAdmission | null = resolveApiAuth(req, policy);
  if (!admission) return refuse(401, "opencodex API key required for /vibe pass-through");
  if (!isApiAuthRequired(policy) && !isLoopbackRequestHost(req.headers.get("Host"))) {
    return refuse(403, "non-loopback Host header rejected");
  }

  const keyEntry = admission.kind === "configured" ? config.apiKeys?.find(entry => entry.id === admission.keyId) : undefined;
  if (keyEntry?.allowedProviders?.length && !keyEntry.allowedProviders.includes(VIBE_PROVIDER_ID)) {
    return refuse(403, "this opencodex key may not use the Mistral Vibe pool");
  }
  if (req.headers.has("origin") || [...req.headers.keys()].some(name => name.startsWith("sec-fetch-"))) {
    return refuse(403, "the Mistral Vibe pool serves only native Mistral Vibe CLI requests");
  }
  const userAgent = req.headers.get("user-agent") ?? "";
  if (!isAllowedVibeUserAgent(userAgent, route.uaPolicy)) {
    return refuse(403, "the Mistral Vibe pool serves only genuine Mistral Vibe CLI clients");
  }
  if (!nativeHarnessOnly()) {
    return refuse(503, "the /vibe pass-through requires nativeHarnessOnly on this hub");
  }

  disableResponsesRequestTimeout(req, ctx.server);
  const requestBytes = route.method === "POST"
    ? await readBoundedRequestBytes(req, MAX_VIBE_REQUEST_BYTES)
    : new Uint8Array(0);
  if (requestBytes === null) return refuse(413, "request body exceeds the pass-through limit");

  const affinityHeader = req.headers.get("x-affinity");
  const providerRow = config.providers[VIBE_PROVIDER_ID];
  const initialChoice = chooseVibeKey(providerRow, affinityHeader);
  if (initialChoice.kind !== "key") return keyChoiceRefusal(initialChoice);

  const inferredModel = route.isInference
    ? (await extractModelReadOnly(requestBytes, req.headers.get("content-encoding"))) ?? route.logModel
    : route.logModel;

  const lease = tryAdmitTurn(undefined, req.signal);
  if (!lease) return refuse(503, "hub is at its active-turn limit or restarting");

  const start = Date.now();
  const requestId = nextRequestLogId(start);
  const logCtx: RequestLogContext = {
    model: inferredModel,
    provider: VIBE_PROVIDER_ID,
    client: classifyUsageClient(req.headers),
    accountLogLabel: initialChoice.accountLogLabel,
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

  const failLog = (defaultPhase: "unknown" | "body", error: unknown, reusedSocket?: boolean) => logPassthroughUpstreamFailure({
    prefix: "[vibe-passthrough]",
    targetKey: "path",
    target: route.subPath,
    account: logCtx.accountLogLabel,
    defaultPhase,
    startedAt: start,
    cancelled: req.signal.aborted || controller.signal.aborted,
    draining: isDraining(),
    reusedSocket,
  }, error);

  const triedKeyIds = new Set<string>();
  let activeChoice: Extract<VibeKeyChoice, { kind: "key" }> = initialChoice;
  let nextChoice: Extract<VibeKeyChoice, { kind: "key" }> | undefined;
  let upstream: ExactResponse | undefined;
  let bufferedTerminalBody: Uint8Array<ArrayBuffer> | undefined;
  let overflowTerminalStream: ReadableStream<Uint8Array> | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (nextChoice) {
      activeChoice = nextChoice;
      nextChoice = undefined;
    }
    triedKeyIds.add(activeChoice.key.id);
    logCtx.accountLogLabel = activeChoice.accountLogLabel;
    const outgoingHeaders = buildOutgoingHeaders(req.headers, activeChoice.key.apiKey);

    try {
      upstream = await sendExactly(
        route.targetUrl,
        outgoingHeaders,
        requestBytes,
        controller.signal,
        undefined,
        undefined,
        route.method,
      );
    } catch (error) {
      const cancelled = req.signal.aborted || controller.signal.aborted;
      failLog("unknown", error);
      if (!cancelled && !isDraining() && attempt === 0) {
        const siblingAvailable = chooseVibeKey(providerRow, null, triedKeyIds);
        if (siblingAvailable.kind === "key") {
          nextChoice = siblingAvailable;
          continue;
        }
      }
      settle(cancelled ? 499 : 502);
      if (isDraining()) return refuse(503, "hub is restarting");
      return cancelled ? refuse(499, "request cancelled") : refuse(503, "could not reach Mistral upstream");
    }

    upstreamStatus = upstream.status;

    if (upstream.status === 429) {
      recordVibe429Cooldown(activeChoice.key.id, upstream.headers);
      forgetVibeAffinity(affinityHeader);
    } else if (upstream.status === 401 || upstream.status === 403) {
      recordVibeAuthFailureCooldown(activeChoice.key.id);
      forgetVibeAffinity(affinityHeader);
    } else if (upstream.status === 402) {
      let peek: BoundedPeekResult;
      try {
        peek = await peekBoundedPrefix(upstream.body, MAX_RETRY_ERROR_PEEK_BYTES);
      } catch (error) {
        const cancelled = req.signal.aborted || controller.signal.aborted;
        failLog("body", error, upstream.reusedSocket);
        void upstream.body.cancel().catch(() => {});
        if (!cancelled && !isDraining() && attempt === 0) {
          const siblingAvailable = chooseVibeKey(providerRow, null, triedKeyIds);
          if (siblingAvailable.kind === "key") {
            nextChoice = siblingAvailable;
            upstream = undefined;
            continue;
          }
        }
        settle(cancelled ? 499 : 502);
        if (isDraining()) return refuse(503, "hub is restarting");
        return cancelled ? refuse(499, "request cancelled") : refuse(502, "Mistral upstream response failed");
      }
      if (peek.complete) {
        bufferedTerminalBody = peek.bytes;
        const decodedPeek = await decodeBoundedPayload(
          peek.bytes,
          upstream.headers.get("content-encoding"),
          MAX_RETRY_ERROR_PEEK_BYTES,
        );
        if (decodedPeek && isVibeBudgetExhausted402(402, decodedPeek)) {
          parkVibeKeyUntilNextMonthUtc(activeChoice.key.id);
          forgetVibeAffinity(affinityHeader);
        } else {
          // Non-budget 402 should be returned unchanged without retrying a sibling key.
          break;
        }
      } else {
        // Non-budget >64 KiB 402 passes through untruncated without retrying.
        overflowTerminalStream = replayPeekedStream(peek.prefixChunks, peek.reader);
        break;
      }
    }

    if (
      attempt === 0
      && RETRYABLE_PRE_OUTPUT_STATUSES.has(upstream.status)
      && !req.signal.aborted
      && !controller.signal.aborted
    ) {
      const siblingAvailable = chooseVibeKey(providerRow, null, triedKeyIds);
      if (siblingAvailable.kind === "key") {
        if (!bufferedTerminalBody) void upstream.body.cancel().catch(() => {});
        bufferedTerminalBody = undefined;
        overflowTerminalStream = undefined;
        nextChoice = siblingAvailable;
        upstream = undefined;
        continue;
      }
    }
    break;
  }

  if (!upstream) {
    settle(503);
    return refuse(503, "could not reach Mistral upstream");
  }

  if (upstream.status >= 200 && upstream.status < 300) {
    rememberVibeAffinity(affinityHeader, activeChoice.key.id);
  }

  const respHeaders = messagesEndToEndHeaders(upstream.headers);
  if (NULL_BODY_STATUSES.has(upstream.status)) {
    settle("complete");
    void upstream.body.cancel().catch(() => {});
    return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
  }

  if (bufferedTerminalBody !== undefined) {
    settle("complete");
    return new Response(bufferedTerminalBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  }

  const observer = route.isInference && upstream.status >= 200 && upstream.status < 300
    ? new BoundedUsageObserver(upstream.headers.get("content-type"), upstream.headers.get("content-encoding"))
    : null;

  const baseStream = overflowTerminalStream ?? upstream.body;
  const source = observer
    ? baseStream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, transformController) {
        observer.observe(chunk, usage => { logCtx.usage = usage; });
        transformController.enqueue(chunk);
      },
      flush() {
        observer.finish(usage => { logCtx.usage = usage; });
      },
    }))
    : baseStream;

  return new Response(
    createSettledPassthroughBody({
      source,
      settle,
      abort: () => controller.abort(),
      isAborted: () => req.signal.aborted,
      onError: error => failLog("body", error, upstream.reusedSocket),
    }),
    { status: upstream.status, statusText: upstream.statusText, headers: respHeaders },
  );
}
