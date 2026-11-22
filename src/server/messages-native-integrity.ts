/** Strict Messages keeps wire bytes private; parsed JSON is only routing/observation data. */
import { applyAnthropicKeyAuth, resolveAnthropicMessagesUrl } from "../adapters/anthropic";
import type { AnthropicMessagesPassthroughRequest } from "../adapters/anthropic/passthrough";
import { socks5ProxyFromEnv } from "../lib/proxy-env";
import type { OcxProviderConfig } from "../types";
import { physicalSendIntegrityInit } from "./responses/fetch-helpers";
import { publicHeaderValue } from "../lib/http-response-semantics";
import type { CredentialMask } from "../lib/outbound-credential-registry";
import { BOUNDED_BODY_MAX_BYTES, BOUNDED_BODY_TIMEOUT_MS, readBoundedResponseBytes } from "../lib/bounded-body";
import { decodeRequestBody } from "./request-decompress";
import { nativeHarnessOnly } from "../lib/native-harness";
import { createGunzip, createInflate, type Zlib } from "node:zlib";
import type { Transform } from "node:stream";
import { BoundedSseFrameBuffer, MAX_CLIENT_SSE_FRAME_BYTES, joinSseFrameBytes, type BoundedSseFrame } from "./sse-frame-buffer";

const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/** Fetch owns framing; request ingress topology/identity is not an application header. */
export function messagesEndToEndHeaders(source: Headers, stripIngress = false): Headers {
  const headers = new Headers(source);
  for (const name of source.get("connection")?.split(",") ?? []) headers.delete(name.trim());
  for (const name of HOP_HEADERS) headers.delete(name);
  headers.delete("host");
  headers.delete("content-length");
  if (stripIngress) for (const name of [...headers.keys()]) {
    // The hub's own ingress proxies add these (Traefik forwarding, Envoy's request id and x-envoy-*); clients do not.
    if (name === "forwarded" || name === "x-real-ip" || name.startsWith("x-forwarded-") || name === "x-request-id"
      || name.startsWith("x-envoy-") || name.startsWith("tailscale-user-") || name === "tailscale-headers-info") headers.delete(name);
  }
  return headers;
}

function streamDecoder(coding: string): (Transform & Zlib) | undefined {
  switch (coding) {
    case "gzip": case "x-gzip": return createGunzip();
    case "deflate": return createInflate();
    default: return undefined;
  }
}

/** Bytes of wire data a coded stream may hold while its decoded frames are still being inspected. */
const MAX_HELD_WIRE_BYTES = 2 * MAX_CLIENT_SSE_FRAME_BYTES;
/** Keeps one `feed()` under the framer's per-call frame cap whatever the upstream chunk size. */
const FEED_SLICE_BYTES = 8 * 1024;

/** Exact, case-insensitive media-type match shared by the screen and the outer tap. */
export function isEventStream(headers: Headers): boolean {
  return headers.get("content-type")?.split(";")[0]!.trim().toLowerCase() === "text/event-stream";
}

/** Codings a strict stream may negotiate: the only ones the screen can decode incrementally. */
function streamingAcceptEncoding(callerValue: string | null): string | undefined {
  if (callerValue === null) return undefined;
  const quality = new Map<string, number>();
  for (const part of callerValue.split(",")) {
    const [name = "", ...params] = part.split(";");
    const q = params.map(param => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param)?.[1]).find(Boolean);
    quality.set(name.trim().toLowerCase(), q === undefined ? 1 : Number(q));
  }
  const accepts = (name: string, aliases: string[] = []): boolean => {
    const explicit = [name, ...aliases].map(alias => quality.get(alias)).find(value => value !== undefined);
    return (explicit ?? quality.get("*") ?? (name === "identity" ? 1 : 0)) > 0;
  };
  const allowed = [accepts("gzip", ["x-gzip"]) && "gzip", accepts("deflate") && "deflate", accepts("identity") && "identity"]
    .filter((name): name is string => name !== false);
  if (allowed.length === 0) throw new MessagesIntegrityError();
  return allowed.join(", ");
}

