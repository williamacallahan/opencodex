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
