import { createHash } from "node:crypto";
import { isRec } from "../claude/inbound-records";
import { didRunOptionalShutdownHooks, registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import { spawnWorker } from "../lib/worker-embed";
import { hasUpstreamRewriters } from "../plugins/upstream-hooks";
import { isCredentialName } from "../lib/outbound-credential-registry";
import { sseFieldValue } from "../lib/sse-decoder";
import { createTranslatorBudget } from "../lib/translator-budget";
import { createSseBlockBuffer, sseDataPayload } from "./sse-payload-rewrite";
import type { NativeMessagesFinishLog } from "./messages-native";
import type { NativeMessagesRequest } from "./messages-native-integrity";
import { credentialDomainFor } from "../protocols/opaque-state";
import { classifyCredential } from "../routing/identity-domains";
import type { OcxProviderConfig, OcxUsage } from "../types";
import { anthropicUsageToOcx, type PassthroughBodyGuard } from "./messages-shared";
import type { NativeOAuthBinding } from "./messages-native-oauth";
import type { PromptCacheOutcomeInput } from "./prompt-cache-outcome";
import type { PrefixWalk } from "./prompt-cache-prefix";
import { PromptCacheReuseLedger, type ReuseClassification, type SendObservation } from "./prompt-cache-reuse";
import type { RequestLogContext } from "./request-log";

export interface PrefixWorkerRequest { id: number; chunks: Uint8Array[]; encoding: string | null }
export type PrefixWorkerReply = { id: number; prefix: PrefixWalk } | { id: number; failed: true };
type ObservationReason = "unsupported_transport" | "count_tokens" | "local_answer" | "combo_parent" | "combo_child"
  | "hidden_account" | "worker_failed" | "request_failed" | "model_mismatch" | "send_unavailable" | "credential_override" | "prefill_unavailable" | "usage_unavailable";
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
  comboChild?: boolean;
  sessionKey?: string | null;
}
interface ObservedSend {
  id: number;
  provider: string;
  model: string;
  ticket?: SendObservation;
  body?: string | Uint8Array;
  wireBytes?: number;
  encoding?: string | null;
  usage?: OcxUsage;
  finalUsage?: OcxUsage | null;
  rawStreamObserved?: true;
  failure?: ObservationReason;
  postedAt?: number;
  finished?: true;
  outcome?: NativeCacheReuse;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

const handoffLimits = { binaryChunkBytes: 262144, stringChunkUnits: 32768, chunkOverheadBytes: 256 };

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
    if (options.comboChild) { send.failure = "combo_child"; return; }
    const url = new URL(options.wire.url);
    const body = options.wire.body;
    if (options.countTokens || url.pathname.endsWith("/count_tokens")) { send.failure = "count_tokens"; return; }
    if (logCtx.localTerminalReason !== undefined) { send.failure = "local_answer"; return; }
    if (didRunOptionalShutdownHooks() || !credentialDomainFor({ ...options.provider, baseUrl: url.href })?.firstPartyAnthropic
      || (!options.strict && hasUpstreamRewriters()) || "fetch" in options.provider) {
      send.failure = "unsupported_transport";
      return;
    }
    if (Object.keys(options.provider.headers ?? {}).some(isCredentialName)) { send.failure = "credential_override"; return; }
    if (this.workerFailed) { send.failure = "worker_failed"; return; }
    const headers = new Headers(options.wire.headers);
    const credential = options.account
      ? `oauth:${options.account.provider}:${options.account.accountId}:${options.account.generation}`
      : options.provider.apiKey ? `key:${digest(options.provider.apiKey)}` : null;
    const cacheDomain = classifyCredential({ provider: "anthropic", credentialId: credential ?? "" }).cacheDomain;
    const conversation = options.sessionKey ?? logCtx.conversationId;
    const sourceBytes = typeof body === "string" ? body.length * 2 : body.byteLength;
    const chunkCount = Math.ceil(typeof body === "string" ? body.length / (handoffLimits.stringChunkUnits - 1) : body.byteLength / handoffLimits.binaryChunkBytes);
    // Reserve the retained source, transferred chunks, worker concatenation, and bounded copy scratch.
    const reservation = sourceBytes + options.bodyBytes * 2 + handoffLimits.binaryChunkBytes + chunkCount * handoffLimits.chunkOverheadBytes;
    const ticket = this.ledger.observeSend({ sendId: `${this.ledger.epoch}:${send.id}`, account: credential, cacheDomain,
      destination: JSON.stringify([url.origin + url.pathname + url.search, headers.get("anthropic-version"), headers.get("anthropic-beta")]),
      model: send.model, bodyBytes: reservation,
      ...(conversation && conversation.length <= 1024 ? { conversation: digest(conversation) } : {}),
    });
    send.ticket = ticket;
    if (ticket.rejected) return;
    send.body = body;
    send.wireBytes = options.bodyBytes;
    send.encoding = headers.get("content-encoding");
    this.pending.set(send.id, send);
  }
  confirm(send: ObservedSend | undefined, message: unknown): void {
    if (!send?.ticket || send.failure || send.usage || send.body === undefined) return;
    if (isRec(message) && typeof message.model === "string" && message.model !== send.model) {
      send.failure = "model_mismatch";
      this.release(send);
      return;
    }
    if (!this.ledger.confirmPrefill(send.ticket, { type: "message_start", message })) return;
    if (!isRec(message) || !isRec(message.usage)) return;
    send.usage = anthropicUsageToOcx(message.usage);
    send.postedAt = performance.now();
    this.armDeadline();
    this.handoff(send).catch(() => this.failWorker());
  }
  async handoff(send: ObservedSend): Promise<void> {
    // Yield before allocation or worker startup; a resolved Promise would not yield to I/O.
    await Bun.sleep(0);
    if (!this.pending.has(send.id) || send.body === undefined) return;
    const body = send.body;
    const chunks: Uint8Array[] = [];
    const encoder = new TextEncoder();
    let copied = 0;
    for (let offset = 0; offset < body.length;) {
      let chunk: Uint8Array;
      if (typeof body === "string") {
        let end = Math.min(offset + handoffLimits.stringChunkUnits, body.length);
        const last = body.charCodeAt(end - 1);
        if (end < body.length && last >= 0xd800 && last <= 0xdbff) end--;
        chunk = encoder.encode(body.slice(offset, end));
        offset = end;
      } else {
        chunk = new Uint8Array(body.subarray(offset, offset + handoffLimits.binaryChunkBytes));
        offset += chunk.byteLength;
      }
      chunks.push(chunk);
      copied += chunk.byteLength;
      await Bun.sleep(0);
      if (!this.pending.has(send.id)) return;
    }
    if (copied !== send.wireBytes) throw new Error("observation_bytes_changed");
    send.body = undefined;
    if (!this.worker) {
      const worker = spawnWorker(new URL("./prompt-cache-observation-worker.ts", import.meta.url).href, "prompt-cache-observation-worker");
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<PrefixWorkerReply>) => this.accept(event.data);
      worker.onerror = () => this.failWorker();
    }
    this.worker.postMessage({ id: send.id, chunks, encoding: send.encoding ?? null } satisfies PrefixWorkerRequest,
      chunks.map(chunk => chunk.buffer));
  }
  // The log tap sees client-facing rewrites. This bounded raw prefill observation cannot
  // use that transformed model identity, and its budget must not consume the relay's budget.
  rawResponse(source: ReadableStream<Uint8Array>, logCtx: RequestLogContext): ReadableStream<Uint8Array> {
    const send = this.bindings.get(logCtx);
    if (!send?.ticket || send.ticket.rejected || send.failure) return source;
    send.rawStreamObserved = true;
    const budget = createTranslatorBudget();
    const decoder = new TextDecoder();
    const frames = createSseBlockBuffer(budget, bytes => {
      if (bytes > 65536) throw new Error("prefill_observation_limit");
    });
    let remaining = 65536;
    let scanning = true;
    const stop = () => { if (!scanning) return; scanning = false; frames.clear(); budget.dispose(); };
    const inspect = (chunk: Uint8Array) => {
      const length = Math.min(remaining, chunk.byteLength);
      remaining -= length;
      frames.append(decoder.decode(chunk.subarray(0, length), { stream: true }));
      let frame;
      while ((frame = frames.next()) !== null) {
        const event = frame.block.split(/\r\n?|\n/).map(line => sseFieldValue(line, "event")).findLast(name => name !== null);
        if (event !== undefined && event !== "message_start") continue;
        const text = sseDataPayload(frame.block);
        if (!text) continue;
        let payload: unknown;
        try { payload = JSON.parse(text); } catch { continue; }
        if (isRec(payload) && payload.type === "message_start") this.confirm(send, payload.message);
        if (send.usage || send.failure) { stop(); return; }
      }
      frames.compact();
      if (remaining === 0) throw new Error("prefill_observation_limit");
    };
    const reader = source.getReader();
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try { next = await reader.read(); }
        catch (error) { stop(); reader.releaseLock(); throw error; }
        if (next.done) { stop(); reader.releaseLock(); controller.close(); return; }
        controller.enqueue(next.value);
        if (!scanning) return;
        try { inspect(next.value); }
        catch {
          send.failure = "prefill_unavailable";
          this.release(send);
          stop();
        }
      },
      cancel: async reason => {
        stop();
        try { await reader.cancel(reason); } finally { reader.releaseLock(); }
      },
    });
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
    const usage = send?.finalUsage === undefined ? send?.usage : send.finalUsage ?? undefined;
    let reuse = excluded ? this.unknown(excluded) : send?.outcome ?? (send?.failure ? this.unknown(send.failure)
      : send?.ticket ? this.ledger.classify(send.ticket) : this.unknown(logCtx?.nativeCacheProvider !== undefined && logCtx.nativeCacheProvider === logCtx.sentProvider ? "hidden_account" : "unsupported_transport"));
    if (reuse.expected_cached_tokens !== undefined) {
      const cached = usage?.cacheReadInputTokens ?? usage?.cachedInputTokens;
      reuse = typeof cached === "number" && Number.isSafeInteger(cached) && cached >= 0
        ? { ...reuse, lost_cached_tokens: Math.max(0, reuse.expected_cached_tokens - cached) }
        : this.unknown("usage_unavailable");
    }
    if (send) send.outcome = reuse;
    return { reuse, ...(send && (send.usage || send.finalUsage !== undefined) && !excluded ? { physical: { provider: send.provider, servedModel: send.model,
      usage, usageStatus: usage ? "reported" : "unreported", wireParsed: true, nativeCacheWire: true } } : {}) };
  }
  complete(logCtx: RequestLogContext): void {
    const send = this.bindings.get(logCtx);
    if (!send) return;
    send.finished = true;
    // Only an already-confirmed hashing job may outlive the native send's finish.
    if (send.postedAt === undefined) this.release(send);
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
export function observeNativePromptCacheFinish(logCtx: RequestLogContext, finish: NativeMessagesFinishLog): NativeMessagesFinishLog {
  return (status, message, meta) => {
    try { finish(status, message, meta); }
    finally { observer?.complete(logCtx); }
  };
}
export function confirmNativePromptCachePrefill(logCtx: RequestLogContext, message: unknown): void {
  const send = observer?.bindings.get(logCtx);
  if (!send?.rawStreamObserved) observer?.confirm(send, message);
}
export function nativePromptCacheObservation(logCtx: RequestLogContext): PassthroughBodyGuard["onPrefill"] {
  const owner = observer;
  const send = owner?.bindings.get(logCtx);
  if (!owner || !send?.ticket || send.ticket.rejected) return undefined;
  return Object.assign((message: unknown) => {
    if (!send.rawStreamObserved) owner.confirm(send, message);
  }, { usage: (usage: OcxUsage | undefined) => { send.finalUsage = usage ? { ...usage } : null; } });
}
export function observeNativePromptCacheResponse(source: ReadableStream<Uint8Array>, logCtx: RequestLogContext): ReadableStream<Uint8Array> {
  return observer?.rawResponse(source, logCtx) ?? source;
}
export function nativePromptCacheOutcome(logCtx: RequestLogContext | undefined, input: PromptCacheOutcomeInput) {
  return observations().finish(logCtx, input);
}
export function stopNativePromptCacheObservations(): void {
  observer?.close();
  observer = undefined;
}