/** The masked replacement for a block that carries a sent credential, or undefined when it is clean. */
function maskedBlock(block: Uint8Array, mask: CredentialMask): Uint8Array | undefined {
  const bytes = Buffer.from(block.buffer, block.byteOffset, block.byteLength);
  // A credential is ASCII, so the Latin-1 view matches it byte for byte without a UTF-8 decode.
  const view = bytes.toString("latin1");
  if (mask(view) === view) return undefined;
  const text = bytes.toString("utf8");
  const safe = mask(text);
  return safe === text ? undefined : Buffer.from(safe);
}

/**
 * A successful strict SSE stream is relayed as-is unless a frame carries a sent
 * credential. An identity stream masks that frame before it is enqueued. A coded stream cannot be edited
 * in place: its wire bytes are held and released only up to the point whose decoded output has been
 * inspected (gzip and deflate are the only codings strict streaming negotiates), and the stream is
 * aborted when a frame is credential-bearing, the decoder fails, or a cap is hit. Cost on a clean stream:
 * one delimiter scan and one copy into the framer per decoded byte, one literal credential scan per frame.
 */
function screenStrictSseBody(body: ReadableStream<Uint8Array>, coding: string, mask: CredentialMask): ReadableStream<Uint8Array> | undefined {
  const decoder = coding === "" || coding === "identity" ? null : streamDecoder(coding);
  if (decoder === undefined) return undefined;
  const framer = new BoundedSseFrameBuffer(MAX_CLIENT_SSE_FRAME_BYTES, { terminalFramingException: false });
  const reader = body.getReader();
  const screen = (frames: BoundedSseFrame[], out: Uint8Array[]): void => {
    for (const { block, delimiter } of frames) {
      const safe = maskedBlock(block, mask);
      if (safe && decoder) throw new Error("Upstream SSE error frame withheld");
      if (decoder) continue;
      // One chunk per frame keeps the client-visible chunking of an unscreened stream.
      out.push(joinSseFrameBytes([safe ?? block, delimiter]));
    }
  };
  const feed = (bytes: Uint8Array, out: Uint8Array[]): void => {
    for (let at = 0; at < bytes.byteLength; at += FEED_SLICE_BYTES) screen(framer.feed(bytes.subarray(at, at + FEED_SLICE_BYTES)), out);
  };
  const finishFrames = (out: Uint8Array[]): void => {
    const rest = framer.finish();
    if (rest.byteLength === 0) return;
    const safe = maskedBlock(rest, mask);
    if (safe && decoder) throw new Error("Upstream SSE error frame withheld");
    if (!decoder) out.push(safe ?? rest);
  };
  let decodedBytes = 0;
  let decodeFailure: unknown;
  const held: ({ bytes: Uint8Array; decodedEnd: number } | undefined)[] = [];
  let heldHead = 0;
  let heldBytes = 0;
  const ignored: Uint8Array[] = [];
  decoder?.on("error", error => { decodeFailure ??= error; });
  decoder?.on("data", (part: Buffer) => {
    if (decodeFailure !== undefined) return;
    decodedBytes += part.byteLength;
    try { feed(part, ignored); } catch (error) { decodeFailure = error; decoder.destroy(); }
  });
  let wake: (() => void) | undefined;
  for (const event of ["close", "end", "error"]) decoder?.on(event, () => wake?.());
  const decode = (chunk: Uint8Array | null) => new Promise<void>(resolve => {
    wake = resolve;
    if (chunk) decoder!.write(chunk, () => resolve());
    else decoder!.end();
  }).then(() => { if (decodeFailure !== undefined) throw decodeFailure; });
  /** Wire bytes whose decoded output is fully inside completed, inspected frames may leave. */
  const release = (out: Uint8Array[], all: boolean): void => {
    const inspected = decodedBytes - framer.pendingBytes;
    while (heldHead < held.length && (all || held[heldHead]!.decodedEnd <= inspected)) {
      const entry = held[heldHead]!;
      held[heldHead++] = undefined;
      heldBytes -= entry.bytes.byteLength;
      out.push(entry.bytes);
    }
    if (heldHead === held.length) { held.length = 0; heldHead = 0; }
    else if (heldHead >= 64 && heldHead * 2 >= held.length) { held.splice(0, heldHead); heldHead = 0; }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const out: Uint8Array[] = [];
      try {
        for (;;) {
          let read: Awaited<ReturnType<typeof reader.read>> | undefined;
          let sourceError: { error: unknown } | undefined;
          try { read = await reader.read(); } catch (error) { sourceError = { error }; }
          if (read && !read.done) {
            const chunk = read.value;
            if (decoder) {
              if (heldBytes + chunk.byteLength > MAX_HELD_WIRE_BYTES) throw new RangeError("Strict SSE held bytes exceed inspection limit");
              heldBytes += chunk.byteLength;
              await decode(chunk);
              held.push({ bytes: chunk, decodedEnd: decodedBytes });
              release(out, false);
            } else feed(chunk, out);
          } else if (!sourceError) {
            if (decoder) await decode(null);
            finishFrames(out);
            release(out, true);
          }
          for (const bytes of out.splice(0)) controller.enqueue(bytes);
          if (sourceError) {
            // An upstream cut discards the unfinished frame and held coded bytes: none was verified.
            decoder?.destroy();
            controller.error(sourceError.error);
            return;
          }
          if (read?.done) { controller.close(); return; }
          if (controller.desiredSize !== null && controller.desiredSize > 0) continue;
          return;
        }
      } catch (error) {
        decoder?.destroy();
        void reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    cancel(reason) { decoder?.destroy(); return reader.cancel(reason); },
  });
}

