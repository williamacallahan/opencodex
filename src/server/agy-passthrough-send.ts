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

const httpsAgent = new HttpsAgent({ keepAlive: true });
const httpAgent = new HttpAgent({ keepAlive: true });
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "trailer", "te"]);

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
export function sendExactly(url: URL, headers: Headers, body: Uint8Array, signal: AbortSignal): Promise<ExactResponse> {
  return new Promise((resolve, reject) => {
    const outgoing: Record<string, string> = Object.fromEntries(headers);
    outgoing["content-length"] = String(body.byteLength);
    const secure = url.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    const req = send(url, { method: "POST", headers: outgoing, agent: secure ? httpsAgent : httpAgent, signal }, message => {
      resolve({
        status: message.statusCode ?? 502,
        statusText: message.statusMessage ?? "",
        headers: responseHeaders(message),
        body: webBody(message),
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}
