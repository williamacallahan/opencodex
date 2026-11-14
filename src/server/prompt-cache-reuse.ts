import { registerRetainedStore, type RetainedStoreSnapshot } from "../lib/app-owned-memory";
import { isCachePositionReachable, type CachePosition, type CacheTtl, type PrefixWalk } from "./prompt-cache-prefix";

export const promptCacheReuseLimits = Object.freeze({ records: 16384, accountsPerPrefix: 8, pendingTickets: 64, pendingBytes: 64 * 1024 * 1024 });
type CoverageReason = "tracking_horizon" | "startup" | "capacity_evicted" | "worker_backlog"
  | "unsupported_shape" | "hash_unavailable" | "unmeasured_anchor" | "prefill_unconfirmed";
export type ReuseReason = CoverageReason | "same_account_anchor" | "account_changed" | "ttl_elapsed"
  | "prefill_overlap" | "no_observed_predecessor" | "prefill_unconfirmed" | "history_unavailable"
  | "lookback_gap" | "breakpoints_removed" | "prefix_changed" | "hidden_account" | "predecessor_pending"
  | "send_unavailable" | "epoch_changed";
export interface ReuseClassification {
  readonly reuse_expectation: "reuse" | "moved" | "expired" | "overlap" | "fill" | "unknown";
  readonly reuse_reason: ReuseReason;
  readonly reuse_scope: "process";
  readonly reuse_epoch: string;
  readonly reuse_coverage: "complete" | "partial";
  readonly reuse_coverage_reason: CoverageReason;
  readonly expected_cached_tokens?: number;
  readonly lost_cached_tokens?: number;
}
export interface SendIdentity {
  readonly sendId: string;
  readonly destination: string;
  /** Stable selected credential/account identity, never a secret or a display ordinal. */
  readonly account: string | null;
  readonly model: string;
  readonly bodyBytes: number;
  /** Optional opaque conversation digest; not needed to discover shared prefixes. */
  readonly conversation?: string;
}
export type SendObservation = Readonly<SendIdentity & {
  epoch: string;
  dispatchedAt: number;
  sequence: number;
  coverage: CoverageReason;
  eviction: number;
  gapSequence: number;
  rejected?: "worker_backlog" | "hidden_account" | "send_unavailable";
}>;
interface Prefill {
  readyAt: number;
  sequence: number;
  read: number;
  write: number;
}
interface PendingSend {
  bytes: number;
  metadataBytes: number;
  prefill?: Prefill;
  prefix?: Extract<PrefixWalk, { status: "supported" }>;
  failure?: "unsupported_shape" | "worker_backlog";
  classification?: ReuseClassification;
}
interface Anchor {
  id: number;
  key: string;
  account: string;
  position: CachePosition;
  ttl: CacheTtl;
  tokens: number;
  dispatchedAt: number;
  dispatchSequence: number;
  readyAt: number;
  readySequence: number;
  storedAt: number;
  conversation?: string;
  bytes: number;
}
const horizon = 3600000;
const tokenCount = (count: unknown): count is number => typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
function prefillUsage(event: unknown, model: string): { read: number; write: number } | undefined {
  if (!event || typeof event !== "object" || !("type" in event) || event.type !== "message_start"
    || !("message" in event) || !event.message || typeof event.message !== "object") return;
  const message = event.message;
  if (!("id" in message) || typeof message.id !== "string" || !message.id
    || !("type" in message) || message.type !== "message" || !("role" in message) || message.role !== "assistant"
    || !("model" in message) || message.model !== model || !("usage" in message)
    || !message.usage || typeof message.usage !== "object") return;
  const usage = message.usage;
  if (!("input_tokens" in usage) || !tokenCount(usage.input_tokens)
    || !("cache_read_input_tokens" in usage) || !tokenCount(usage.cache_read_input_tokens)
    || !("cache_creation_input_tokens" in usage) || !tokenCount(usage.cache_creation_input_tokens)) return;
  const read = usage.cache_read_input_tokens;
  const write = usage.cache_creation_input_tokens;
  return Number.isSafeInteger(read + write) ? { read, write } : undefined;
}

