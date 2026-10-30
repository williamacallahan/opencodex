/** Strict Messages keeps wire bytes private; parsed JSON is only routing/observation data. */
import { applyAnthropicKeyAuth, resolveAnthropicMessagesUrl } from "../adapters/anthropic";
import type { AnthropicMessagesPassthroughRequest } from "../adapters/anthropic/passthrough";
import { socks5ProxyFromEnv } from "../lib/proxy-env";
import type { OcxProviderConfig } from "../types";
import { physicalSendIntegrityInit } from "./responses/fetch-helpers";

const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/** Transport framing is owned by Fetch; everything else is retained, including future fields. */
export function messagesEndToEndHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of source.get("connection")?.split(",") ?? []) headers.delete(name.trim());
  for (const name of HOP_HEADERS) headers.delete(name);
  headers.delete("host");
  headers.delete("content-length");
  return headers;
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
    this.#headers = messagesEndToEndHeaders(req.headers);
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
      || provider.tlsProfile || "fetch" in provider || Object.keys(provider.headers ?? {}).length > 0) {
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
