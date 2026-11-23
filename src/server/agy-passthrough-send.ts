/**
 * The one physical send of the `/agy` lane, with exactly the headers it is given.
 *
 * `fetch` adds a wildcard `Accept` to a request that has none (an empty value is the only alternative),
 * and agy sends no `Accept`. The Node HTTP client sends the given header list plus `Host` and its own
 * connection framing, no redirect following and no decompression, so Google receives agy's headers
 * and bytes as agy wrote them.
 */
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { redactSecretString, sanitizeLogMetadataString } from "../lib/redact";

const AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: 256,
  maxFreeSockets: 32,
  scheduling: "lifo" as const,
  timeout: 30_000,
};
const httpsAgent = new HttpsAgent(AGENT_OPTIONS);
const httpAgent = new HttpAgent(AGENT_OPTIONS);
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "trailer", "te"]);
export const DEFAULT_AGY_HEADER_TIMEOUT_MS = 30_000;

export class AgyUpstreamSendError extends Error {
  readonly phase: "connect" | "headers" | "aborted";
  readonly code?: string;
  readonly syscall?: string;
  readonly elapsedMs: number;
  readonly host: string;
  readonly reusedSocket?: boolean;

  constructor(
    message: string,
    detail: {
      phase: "connect" | "headers" | "aborted";
      code?: string;
      syscall?: string;
      elapsedMs: number;
      host: string;
      reusedSocket?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, detail.cause !== undefined ? { cause: detail.cause } : undefined);
    this.name = "AgyUpstreamSendError";
    this.phase = detail.phase;
    this.code = detail.code;
    this.syscall = detail.syscall;
    this.elapsedMs = detail.elapsedMs;
    this.host = detail.host;
    this.reusedSocket = detail.reusedSocket;
  }
}

type TransportErrorShape = { code?: unknown; syscall?: unknown; cause?: unknown };

function pickTransportErrorField(error: unknown, field: "code" | "syscall"): string | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const raw = (current as TransportErrorShape)[field];
    if (typeof raw === "string" && raw.length > 0) return raw;
    if (typeof raw === "number") return String(raw);
    current = (current as TransportErrorShape).cause;
  }
  return null;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "[unprintable error]";
  }
}

