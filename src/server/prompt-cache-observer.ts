import { createHash } from "node:crypto";
import { isRec } from "../claude/inbound-records";
import { didRunOptionalShutdownHooks, registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { spawnWorker } from "../lib/worker-embed";
import { hasUpstreamRewriters } from "../plugins/upstream-hooks";
import type { NativeMessagesRequest } from "./messages-native-integrity";
import { credentialDomainFor } from "../protocols/opaque-state";
import { classifyCredential } from "../routing/identity-domains";
import type { OcxProviderConfig, OcxUsage } from "../types";
import { anthropicUsageToOcx } from "./messages-shared";
import type { NativeOAuthBinding } from "./messages-native-oauth";
import type { PromptCacheOutcomeInput } from "./prompt-cache-outcome";
import type { PrefixWalk } from "./prompt-cache-prefix";
import { PromptCacheReuseLedger, type ReuseClassification, type SendObservation } from "./prompt-cache-reuse";
import type { RequestLogContext } from "./request-log";

export interface PrefixWorkerRequest { id: number; bytes: Uint8Array; encoding: string | null }
export type PrefixWorkerReply = { id: number; prefix: PrefixWalk } | { id: number; failed: true };
type ObservationReason = "unsupported_transport" | "count_tokens" | "local_answer" | "combo_parent"
  | "hidden_account" | "worker_failed" | "request_failed" | "model_mismatch" | "send_unavailable";
export type NativeCacheReuse = Omit<ReuseClassification, "reuse_reason"> & {
  reuse_reason: ReuseClassification["reuse_reason"] | ObservationReason;
};
interface NativeSendOptions {
  wire: NativeMessagesRequest;
  strict: boolean;
  bodyBytes: number;
  provider: OcxProviderConfig;
  account?: NativeOAuthBinding["snapshot"];
  countTokens?: boolean;
  sessionKey?: string | null;
}
interface ObservedSend {
  id: number;
  provider: string;
  model: string;
  ticket?: SendObservation;
  body?: string | Uint8Array;
  encoding?: string | null;
  usage?: OcxUsage;
  failure?: ObservationReason;
  postedAt?: number;
  finished?: true;
  outcome?: NativeCacheReuse;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

class NativeCacheObserver {
  readonly ledger = new PromptCacheReuseLedger();
  readonly bindings = new WeakMap<RequestLogContext, ObservedSend>();
  readonly pending = new Map<number, ObservedSend>();
  readonly detachShutdown = registerOptionalShutdownHook("prompt-cache-observations", () => stopNativePromptCacheObservations());
  worker?: Worker;
  deadline?: ReturnType<typeof setTimeout>;
  workerFailed = false;
  nextId = 0;

  unknown(reason: ObservationReason | ReuseClassification["reuse_reason"]): NativeCacheReuse {
    return { reuse_expectation: "unknown", reuse_reason: reason, reuse_scope: "process", reuse_epoch: this.ledger.epoch,
      reuse_coverage: "partial", reuse_coverage_reason: "unsupported_shape" };
  }
  release(send: ObservedSend): void {
    if (send.ticket) this.ledger.releaseSend(send.ticket);
    this.pending.delete(send.id);
    send.body = undefined;
  }
  capture(logCtx: RequestLogContext, options: NativeSendOptions): void {
    const previous = this.bindings.get(logCtx);
    if (previous) this.release(previous);
    const send: ObservedSend = { id: ++this.nextId, provider: logCtx.provider, model: logCtx.model };
    this.bindings.set(logCtx, send);
    const url = new URL(options.wire.url);
    const body = options.wire.body;
    if (options.countTokens || url.pathname.endsWith("/count_tokens")) { send.failure = "count_tokens"; return; }
    if (logCtx.localTerminalReason !== undefined) { send.failure = "local_answer"; return; }
    if (didRunOptionalShutdownHooks() || !credentialDomainFor({ ...options.provider, baseUrl: url.href })?.firstPartyAnthropic
      || (!options.strict && hasUpstreamRewriters()) || "fetch" in options.provider) {
      send.failure = "unsupported_transport";
      return;
    }
    if (this.workerFailed) { send.failure = "worker_failed"; return; }
    const headers = new Headers(options.wire.headers);
    const credential = options.account
      ? `oauth:${options.account.provider}:${options.account.accountId}`
      : options.provider.apiKey ? `key:${digest(options.provider.apiKey)}` : null;
    const cacheDomain = classifyCredential({ provider: "anthropic", credentialId: credential ?? "" }).cacheDomain;
    const conversation = options.sessionKey ?? logCtx.conversationId;
    const ticket = this.ledger.observeSend({ sendId: `${this.ledger.epoch}:${send.id}`, account: credential, cacheDomain,
      destination: JSON.stringify([url.origin + url.pathname + url.search, headers.get("anthropic-version"), headers.get("anthropic-beta")]),
      model: send.model, bodyBytes: options.bodyBytes,
      ...(conversation && conversation.length <= 1024 ? { conversation: digest(conversation) } : {}),
    });
    send.ticket = ticket;
    if (ticket.rejected) return;
    send.body = body;
    send.encoding = headers.get("content-encoding");
    this.pending.set(send.id, send);
  }
  confirm(logCtx: RequestLogContext, message: unknown): void {
    const send = this.bindings.get(logCtx);
    if (!send?.ticket || send.failure || send.usage || send.body === undefined) return;
    if (isRec(message) && typeof message.model === "string" && message.model !== send.model) {
      send.failure = "model_mismatch";
      this.release(send);
      return;
    }
    if (!this.ledger.confirmPrefill(send.ticket, { type: "message_start", message })) return;
    if (!isRec(message) || !isRec(message.usage)) return;
    send.usage = anthropicUsageToOcx(message.usage);
    try {
      if (!this.worker) {
        const worker = spawnWorker(new URL("./prompt-cache-observation-worker.ts", import.meta.url).href, "prompt-cache-observation-worker");
        this.worker = worker;
        worker.onmessage = (event: MessageEvent<PrefixWorkerReply>) => this.accept(event.data);
        worker.onerror = () => this.failWorker();
      }
      // Copy only after valid prefill. Transfer this observation's copy, never transport ownership.
      const bytes = typeof send.body === "string" ? new TextEncoder().encode(send.body) : new Uint8Array(send.body);
      send.body = undefined;
      send.postedAt = performance.now();
      this.worker.postMessage({ id: send.id, bytes, encoding: send.encoding ?? null } satisfies PrefixWorkerRequest, [bytes.buffer]);
      this.armDeadline();
    } catch {
      this.failWorker();
    }
  }
  accept(reply: PrefixWorkerReply): void {
    const send = this.pending.get(reply.id);
    if (!send?.ticket) return;
    send.postedAt = undefined;
    if ("failed" in reply) {
      this.failWorker();
      return;
    }
    this.ledger.resolvePrefix(send.ticket, reply.prefix);
    if (send.finished) this.release(send);
    this.armDeadline();
  }
  armDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    let oldest = Infinity;
    for (const send of this.pending.values()) if (send.postedAt !== undefined) oldest = Math.min(oldest, send.postedAt);
    this.deadline = Number.isFinite(oldest)
      ? setTimeout(() => this.failWorker(), Math.max(0, oldest + 10000 - performance.now())) : undefined;
    this.deadline?.unref();
  }
  failWorker(): void {
    if (this.workerFailed) return;
    this.workerFailed = true;
    if (this.deadline) clearTimeout(this.deadline);
    this.worker?.terminate();
    this.worker = undefined;
    for (const send of this.pending.values()) {
      send.failure = "worker_failed";
      this.release(send);
    }
    console.warn("[prompt-cache] observation worker unavailable; cache reuse coverage is unknown");
  }
  finish(logCtx: RequestLogContext | undefined, input: PromptCacheOutcomeInput): { reuse: NativeCacheReuse; physical?: Pick<PromptCacheOutcomeInput, "provider" | "servedModel" | "usage" | "usageStatus" | "wireParsed" | "nativeCacheWire"> } {
    const send = logCtx && this.bindings.get(logCtx);
    const excluded = input.comboParent ? "combo_parent" : input.locallyAnswered ? "local_answer" : !input.succeeded ? "request_failed" : undefined;
    const reuse = excluded ? this.unknown(excluded) : send?.outcome ?? (send?.failure ? this.unknown(send.failure)
      : send?.ticket ? this.ledger.classify(send.ticket) : this.unknown(logCtx?.cacheRelayProvider ? "hidden_account" : "unsupported_transport"));
    if (send) {
      send.outcome = reuse;
      send.finished = true;
      // A short response may end before hashing. Emit unknown now, but let the confirmed
      // prefill finish warming the ledger for later sends without delaying this response.
      if (send.postedAt === undefined) this.release(send);
    }
    return { reuse, ...(send?.usage && !excluded ? { physical: { provider: send.provider, servedModel: send.model,
      usage: send.usage, usageStatus: "reported", wireParsed: true, nativeCacheWire: true } } : {}) };
  }
  close(): void {
    this.detachShutdown();
    if (this.deadline) clearTimeout(this.deadline);
    this.worker?.terminate();
    this.worker = undefined;
    for (const send of this.pending.values()) this.release(send);
    this.ledger.close();
  }
}
let observer: NativeCacheObserver | undefined;
const observations = () => observer ??= new NativeCacheObserver();

/** Strict commit runs after final integrity checks; mutable plugin paths remain explicitly unknown. */
export function observeNativePromptCacheSend(logCtx: RequestLogContext, options: NativeSendOptions): void {
  observations().capture(logCtx, options);
}
export function confirmNativePromptCachePrefill(logCtx: RequestLogContext, message: unknown): void {
  observer?.confirm(logCtx, message);
}
export function nativePromptCacheOutcome(logCtx: RequestLogContext | undefined, input: PromptCacheOutcomeInput) {
  return observations().finish(logCtx, input);
}
export function stopNativePromptCacheObservations(): void {
  observer?.close();
  observer = undefined;
}