/** Retain the original entity and coding unless a public error contains a sent credential. */
export async function publicStrictMessagesResponse(response: Response, mask: CredentialMask, signal: AbortSignal): Promise<Response> {
  const headers = messagesEndToEndHeaders(response.headers);
  for (const [name, value] of response.headers) {
    if (!headers.has(name)) continue;
    const safe = publicHeaderValue(name, value, mask);
    if (safe === undefined) headers.delete(name);
    else if (safe !== value) headers.set(name, safe);
  }
  let body: BodyInit | null = response.body;
  if (!response.ok && response.body) {
    const coding = response.headers.get("content-encoding");
    if (!coding || coding === "identity") body = mask.redirectBody(response.body);
    else {
      try {
        const read = await readBoundedResponseBytes(response, { maxBytes: BOUNDED_BODY_MAX_BYTES,
          signal: AbortSignal.any([signal, AbortSignal.timeout(BOUNDED_BODY_TIMEOUT_MS)]) });
        if (read.oversized) throw new RangeError("Encoded refusal exceeds inspection limit");
        const decoded = decodeRequestBody(read.bytes, coding, BOUNDED_BODY_MAX_BYTES);
        const text = new TextDecoder().decode(decoded);
        const safe = mask(text);
        body = safe === text ? read.bytes : safe;
        if (safe !== text) headers.delete("content-encoding");
      } catch {
        signal.throwIfAborted();
        headers.delete("content-encoding"); headers.set("content-type", "text/plain");
        body = "Upstream diagnostic withheld";
      }
    }
  }
  if (response.ok && response.body && isEventStream(response.headers)) {
    const screened = screenStrictSseBody(response.body, response.headers.get("content-encoding")?.trim().toLowerCase() ?? "", mask);
    if (!screened) {
      void response.body.cancel().catch(() => {});
      headers.delete("content-encoding"); headers.set("content-type", "text/plain");
      return new Response("Upstream stream withheld", { status: 502, headers });
    }
    body = screened;
  }
  return new Response(body, { status: response.status, headers });
}

export class MessagesIntegrityError extends Error {
  constructor() { super("Strict Messages transport refused a request transformation or unsupported transport"); }
}

export type NativeMessagesRequest = Omit<AnthropicMessagesPassthroughRequest, "body"> & {
  body: string | Uint8Array<ArrayBuffer>;
};

export class NativeMessagesIntegrity {
  readonly countTokens: boolean;
  readonly #wire: Buffer;
  readonly #headers: Headers;
  readonly #query: string;
  readonly #model: unknown;
  readonly #stream: boolean;

