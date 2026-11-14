import { afterEach, describe, expect, test } from "bun:test";
import { appOwnedBytesSnapshot, configureAppOwnedMemoryBudget, enforceAppOwnedMemoryBudget, DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES } from "../../src/lib/app-owned-memory";
import { walkPromptCachePrefix, type PrefixWalk } from "../../src/server/prompt-cache-prefix";
import { PromptCacheReuseLedger, promptCacheReuseLimits, type SendIdentity, type SendObservation } from "../../src/server/prompt-cache-reuse";

const ledgers: PromptCacheReuseLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  configureAppOwnedMemoryBudget(DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES);
});
function fixture() {
  let at = 0;
  let serial = 0;
  const ledger = new PromptCacheReuseLedger(() => at);
  ledgers.push(ledger);
  const send = (identity: Partial<SendIdentity> = {}) => ledger.observeSend({
    sendId: `physical-${++serial}`, destination: "direct", model: "test-model", account: "seat-a", bodyBytes: 200, ...identity,
  });
  const ready = (ticket: SendObservation, prefix = prompt(), read = 0, write = 1000) => {
    expect(ledger.confirmPrefill(ticket, event(read, write))).toBe(true);
    expect(ledger.resolvePrefix(ticket, prefix)).toBe(true);
  };
  const fill = (prefix = prompt(), identity: Partial<SendIdentity> = {}) => {
    const ticket = send(identity);
    ready(ticket, prefix);
    ledger.releaseSend(ticket);
    return ticket;
  };
  return { ledger, send, ready, fill, time: (now: number) => { at = now; } };
}
function event(read: number, write: number) {
  return { type: "message_start", message: { id: "message-id", type: "message", role: "assistant", model: "test-model",
    usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: write } } };
}
function prompt(label = "shared", distance = 0, ttl: "5m" | "1h" = "5m"): PrefixWalk {
  const content = Array.from({ length: distance + 1 }, (_, index) => ({ type: "text", text: index ? `tail-${index}` : label }));
  return walkPromptCachePrefix(Buffer.from(JSON.stringify({ model: "test-model", messages: [{ role: "user", content }], cache_control: { type: "ephemeral", ttl } })));
}
function outcome(ledger: PromptCacheReuseLedger, send: SendObservation, expectation: string, reason: string) {
  const result = ledger.classify(send);
  expect(result.reuse_expectation).toBe(expectation);
  expect(result.reuse_reason).toBe(reason);
  if (expectation !== "reuse") {
    expect(result).not.toHaveProperty("expected_cached_tokens");
    expect(result).not.toHaveProperty("lost_cached_tokens");
  }
  return result;
}

