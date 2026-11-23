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
  readonly elapsedMs: number;
  readonly host: string;
  readonly reusedSocket?: boolean;

  constructor(
    message: string,
    detail: {
      phase: "connect" | "headers" | "aborted";
      code?: string;
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
    this.elapsedMs = detail.elapsedMs;
    this.host = detail.host;
    this.reusedSocket = detail.reusedSocket;
  }
}

export interface ExactResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array>;
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
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      reject(new AgyUpstreamSendError(error instanceof Error ? error.message : String(error), {
        phase: signal.aborted ? "aborted" : phase,
        code,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        host: url.host,
        reusedSocket: (req as { reusedSocket?: boolean }).reusedSocket,
        cause: error,
      }));
    });
    req.end(body);
  });
}