  constructor(req: Request, wire: Uint8Array, parsed: Record<string, unknown>) {
    // The bounded reader hands ownership to this snapshot; only build() exposes a copy.
    this.#wire = Buffer.from(wire.buffer, wire.byteOffset, wire.byteLength);
    this.#headers = messagesEndToEndHeaders(req.headers, true);
    // Authentication is the one application-level substitution this contract permits.
    for (const name of [...this.#headers.keys()]) {
      if (name === "authorization" || name === "x-api-key" || name === "cookie"
        || name.startsWith("x-opencodex-")) this.#headers.delete(name);
    }
    const url = new URL(req.url);
    this.#query = url.search;
    this.countTokens = url.pathname === "/v1/messages/count_tokens" || url.pathname === "/strict/v1/messages/count_tokens";
    this.#model = parsed.model;
    this.#stream = parsed.stream === true;
  }

  urlFor(messagesUrl: string): string {
    const url = new URL(messagesUrl);
    if (url.search || url.hash || url.username || url.password) throw new MessagesIntegrityError();
    if (this.countTokens) url.pathname += "/count_tokens";
    url.search = this.#query;
    return url.href;
  }

  private target(provider: OcxProviderConfig, model: string, body: Record<string, unknown>) {
    if (model !== this.#model || model !== body.model || !provider.apiKey
      || provider.tlsProfile || "fetch" in provider || Object.keys(provider.headers ?? {}).length > 0
      || (provider.authMode === "oauth" && nativeHarnessOnly() && !/^claude-cli\//.test(this.#headers.get("user-agent") ?? ""))) {
      throw new MessagesIntegrityError();
    }
    const headers = Object.fromEntries(this.#headers);
    // The one end-to-end header strict mode narrows: a stream is screened before delivery, so only
    // codings the screen can decode incrementally may be advertised.
    if (this.#stream) {
      const encoding = streamingAcceptEncoding(this.#headers.get("accept-encoding"));
      if (encoding === undefined) delete headers["accept-encoding"]; else headers["accept-encoding"] = encoding;
    }
    if (provider.authMode === "oauth") headers.authorization = `Bearer ${provider.apiKey}`;
    else applyAnthropicKeyAuth(headers, provider);
    return { url: this.urlFor(resolveAnthropicMessagesUrl(provider)), headers };
  }

  build(provider: OcxProviderConfig, model: string, body: Record<string, unknown>): NativeMessagesRequest {
    return {
      ...this.target(provider, model, body), body: new Uint8Array(this.#wire),
      wireBody: body, droppedBetas: false, droppedBetaNames: [], droppedUnrecognizedBetas: 0, strippedOpaqueState: false,
    };
  }

  sendInit(provider: OcxProviderConfig, model: string, body: Record<string, unknown>, assertCurrent: () => void): RequestInit {
    // Build the expectation from the private ingress snapshot and the current selected credential,
    // never from the outbound request that the invariant is supposed to check.
    const expected = this.target(provider, model, body);
    const expectedHeaders = new Headers(expected.headers);
    return {
      decompress: false,
      ...physicalSendIntegrityInit((url, init) => {
        assertCurrent();
        const bytes = typeof init.body === "string" ? Buffer.from(init.body) : init.body;
        const headers = new Headers(init.headers);
        // Only connection freshness may change after the ingress hop headers were removed.
        // Never sanitize the final comparison: a rewriter could nominate a changed field.
        if (headers.get("connection") === "close") headers.delete("connection");
        const proxy = (init as RequestInit & { proxy?: string | false }).proxy;
        if (url !== expected.url || init.method !== "POST" || init.redirect !== "manual"
          || (init as RequestInit & { decompress?: boolean }).decompress !== false
          || !(bytes instanceof Uint8Array) || !this.#wire.equals(bytes)
          || [...headers].length !== [...expectedHeaders].length
          || [...expectedHeaders].some(([key, value]) => headers.get(key) !== value)
          || (typeof proxy === "string" && !/^https?:\/\//i.test(proxy))
          || (proxy === undefined && socks5ProxyFromEnv())) throw new MessagesIntegrityError();
        if (init.signal?.aborted) throw init.signal.reason;
      }),
    } as RequestInit;
  }
}