/** Extract `code`, `syscall`, and a single-line redacted summary through the shared redactor SSOT. */
export function describeUpstreamTransportError(error: unknown): {
  code: string | null;
  syscall: string | null;
  message: string;
} {
  const scrubbedUrl = readErrorMessage(error).replace(/(\bhttps?:\/\/[^\s?#"'<>]+)[?#]\S*/gi, "$1");
  const redacted = redactSecretString(scrubbedUrl)
    .replace(/\b(Basic)(?:[^\S\r\n]+|%20|:)[^\s"',;]+/gi, "$1 [REDACTED]")
    .replace(/\b(Bearer)(?:%20|:)[^\s"',;]+/gi, "$1 [REDACTED]")
    .replace(/\s+/g, " ");
  return {
    code: pickTransportErrorField(error, "code"),
    syscall: pickTransportErrorField(error, "syscall"),
    message: sanitizeLogMetadataString(redacted, 200) ?? "",
  };
}

export interface SettledPassthroughBodyOptions {
  readonly source: ReadableStream<Uint8Array>;
  readonly settle: (status: number | "complete") => void;
  readonly abort: () => void;
  readonly isAborted: () => boolean;
  readonly onError?: (error: unknown) => void;
}

/** Stream an upstream body with WHATWG pull/cancel serialization and guaranteed single settlement. */
export function createSettledPassthroughBody(options: SettledPassthroughBodyOptions): ReadableStream<Uint8Array> {
  const { source, settle, abort, isAborted, onError } = options;
  const reader = source.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (cancelled) return;
        if (done) {
          settle("complete");
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (cancelled) return;
        const aborted = isAborted();
        settle(aborted ? 499 : 502);
        if (!aborted) {
          try {
            onError?.(error);
          } catch {
            // Diagnostics must never prevent upstream stream teardown.
          }
        }
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      settle(499);
      abort();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

export interface UpstreamFailureLogContext {
  readonly prefix: string;
  readonly targetKey: "method" | "rpcPath";
  readonly target: string;
  readonly account: string | undefined;
  readonly defaultPhase: "unknown" | "body";
  readonly startedAt: number;
  readonly cancelled: boolean;
  readonly draining: boolean;
  readonly reusedSocket?: boolean;
}

/** Emit one single-line redacted warning for genuine upstream/hub transport failures. */
export function logPassthroughUpstreamFailure(ctx: UpstreamFailureLogContext, error: unknown): void {
  if (ctx.cancelled && !ctx.draining) return;
  const upstreamErr = error instanceof AgyUpstreamSendError ? error : undefined;
  const detail = describeUpstreamTransportError(error);
  const common = {
    account: ctx.account ?? null,
    phase: upstreamErr?.phase ?? (ctx.cancelled ? "aborted" : ctx.defaultPhase),
    code: upstreamErr?.code ?? detail.code,
    syscall: upstreamErr?.syscall ?? detail.syscall,
    message: detail.message,
    elapsedMs: upstreamErr?.elapsedMs ?? Math.max(0, Date.now() - ctx.startedAt),
    reusedSocket: upstreamErr?.reusedSocket ?? ctx.reusedSocket ?? null,
    cancelled: ctx.cancelled,
    draining: ctx.draining,
  };
  const fields = ctx.targetKey === "method"
    ? { method: ctx.target, ...common }
    : { rpcPath: ctx.target, ...common };
  console.warn(`${ctx.prefix} upstream failure ${JSON.stringify(fields)}`);
}

export interface ExactResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array>;
  readonly reusedSocket?: boolean;
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  const raw = message.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase();
    if (!HOP_BY_HOP.has(name)) headers.append(name, raw[index + 1]!);
  }
  return headers;
}

/** The response bytes as a web stream with backpressure; cancelling it closes the upstream socket. */
function webBody(message: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      message.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if ((controller.desiredSize ?? 1) <= 0) message.pause();
      });
      message.on("end", () => controller.close());
      message.on("error", error => controller.error(error));
      message.on("close", () => { if (!message.complete) controller.error(new Error("Cloud Code response closed before it completed")); });
    },
    pull() { message.resume(); },
    cancel() { message.destroy(); },
  });
}

/** POST `body` to `url` with exactly `headers`; the response body streams back undecoded. */
export function sendExactly(
  url: URL,
  headers: Headers,
  body: Uint8Array,
  signal: AbortSignal,
  headerTimeoutMs = DEFAULT_AGY_HEADER_TIMEOUT_MS,
): Promise<ExactResponse> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let phase: "connect" | "headers" | "aborted" = "connect";
    let settled = false;
    let detachSocketListener: (() => void) | undefined;
    let headerTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (headerTimer !== undefined) {
        clearTimeout(headerTimer);
        headerTimer = undefined;
      }
      detachSocketListener?.();
      detachSocketListener = undefined;
    };

    const outgoing: Record<string, string> = Object.fromEntries(headers);
    outgoing["content-length"] = String(body.byteLength);
    const secure = url.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    const req = send(url, { method: "POST", headers: outgoing, agent: secure ? httpsAgent : httpAgent, signal }, message => {
      if (settled) {
        message.destroy();
        return;
      }
      settled = true;
      finish();
      resolve({
        status: message.statusCode ?? 502,
        statusText: message.statusMessage ?? "",
        headers: responseHeaders(message),
        body: webBody(message),
        reusedSocket: (req as { reusedSocket?: boolean }).reusedSocket,
      });
    });

    const onSocket = (socket: { connecting?: boolean; pending?: boolean; on(ev: "connect", fn: () => void): void; removeListener(ev: "connect", fn: () => void): void }) => {
      if (!socket.connecting && !socket.pending) {
        phase = "headers";
        return;
      }
      const onConnect = () => { phase = "headers"; };
      socket.on("connect", onConnect);
      detachSocketListener = () => socket.removeListener("connect", onConnect);
    };
    req.on("socket", onSocket);

    if (headerTimeoutMs > 0) {
      headerTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        finish();
        const err = new AgyUpstreamSendError(`Upstream response header timeout after ${headerTimeoutMs}ms`, {
          phase: signal.aborted ? "aborted" : phase,
          code: "ETIMEDOUT",
          elapsedMs: Math.max(0, Date.now() - startedAt),
          host: url.host,
          reusedSocket: (req as { reusedSocket?: boolean }).reusedSocket,
        });
        req.destroy(err);
        reject(err);
      }, headerTimeoutMs);
    }

    req.on("error", error => {
      if (settled) return;
      settled = true;
      finish();
      if (error instanceof AgyUpstreamSendError) {
        reject(error);
        return;
      }
      reject(new AgyUpstreamSendError(readErrorMessage(error), {
        phase: signal.aborted ? "aborted" : phase,
        code: pickTransportErrorField(error, "code") ?? undefined,
        syscall: pickTransportErrorField(error, "syscall") ?? undefined,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        host: url.host,
        reusedSocket: (req as { reusedSocket?: boolean }).reusedSocket,
        cause: error,
      }));
    });
    req.end(body);
  });
}