/** Process-local evidence, not provider cache state. One owner per process; close on shutdown.
 * observeSend is metadata-only. confirmPrefill captures readiness before worker hashing;
 * resolvePrefix accepts its eventual result. classify never waits for either operation.
 */
export class PromptCacheReuseLedger {
  readonly epoch = crypto.randomUUID();
  readonly #clock: () => number;
  readonly #pending = new Map<SendObservation, PendingSend>();
  readonly #records = new Map<number, Anchor>();
  readonly #prefixes = new Map<string, Map<string, Set<number>>>();
  readonly #conversations = new Map<string, Set<number>>();
  readonly #unregister: () => void;
  #sequence = 0;
  #recordId = 0;
  #recordBytes = 0;
  #pendingBytes = 0;
  #evictions = 0;
  #completeSince: number;
  #gap: CoverageReason = "startup";
  #gapSequence = 0;
  #closed = false;

  constructor(clock: () => number = () => performance.timeOrigin + performance.now()) {
    this.#clock = clock;
    this.#completeSince = clock();
    this.#unregister = registerRetainedStore({
      id: `prompt-cache-reuse:${this.epoch}`, category: "caches", passiveEvictable: true,
      snapshot: () => this.memorySnapshot(), evictOldest: () => this.#evictOldest(),
    });
  }
  #coverage(at: number): CoverageReason {
    return at - this.#completeSince >= horizon ? "tracking_horizon" : this.#gap;
  }
  #markGap(reason: CoverageReason): void {
    this.#completeSince = this.#clock();
    this.#gap = reason;
    this.#gapSequence++;
  }
  #key(send: SendObservation, position: CachePosition): string {
    return JSON.stringify([send.destination, send.model, position.tier, position.digest]);
  }
  #conversation(send: SendObservation): string | undefined {
    return send.conversation === undefined ? undefined : JSON.stringify([send.destination, send.model, send.conversation]);
  }
  *#anchors(key: string): Iterable<Anchor> {
    for (const versions of this.#prefixes.get(key)?.values() ?? []) {
      for (const id of versions) yield this.#records.get(id)!;
    }
  }
  #remove(anchor: Anchor, capacity: boolean): number {
    this.#records.delete(anchor.id);
    const accounts = this.#prefixes.get(anchor.key)!;
    const versions = accounts.get(anchor.account)!;
    versions.delete(anchor.id);
    if (!versions.size) accounts.delete(anchor.account);
    if (!accounts.size) this.#prefixes.delete(anchor.key);
    if (anchor.conversation !== undefined) {
      const history = this.#conversations.get(anchor.conversation)!;
      history.delete(anchor.id);
      if (!history.size) this.#conversations.delete(anchor.conversation);
    }
    this.#recordBytes -= anchor.bytes;
    if (capacity) {
      this.#evictions++;
      this.#markGap("capacity_evicted");
    }
    return anchor.bytes;
  }
  #evictOldest(): number {
    const oldest = this.#records.values().next().value;
    return oldest ? this.#remove(oldest, true) : 0;
  }
  #prune(): void {
    // Worker results can arrive out of readiness order. Age by insertion time,
    // and retain historical versions while a pending send could still need them.
    // A first send after an idle interval must not sweep the entire retained ledger.
    if (this.#pending.size) return;
    let removed = 0;
    for (const anchor of this.#records.values()) {
      if (removed === 64 || anchor.storedAt + 2 * horizon >= this.#clock()) break;
      this.#remove(anchor, false);
      removed++;
    }
  }
  observeSend(identity: SendIdentity): SendObservation {
    this.#prune();
    const dispatchedAt = this.#clock();
    const valid = [identity.sendId, identity.destination, identity.model, identity.account ?? "", identity.conversation ?? ""]
      .every(label => label.length <= 1024) && tokenCount(identity.bodyBytes);
    const bytes = valid ? identity.bodyBytes + 512 + 2 * (identity.sendId.length + identity.destination.length
      + identity.model.length + (identity.account?.length ?? 0) + (identity.conversation?.length ?? 0)) : 0;
    const rejected = this.#closed || !valid ? "send_unavailable" : !identity.account ? "hidden_account"
      : this.#pending.size >= promptCacheReuseLimits.pendingTickets || this.#pendingBytes + bytes > promptCacheReuseLimits.pendingBytes
        ? "worker_backlog" : undefined;
    if (rejected) this.#markGap(rejected === "worker_backlog" ? rejected : "unsupported_shape");
    const send: SendObservation = Object.freeze({ ...identity, dispatchedAt, epoch: this.epoch,
      sequence: ++this.#sequence, coverage: this.#coverage(dispatchedAt), eviction: this.#evictions, gapSequence: this.#gapSequence,
      ...(rejected ? { rejected } : {}),
    });
    if (!rejected) {
      this.#pending.set(send, { bytes, metadataBytes: bytes - identity.bodyBytes });
      this.#pendingBytes += bytes;
    }
    return send;
  }
  /** Invoke on this physical send's validated event, not response headers or SSE pings. */
  confirmPrefill(send: SendObservation, event: unknown): boolean {
    const pending = this.#pending.get(send);
    if (!pending || pending.prefill) return false;
    const usage = prefillUsage(event, send.model);
    if (!usage) return false;
    pending.prefill = { ...usage, readyAt: this.#clock(), sequence: ++this.#sequence };
    return true;
  }
  #failPrefix(pending: PendingSend, reason: NonNullable<PendingSend["failure"]>): void {
    pending.failure = reason;
    this.#pendingBytes -= pending.bytes - pending.metadataBytes;
    pending.bytes = pending.metadataBytes;
    this.#markGap(reason);
  }
  /** Deliver once, from the resident worker. Body ownership stays outside this ledger. */
  resolvePrefix(send: SendObservation, prefix: PrefixWalk): boolean {
    const pending = this.#pending.get(send);
    if (!pending?.prefill || pending.prefix || pending.failure) return false;
    if (prefix.status === "unsupported") {
      this.#failPrefix(pending, "unsupported_shape");
      return true;
    }
    const bytes = pending.metadataBytes + prefix.positions.length * 192 + prefix.breakpoints.length * 32;
    if (this.#pendingBytes - pending.bytes + bytes > promptCacheReuseLimits.pendingBytes) {
      this.#failPrefix(pending, "worker_backlog");
      return false;
    }
    this.#pendingBytes += bytes - pending.bytes;
    pending.bytes = bytes;
    pending.prefix = {
      status: "supported", positions: prefix.positions.map(position => Object.freeze({ ...position })),
      breakpoints: prefix.breakpoints.map(point => Object.freeze({ ...point })),
    };
    // A send's own write may evict history. Preserve its resolved expectation first;
    // unknown observations may still improve when an earlier worker result arrives.
    const classification = this.classify(send);
    if (classification.reuse_expectation !== "unknown" || classification.reuse_reason === "history_unavailable") {
      pending.classification = classification;
    }
    this.#commit(send, pending.prefix, pending.prefill);
    return true;
  }
  #insert(send: SendObservation, prefill: Prefill, position: CachePosition, ttl: CacheTtl, tokens: number): void {
    if (!send.account) return;
    const key = this.#key(send, position);
    const accounts = this.#prefixes.get(key);
    if (accounts && !accounts.has(send.account) && accounts.size >= promptCacheReuseLimits.accountsPerPrefix) {
      const oldestVersions = accounts.values().next().value!;
      for (const id of oldestVersions) this.#remove(this.#records.get(id)!, true);
    }
    while (this.#records.size >= promptCacheReuseLimits.records) this.#evictOldest();
    const conversation = this.#conversation(send);
    const bytes = 384 + 2 * (key.length + send.account.length + (conversation?.length ?? 0));
    const anchor: Anchor = { id: ++this.#recordId, key, account: send.account, position, ttl, tokens,
      dispatchedAt: send.dispatchedAt, dispatchSequence: send.sequence, readyAt: prefill.readyAt,
      readySequence: prefill.sequence, storedAt: this.#clock(), bytes, ...(conversation === undefined ? {} : { conversation }),
    };
    this.#records.set(anchor.id, anchor);
    const prefixes = this.#prefixes.get(key) ?? new Map<string, Set<number>>();
    const versions = prefixes.get(send.account) ?? new Set<number>();
    versions.add(anchor.id);
    prefixes.set(send.account, versions);
    this.#prefixes.set(key, prefixes);
    if (conversation !== undefined) {
      const history = this.#conversations.get(conversation) ?? new Set<number>();
      history.add(anchor.id);
      this.#conversations.set(conversation, history);
    }
    this.#recordBytes += bytes;
  }
  #commit(send: SendObservation, prefix: Extract<PrefixWalk, { status: "supported" }>, prefill: Prefill): void {
    // Aggregate writes anchor the final breakpoint only in the single-breakpoint,
    // supported-shape case. Multiple/mixed markers never manufacture per-point counts.
    if (prefill.write > 0 && prefix.breakpoints.length === 1) {
      const point = prefix.breakpoints[0]!;
      const position = prefix.positions[point.index];
      if (position) this.#insert(send, prefill, position, point.ttl, prefill.read + prefill.write);
    } else if (prefill.write > 0) this.#markGap("unmeasured_anchor");
    if (!prefill.read) return;
    const matches = new Map<string, Anchor>();
    for (const position of prefix.positions) {
      if (!isCachePositionReachable(position.index, prefix.breakpoints)) continue;
      for (const anchor of this.#anchors(this.#key(send, position))) {
        if (anchor.account === send.account && anchor.tokens === prefill.read && anchor.readySequence < send.sequence) {
          const previous = matches.get(anchor.key);
          if (!previous || previous.dispatchSequence < anchor.dispatchSequence) matches.set(anchor.key, anchor);
        }
      }
    }
    if (matches.size !== 1) {
      this.#markGap("unmeasured_anchor");
      return;
    }
    const anchor = matches.values().next().value!;
    const checkpoint = prefix.breakpoints.find(point => point.index === anchor.position.index);
    const candidates = checkpoint ? [checkpoint] : prefix.breakpoints.filter(point => isCachePositionReachable(anchor.position.index, [point]));
    if (candidates.some(point => point.ttl !== anchor.ttl)) {
      this.#markGap("unmeasured_anchor");
      return;
    }
    this.#insert(send, prefill, anchor.position, anchor.ttl, anchor.tokens);
  }
  #result(send: SendObservation, expectation: ReuseClassification["reuse_expectation"], reason: ReuseReason, expected?: number): ReuseClassification {
    const read = this.#pending.get(send)?.prefill?.read;
    const coverage = send.epoch !== this.epoch ? "startup" : send.gapSequence === this.#gapSequence ? send.coverage : this.#gap;
    return { reuse_expectation: expectation, reuse_reason: reason, reuse_scope: "process", reuse_epoch: this.epoch,
      reuse_coverage: coverage === "tracking_horizon" ? "complete" : "partial", reuse_coverage_reason: coverage,
      ...(expected !== undefined && read !== undefined ? { expected_cached_tokens: expected, lost_cached_tokens: Math.max(0, expected - read) } : {}),
    };
  }
  classify(send: SendObservation): ReuseClassification {
    if (send.epoch !== this.epoch) return this.#result(send, "unknown", "epoch_changed");
    if (send.rejected) return this.#result(send, "unknown", send.rejected);
    const pending = this.#pending.get(send);
    if (!pending) return this.#result(send, "unknown", "send_unavailable");
    if (pending.classification) return pending.classification;
    if (!pending.prefill) return this.#result(send, "unknown", "prefill_unconfirmed");
    if (pending.failure) return this.#result(send, "unknown", pending.failure);
    if (!pending.prefix) return this.#result(send, "unknown", "hash_unavailable");
    if (send.eviction !== this.#evictions) return this.#result(send, "unknown", "history_unavailable");
    let warm: Anchor | undefined;
    let moved = false;
    let expired = false;
    let overlap = false;
    let unreachable = false;
    for (const position of pending.prefix.positions) {
      const reachable = isCachePositionReachable(position.index, pending.prefix.breakpoints);
      for (const anchor of this.#anchors(this.#key(send, position))) {
        if (anchor.dispatchSequence >= send.sequence) continue;
        const ready = anchor.readySequence < send.sequence && anchor.readyAt <= send.dispatchedAt;
        const alive = send.dispatchedAt < anchor.dispatchedAt + anchor.ttl;
        if (!reachable) { if (ready && alive && anchor.account === send.account) unreachable = true; continue; }
        if (ready && alive) {
          if (anchor.account !== send.account) moved = true;
          else if (!warm || anchor.tokens > warm.tokens) warm = anchor;
        } else if (anchor.account === send.account) {
          if (!ready) overlap = true;
          else expired = true;
        }
      }
    }
    if (warm) return this.#result(send, "reuse", "same_account_anchor", warm.tokens);
    if (moved) return this.#result(send, "moved", "account_changed");
    if (overlap) return this.#result(send, "overlap", "prefill_overlap");
    if (expired) return this.#result(send, "expired", "ttl_elapsed");
    if (unreachable) return this.#result(send, "unknown", pending.prefix.breakpoints.length ? "lookback_gap" : "breakpoints_removed");
    const conversation = this.#conversation(send);
    if (conversation !== undefined) {
      for (const id of this.#conversations.get(conversation) ?? []) {
        const anchor = this.#records.get(id)!;
        if (anchor.readySequence < send.sequence && anchor.dispatchSequence < send.sequence
          && pending.prefix.positions[anchor.position.index]?.digest !== anchor.position.digest) return this.#result(send, "unknown", "prefix_changed");
      }
    }
    for (const [other, observation] of this.#pending) {
      if (other.sequence < send.sequence && other.destination === send.destination && other.model === send.model
        && !observation.prefix && !observation.failure) return this.#result(send, "unknown", "predecessor_pending");
    }
    if (send.gapSequence !== this.#gapSequence) return this.#result(send, "unknown", this.#gap);
    return send.coverage === "tracking_horizon" ? this.#result(send, "fill", "tracking_horizon")
      : this.#result(send, "unknown", send.coverage === "startup" ? "no_observed_predecessor" : send.coverage);
  }
  releaseSend(send: SendObservation): void {
    const pending = this.#pending.get(send);
    if (!pending) return;
    if (!pending.prefill) this.#markGap("prefill_unconfirmed");
    else if (!pending.prefix && !pending.failure) this.#markGap("hash_unavailable");
    this.#pendingBytes -= pending.bytes;
    this.#pending.delete(send);
  }
  memorySnapshot(): RetainedStoreSnapshot {
    return { count: this.#records.size + this.#pending.size, bytes: this.#recordBytes + this.#pendingBytes,
      evictableBytes: this.#recordBytes, pinnedBytes: this.#pendingBytes,
      oldestAt: this.#records.values().next().value?.storedAt ?? null,
    };
  }
  coverage() {
    const reason = this.#coverage(this.#clock());
    return { epoch: this.epoch, scope: "process" as const, reason, complete: reason === "tracking_horizon",
      records: this.#records.size, pendingTickets: this.#pending.size, pendingBytes: this.#pendingBytes, evictions: this.#evictions };
  }
  close(): void {
    this.#closed = true;
    this.#unregister();
    this.#pending.clear();
    this.#records.clear();
    this.#prefixes.clear();
    this.#conversations.clear();
    this.#recordBytes = this.#pendingBytes = 0;
  }
}