describe("prompt cache reuse evidence", () => {
  test("startup is unknown; one uninterrupted local maximum-TTL horizon permits a local fill", () => {
    const { ledger, send, ready, time } = fixture();
    const first = send();
    ready(first);
    expect(outcome(ledger, first, "unknown", "no_observed_predecessor").reuse_coverage).toBe("partial");
    ledger.releaseSend(first);
    time(3600000);
    const cold = send();
    ready(cold, prompt("different"));
    const result = outcome(ledger, cold, "fill", "tracking_horizon");
    expect(result.reuse_scope).toBe("process");
    expect(result.reuse_coverage).toBe("complete");
  });

  test("confirmed prefill is readable before generation finishes and clips loss per physical send", () => {
    const { ledger, send, ready, time } = fixture();
    const writing = send();
    time(10);
    ready(writing);
    const reading = send();
    time(20);
    ready(reading, prompt(), 400, 600);
    expect(outcome(ledger, reading, "reuse", "same_account_anchor")).toMatchObject({ expected_cached_tokens: 1000, lost_cached_tokens: 600 });
    const another = send();
    ready(another, prompt(), 1200, 0);
    expect(outcome(ledger, another, "reuse", "same_account_anchor").lost_cached_tokens).toBe(0);
    expect(ledger.coverage().pendingTickets).toBe(3);
  });

  test("dispatch order, not equal clock timestamps or completion order, separates overlap", () => {
    const { ledger, send, ready } = fixture();
    const writing = send();
    const overlap = send();
    ready(writing);
    ready(overlap);
    outcome(ledger, overlap, "overlap", "prefill_overlap");
    const later = send();
    ready(later, prompt(), 1000, 0);
    outcome(ledger, later, "reuse", "same_account_anchor");
  });

  test.each([300000, 3600000])("expiry is exact at %i ms from dispatch, not readiness", ttl => {
    const { ledger, send, ready, time } = fixture();
    const prefix = prompt("shared", 0, ttl === 300000 ? "5m" : "1h");
    const writing = send();
    time(10000);
    ready(writing, prefix);
    ledger.releaseSend(writing);
    time(ttl - 1);
    const warm = send();
    ready(warm, prefix, 0, 0);
    outcome(ledger, warm, "reuse", "same_account_anchor");
    ledger.releaseSend(warm);
    time(ttl);
    const expired = send();
    ready(expired, prefix, 0, 0);
    outcome(ledger, expired, "expired", "ttl_elapsed");
  });

  test("only a confirmed read refreshes a measured anchor, using the reading send's start", () => {
    const { ledger, send, fill, ready, time } = fixture();
    fill();
    time(290000);
    const read = send();
    time(299999);
    ready(read, prompt(), 1000, 0);
    ledger.releaseSend(read);
    time(589999);
    const unconfirmed = send();
    outcome(ledger, unconfirmed, "unknown", "prefill_unconfirmed");
    const warm = send();
    ready(warm, prompt(), 0, 0);
    outcome(ledger, warm, "reuse", "same_account_anchor");
    time(590000);
    const expired = send();
    ready(expired, prompt(), 0, 0);
    outcome(ledger, expired, "expired", "ttl_elapsed");
  });

  test("a later confirmed refresh cannot manufacture warmth at an earlier dispatch", () => {
    const { ledger, send, fill, ready, time } = fixture();
    fill();
    time(300001);
    const early = send();
    time(300002);
    const later = send();
    ready(later);
    time(300003);
    ready(early, prompt(), 0, 0);
    outcome(ledger, early, "expired", "ttl_elapsed");
  });

  test("historical versions preserve a warm observation despite a later long-generation write", () => {
    const { ledger, send, fill, ready, time } = fixture();
    const slow = send();
    time(200000);
    fill();
    time(300001);
    const observed = send();
    ready(slow);
    ready(observed, prompt(), 0, 0);
    outcome(ledger, observed, "reuse", "same_account_anchor");
  });

  test("prefill time is captured before worker hashing and unfinished hashing never blocks", () => {
    const { ledger, send, ready, time } = fixture();
    const writing = send();
    time(10);
    expect(ledger.confirmPrefill(writing, event(0, 1000))).toBe(true);
    outcome(ledger, writing, "unknown", "hash_unavailable");
    time(20);
    const reading = send();
    ready(reading, prompt(), 0, 0);
    outcome(ledger, reading, "unknown", "predecessor_pending");
    time(30);
    expect(ledger.resolvePrefix(writing, prompt())).toBe(true);
    outcome(ledger, reading, "reuse", "same_account_anchor");
  });

  test("failed or cancelled prefill, pings and malformed events create no entry", () => {
    const { ledger, send, ready } = fixture();
    for (const failure of [{ type: "ping" }, { type: "message_start" }, event(-1, 1000), { ...event(0, 1000), message: { ...event(0, 1000).message, model: "another-model" } }]) {
      const ticket = send();
      expect(ledger.confirmPrefill(ticket, failure)).toBe(false);
      expect(ledger.resolvePrefix(ticket, prompt())).toBe(false);
      ledger.releaseSend(ticket);
    }
    expect(ledger.coverage().records).toBe(0);
    const next = send();
    ready(next, prompt(), 0, 0);
    outcome(ledger, next, "unknown", "prefill_unconfirmed");
  });

  test("cancellation after confirmed prefill does not erase the provider's completed write", () => {
    const { ledger, send, fill, ready } = fixture();
    const first = fill();
    expect(ledger.confirmPrefill(first, event(0, 1000))).toBe(false);
    const next = send();
    ready(next, prompt(), 0, 0);
    outcome(ledger, next, "reuse", "same_account_anchor");
  });

  test("seat changes are moved, but different destinations and models remain isolated", () => {
    const { ledger, send, fill, ready } = fixture();
    fill();
    const moved = send({ account: "seat-b" });
    ready(moved, prompt(), 0, 0);
    outcome(ledger, moved, "moved", "account_changed");
    const other = send({ destination: "other" });
    ready(other, prompt(), 0, 0);
    outcome(ledger, other, "unknown", "no_observed_predecessor");
    const model = send({ model: "other-model" });
    expect(ledger.confirmPrefill(model, { ...event(0, 0), message: { ...event(0, 0).message, model: "other-model" } })).toBe(true);
    ledger.resolvePrefix(model, prompt());
    outcome(ledger, model, "unknown", "no_observed_predecessor");
    outcome(ledger, send({ account: null }), "unknown", "hidden_account");
  });

  test.each([19, 20, 21])("matches identical content only within lookback at distance %i", distance => {
    const { ledger, send, fill, ready } = fixture();
    fill();
    const next = send();
    ready(next, prompt("shared", distance), 0, 0);
    outcome(ledger, next, distance === 19 ? "reuse" : "unknown", distance === 19 ? "same_account_anchor" : "lookback_gap");
  });

  test("removed breakpoints and conversation divergence never become a proven fill", () => {
    const { ledger, send, fill, ready, time } = fixture();
    fill(prompt(), { conversation: "opaque-thread" });
    const prefix = prompt();
    if (prefix.status !== "supported") throw new Error("invalid fixture");
    const removed = send();
    ready(removed, { ...prefix, breakpoints: [] }, 0, 0);
    outcome(ledger, removed, "unknown", "breakpoints_removed");
    time(3600000);
    const edited = send({ conversation: "opaque-thread" });
    ready(edited, prompt("changed"), 0, 0);
    outcome(ledger, edited, "unknown", "prefix_changed");
  });

  test("aggregate writes at multiple or mixed TTL markers cannot measure individual anchors", () => {
    const { ledger, send, ready } = fixture();
    const prefix = prompt("shared", 1);
    if (prefix.status !== "supported") throw new Error("invalid fixture");
    const ticket = send();
    ready(ticket, { ...prefix, breakpoints: [{ index: 0, ttl: 3600000 }, { index: 1, ttl: 300000 }] });
    expect(ledger.coverage().records).toBe(0);
    const later = send();
    ready(later, prefix, 0, 0);
    outcome(ledger, later, "unknown", "unmeasured_anchor");
  });

  test("a later five-minute marker does not shorten an explicit one-hour read checkpoint", () => {
    const { ledger, fill, send, ready, time } = fixture();
    const hour = prompt("shared", 0, "1h");
    fill(hour);
    const extended = prompt("shared", 1);
    if (extended.status !== "supported") throw new Error("invalid fixture");
    time(50 * 60000);
    const refresh = send();
    ready(refresh, { ...extended, breakpoints: [{ index: 0, ttl: 3600000 }, { index: 1, ttl: 300000 }] }, 1000, 0);
    ledger.releaseSend(refresh);
    time(62 * 60000);
    const later = send();
    ready(later, hour, 0, 0);
    outcome(ledger, later, "reuse", "same_account_anchor");
  });

  test("an ambiguous read TTL lowers coverage without inserting a guessed refresh", () => {
    const { ledger, fill, send, ready, time } = fixture();
    fill(prompt("shared", 0, "1h"));
    time(50 * 60000);
    ready(send(), prompt("shared", 1), 1000, 0);
    expect(ledger.coverage()).toMatchObject({ records: 1, reason: "unmeasured_anchor", complete: false });
  });

  test("read-only usage without a matching measured anchor cannot invent an entry", () => {
    const { ledger, send, ready } = fixture();
    const first = send();
    ready(first, prompt(), 1000, 0);
    expect(ledger.coverage().records).toBe(0);
    const later = send();
    ready(later, prompt(), 0, 0);
    outcome(ledger, later, "unknown", "unmeasured_anchor");
  });

  test("restart has a new epoch, rejects old tickets, and still admits new positive evidence", () => {
    const before = fixture();
    const old = before.fill();
    const after = fixture();
    expect(after.ledger.epoch).not.toBe(before.ledger.epoch);
    outcome(after.ledger, old, "unknown", "epoch_changed");
    const cold = after.send();
    after.ready(cold, prompt(), 0, 0);
    outcome(after.ledger, cold, "unknown", "no_observed_predecessor");
    after.fill();
    const warm = after.send();
    after.ready(warm, prompt(), 0, 0);
    outcome(after.ledger, warm, "reuse", "same_account_anchor");
  });

  test("unsupported shapes and late observation gaps explicitly lower coverage", () => {
    const { ledger, send, ready, time } = fixture();
    time(3600000);
    const beforeGap = send();
    const unsupported = send();
    ready(unsupported, { status: "unsupported", reason: "unsupported_shape" });
    outcome(ledger, unsupported, "unknown", "unsupported_shape");
    ready(beforeGap, prompt(), 0, 0);
    expect(outcome(ledger, beforeGap, "unknown", "unsupported_shape").reuse_coverage).toBe("partial");
    expect(ledger.coverage().complete).toBe(false);
    ledger.releaseSend(beforeGap);
    expect(ledger.memorySnapshot().pinnedBytes).toBeGreaterThan(0);
  });

  test("historical refresh versions count toward the record cap and eviction invalidates old snapshots", () => {
    const { ledger, send, ready, fill, time } = fixture();
    const prefix = prompt();
    const captured = send();
    for (let index = 0; index <= promptCacheReuseLimits.records; index++) {
      time(index);
      fill(prefix);
    }
    expect(ledger.coverage()).toMatchObject({ records: 16384, evictions: 1, reason: "capacity_evicted", complete: false });
    ready(captured, prefix, 0, 0);
    outcome(ledger, captured, "unknown", "history_unavailable");
    const absent = send();
    ready(absent, prompt("never-seen"), 0, 0);
    outcome(ledger, absent, "unknown", "capacity_evicted");
    const stillWarm = send();
    ready(stillWarm, prefix, 0, 0);
    outcome(ledger, stillWarm, "reuse", "same_account_anchor");
  });

  test.each([true, false])("capacity must not hide a current warm-prefix loss (healthy read: %s)", healthy => {
    const { ledger, fill, send, ready } = fixture();
    const other = prompt("other");
    for (let index = 1; index < promptCacheReuseLimits.records; index++) fill(other);
    fill();
    const current = send();
    ready(current, prompt(), healthy ? 1000 : 0, healthy ? 0 : 1000);
    expect(outcome(ledger, current, "reuse", "same_account_anchor")).toMatchObject({
      expected_cached_tokens: 1000, lost_cached_tokens: healthy ? 0 : 1000,
    });
    expect(ledger.coverage().records).toBe(16384);
  });

  test("the ninth account evicts evidence instead of retaining an unbounded account roster", () => {
    const { ledger, fill } = fixture();
    const prefix = prompt();
    for (let index = 0; index < 9; index++) fill(prefix, { account: `seat-${index}` });
    expect(ledger.coverage()).toMatchObject({ records: 8, evictions: 1, reason: "capacity_evicted" });
  });

  test("pending admission caps both ticket count and retained bytes without blocking sends", () => {
    const tickets = fixture();
    const accepted = Array.from({ length: 64 }, () => tickets.send());
    expect(accepted.every(ticket => ticket.rejected === undefined)).toBe(true);
    outcome(tickets.ledger, tickets.send(), "unknown", "worker_backlog");
    tickets.ledger.releaseSend(accepted[0]!);
    expect(tickets.send().rejected).toBeUndefined();
    const bytes = fixture();
    expect(bytes.send({ bodyBytes: 32 * 1024 * 1024 }).rejected).toBeUndefined();
    outcome(bytes.ledger, bytes.send({ bodyBytes: 32 * 1024 * 1024 }), "unknown", "worker_backlog");
    expect(bytes.ledger.coverage().pendingBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  test("a worker result that exceeds the pending byte cap retains an explicit backlog verdict", () => {
    const { ledger, send } = fixture();
    const pending = Array.from({ length: 63 }, () => send({ bodyBytes: 1024 * 1024 }));
    const ticket = pending[0]!;
    expect(ledger.confirmPrefill(ticket, event(0, 1000))).toBe(true);
    expect(ledger.resolvePrefix(ticket, prompt("shared", 16383))).toBe(false);
    outcome(ledger, ticket, "unknown", "worker_backlog");
    expect(ledger.coverage()).toMatchObject({ records: 0, pendingTickets: 63, reason: "worker_backlog" });
    expect(ledger.coverage().pendingBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    ledger.releaseSend(ticket);
    expect(ledger.coverage()).toMatchObject({ pendingTickets: 62, reason: "worker_backlog" });
  });

  test("retained memory participates in the shared budget and is unregistered on close", () => {
    const { ledger, fill, send, ready } = fixture();
    fill();
    const id = `prompt-cache-reuse:${ledger.epoch}`;
    expect(appOwnedBytesSnapshot().stores[id]?.evictableBytes).toBeGreaterThan(0);
    configureAppOwnedMemoryBudget(0);
    enforceAppOwnedMemoryBudget();
    expect(ledger.coverage()).toMatchObject({ records: 0, reason: "capacity_evicted" });
    const next = send();
    ready(next, prompt(), 0, 0);
    outcome(ledger, next, "unknown", "capacity_evicted");
    ledger.close();
    expect(appOwnedBytesSnapshot().stores[id]).toBeUndefined();
  });

  test("the send identity and resolved prefix cannot be mutated by their callers", () => {
    const { ledger, send, ready } = fixture();
    const identity = { account: "seat-a" };
    const first = send(identity);
    identity.account = "seat-b";
    expect(Object.isFrozen(first)).toBe(true);
    const prefix = prompt();
    if (prefix.status !== "supported") throw new Error("invalid fixture");
    const mutable = { ...prefix, positions: prefix.positions.map(position => ({ ...position })) };
    ready(first, mutable);
    mutable.positions[0]!.digest = "changed";
    const next = send();
    ready(next, prompt(), 0, 0);
    outcome(ledger, next, "reuse", "same_account_anchor");
  });
});
