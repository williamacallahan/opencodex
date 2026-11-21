/**
 * Anthropic extended-thinking signature round-trip through Codex's `encrypted_content` slot.
 *
 * Anthropic requires the previous assistant turn's `thinking`/`redacted_thinking` blocks to be
 * replayed VERBATIM (with their signatures) while extended thinking is enabled; a signature-less
 * replay 400s ("Expected `thinking` or `redacted_thinking`, but found `tool_use`"). Codex round-trips
 * whatever `encrypted_content` a reasoning output item carries (include: reasoning.encrypted_content
 * is set whenever reasoning is on — codex-rs client.rs), so the proxy smuggles the real Anthropic
 * signature (and any redacted blocks) inside a transparent `ocxr1:` + base64(JSON) envelope.
 *
 * Native OpenAI-encrypted blobs (no ocxr1 prefix) are left untouched by the decoder, and the
 * passthrough scrub strips ocxr1 envelopes before native forwarding.
 */

import { createTranslatorBudget, type TranslatorBudget } from "../lib/translator-budget";
import { jsonUtf8Bytes } from "../lib/json-byte-size";
import { isRec } from "../claude/inbound-records";

export const OCX_REASONING_PREFIX = "ocxr1:";

export interface ReasoningEnvelope {
  /** Anthropic thinking-block signature (signature_delta), if captured. */
  sig?: string;
  /** Immediately preceding output item owned by this late turn signature. */
  aft?: string;
  /** ID of the immediately following commentary copy of this signed thinking block. */
  upd?: string;
  /** Raw redacted_thinking block data payloads, order preserved. */
  red?: string[];
  /**
   * Hidden thinking text (hideThinkingSummary providers): the signature signs this exact text,
   * so replay needs it even though the visible summary was suppressed.
   */
  txt?: string;
  /**
   * Kiro's reasoning blob from `reasoningContentEvent`: a KMS-encrypted value that is opaque to the
   * proxy (the GPT-5.6 family sends it as `signature`, other models as the base64
   * `redactedContent`, and the value carries a tag naming which one — see
   * src/adapters/kiro/reasoning.ts). Kiro's own CLI replays it on the matching
   * `assistantResponseMessage` to preserve model reasoning across turns, so it round-trips here the
   * same way a signature does.
   */
  krc?: string;
  /**
   * A Responses provider's own `encrypted_content` for one reasoning item, minted while serving
   * `model` (the client-facing model the Claude route was asked for). The Claude route has no
   * other channel to hand a provider its reasoning back: the body is `store: false` and Claude
   * Code replays only the thinking block. `src/claude/inbound.ts` restores it only for a request
   * naming the same model, so a model switch cannot carry it to a provider that cannot decrypt it.
   */
  nat?: NativeReasoning;
}

export interface NativeReasoning {
  /** The provider's opaque `encrypted_content`, verbatim. */
  enc: string;
  /** Client-facing model the item was produced for. */
  model: string;
  /** Route-bound HMAC for this exact ciphertext. */
  tag: string;
  /** The provider's reasoning item id, when it sent one. */
  id?: string;
}

function decodeNativeReasoning(value: unknown): NativeReasoning | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { enc, model, id, tag } = value as { enc?: unknown; model?: unknown; id?: unknown; tag?: unknown };
  if (typeof enc !== "string" || enc.length === 0 || typeof model !== "string" || model.length === 0 || typeof tag !== "string" || tag.length === 0) return undefined;
  return typeof id === "string" && id.length > 0 ? { enc, model, tag, id } : { enc, model, tag };
}

export function encodeReasoningEnvelope(envelope: ReasoningEnvelope, budget?: TranslatorBudget): string {
  const activeBudget = budget ?? createTranslatorBudget();
  try {
    const jsonBytes = jsonUtf8Bytes(envelope);
    const base64Bytes = 4 * Math.ceil(jsonBytes / 3);
    // Reserve before materialization: UTF-16 JSON, UTF-8 buffer, base64 string,
    // and the prefixed result may coexist. Returned-value ownership stays with
    // callers, whose existing retained accounting must not be charged twice here.
    const reservation = activeBudget.reserveTransient(
      Math.max(
        3 * jsonBytes + 4 * base64Bytes + 2 * OCX_REASONING_PREFIX.length,
        8 * (OCX_REASONING_PREFIX.length + base64Bytes),
      ),
      { kind: "reasoning" },
    );
    try {
      return OCX_REASONING_PREFIX + Buffer.from(JSON.stringify(envelope), "utf-8").toString("base64");
    } finally {
      reservation.release();
    }
  } finally {
    if (!budget) activeBudget.dispose();
  }
}

/**
 * Whether a thinking part's `signature` is an attestation some provider issued, rather than
 * the serialized reasoning item the parser parks in the same field.
 *
 * `src/responses/parser.ts` stores `JSON.stringify(reasoningItem)` on an UNSIGNED thinking
 * part so the opaque item survives a same-provider round trip. Every adapter that forwards a
 * signature upstream is forwarding an opaque attestation, and a provider asked to verify our
 * own parser state cannot recognize it. The predicate lives beside the envelope code that owns
 * this field's representation rather than in one adapter, because a private second copy is how
 * the side that writes the field and a side that reads it come to disagree about what it holds.
 *
 * This is a deny-list for exactly that one shape, not a guess at what an attestation looks
 * like. `src/adapters/anthropic.ts` applies a stricter allow-list on top of it, because an
 * Anthropic signature has a known base64 spelling; that shape is a fact about Anthropic's wire
 * and is not assumed of any other provider's token here.
 */
export function isProviderIssuedThinkingSignature(
  signature: string | undefined,
): signature is string {
  if (typeof signature !== "string" || signature.length === 0) return false;
  if (!signature.startsWith("{")) return true;
  try {
    const parsed: unknown = JSON.parse(signature);
    return !parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || (parsed as { type?: unknown }).type !== "reasoning";
  } catch {
    return true;
  }
}

/**
 * Whether a value has the spelling of a signature Anthropic issued. An allow-list on top of
 * `isProviderIssuedThinkingSignature`: Anthropic's signature is base64, so item ids and the
 * parser's serialized placeholder never pass. Shared by the adapter, which forwards only such a
 * signature, and the Chat `reasoning_details` carrier, which accepts and emits only such a one.
 */
export function isLikelyRealAnthropicThinkingSignature(signature: string | undefined): signature is string {
  if (typeof signature !== "string" || signature.length < 16) return false;
  if (/^(fc|call|msg|rs|resp|reasoning|item|ws|tool|func|function)[-_]/i.test(signature)) return false;
  return /^[A-Za-z0-9+/_=-]+$/.test(signature);
}

/**
 * Ceiling on the `ocxr1:` signature characters of provider-native reasoning one Claude Messages
 * request may hand back to its provider. Each native blob is charged about five times its size
 * against the 32 MiB translator turn budget (once in the translated body's three coexisting
 * copies, twice as retained input), so an uncapped long session (a 2,150-message gpt-6.2-sol
 * session replayed 556 blobs, 3.4 MB of ciphertext) used most of the budget on ciphertext and
 * the hub answered 413 until the session died. Only blobs the requested model minted count.
 */
export const NATIVE_REASONING_REPLAY_MAX_SIGNATURE_CHARS = 2.5 * 1024 * 1024;

/**
 * Completed turns leave replay oldest first in steps of this many signature characters, so the
 * cutoff stays put for many turns instead of moving every request. GPT-6.2 keeps later reasoning
 * when whole earlier items are deleted, but every move still costs the prompt cache from that point.
 */
const NATIVE_REASONING_REPLAY_PRUNE_STEP_CHARS = NATIVE_REASONING_REPLAY_MAX_SIGNATURE_CHARS / 2;

/**
 * What a translator does with one thinking block carrying a provider-native envelope:
 * `replay` hands the blob back, `omit` drops the whole item (an expired blob of the requested
 * model: replacing it in place would edit the prefix ahead of the reasoning still replayed), and
 * `visible` keeps only the visible text (a blob another model minted, or one too large to replay).
 */
export type NativeReasoningReplayDecision = "replay" | "omit" | "visible";

/** A user message that is not only tool results starts a new turn; tool results continue the active one. */
function startsTurn(content: unknown): boolean {
  return !Array.isArray(content) || content.some(block => !isRec(block) || block.type !== "tool_result");
}

/**
 * Whether an envelope too large to replay is a native one, read without the full decode
 * reservation (eight bytes per character would exceed the turn budget above 4 MiB). JSON escapes
 * every quote inside a string, so these byte sequences can only be object keys.
 */
function isOversizedNativeEnvelope(signature: string, budget: TranslatorBudget): boolean {
  const reservation = budget.reserveTransient(2 * signature.length, { kind: "reasoning" });
  try {
    const json = Buffer.from(signature.slice(OCX_REASONING_PREFIX.length), "base64");
    return json.includes("\"nat\":{") && !json.includes("\"sig\":");
  } finally {
    reservation.release();
  }
}

/**
 * Decide, per thinking block (by identity), which provider-native blobs one Messages request
 * replays. Blocks absent from the result are not native envelopes and keep the translator's own
 * validation. Only blobs `requestedModel` minted count toward the cap; one over the cap alone is
 * skipped without ending the selection. Completed turns leave first, whole turns at a time; the
 * active tool chain (after the last user turn) keeps its newest blobs that fit.
 */
export function nativeReasoningReplayPlan(
  messages: readonly unknown[],
  requestedModel: string,
  budget: TranslatorBudget,
): ReadonlyMap<object, NativeReasoningReplayDecision> {
  const plan = new Map<object, NativeReasoningReplayDecision>();
  const candidates: { block: object; chars: number; turn: number }[] = [];
  let turn = 0;
  let total = 0;
  for (const message of messages) {
    if (!isRec(message)) continue;
    if (message.role === "user") {
      if (startsTurn(message.content)) turn++;
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRec(block) || block.type !== "thinking" || typeof block.signature !== "string") continue;
      const signature = block.signature;
      if (!signature.startsWith(OCX_REASONING_PREFIX)) continue;
      if (signature.length > NATIVE_REASONING_REPLAY_MAX_SIGNATURE_CHARS) {
        if (isOversizedNativeEnvelope(signature, budget)) plan.set(block, "visible");
        continue;
      }
      const envelope = decodeReasoningEnvelope(signature, budget);
      if (!envelope?.nat || Object.hasOwn(envelope, "sig")) continue;
      if (envelope.nat.model !== requestedModel) {
        plan.set(block, "visible");
        continue;
      }
      plan.set(block, "replay");
      candidates.push({ block, chars: signature.length, turn });
      total += signature.length;
    }
  }
  let excess = total - NATIVE_REASONING_REPLAY_MAX_SIGNATURE_CHARS;
  if (excess <= 0) return plan;
  let drop = Math.ceil(excess / NATIVE_REASONING_REPLAY_PRUNE_STEP_CHARS) * NATIVE_REASONING_REPLAY_PRUNE_STEP_CHARS;
  let next = 0;
  while (drop > 0 && next < candidates.length && candidates[next]!.turn < turn) {
    const completed = candidates[next]!.turn;
    for (; next < candidates.length && candidates[next]!.turn === completed; next++) {
      plan.set(candidates[next]!.block, "omit");
      drop -= candidates[next]!.chars;
      excess -= candidates[next]!.chars;
    }
  }
  for (; excess > 0 && next < candidates.length; next++) {
    plan.set(candidates[next]!.block, "omit");
    excess -= candidates[next]!.chars;
  }
  return plan;
}

/** Decode an ocxr1 envelope; returns null for native (OpenAI-encrypted) blobs or garbage. */
export function decodeReasoningEnvelope(encryptedContent: string, budget?: TranslatorBudget): ReasoningEnvelope | null {
  if (!encryptedContent.startsWith(OCX_REASONING_PREFIX)) return null;
  const activeBudget = budget ?? createTranslatorBudget();
  try {
    // Also bound already-encoded replay before slicing, decoding, or parsing it.
    // Eight bytes per code unit conservatively covers the string/buffer copies.
    const reservation = activeBudget.reserveTransient(8 * encryptedContent.length, { kind: "reasoning" });
    try {
      const parsed: unknown = JSON.parse(Buffer.from(encryptedContent.slice(OCX_REASONING_PREFIX.length), "base64").toString("utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const obj = parsed as { sig?: unknown; red?: unknown };
      const envelope: ReasoningEnvelope = {};
      if (typeof obj.sig === "string") envelope.sig = obj.sig;
      const aft = (parsed as { aft?: unknown }).aft;
      if (typeof aft === "string" && aft.length > 0) envelope.aft = aft;
      const upd = (parsed as { upd?: unknown }).upd;
      if (typeof upd === "string" && /^msg_[a-f0-9]{32}$/.test(upd)) envelope.upd = upd;
      if (Array.isArray(obj.red)) {
        const red = obj.red.filter((r): r is string => typeof r === "string");
        if (red.length > 0) envelope.red = red;
      }
      const txt = (parsed as { txt?: unknown }).txt;
      const hasTxt = typeof txt === "string";
      if (hasTxt) envelope.txt = txt;
      const krc = (parsed as { krc?: unknown }).krc;
      if (typeof krc === "string" && krc.length > 0) envelope.krc = krc;
      const nat = decodeNativeReasoning((parsed as { nat?: unknown }).nat);
      if (nat) envelope.nat = nat;
      return envelope.sig || envelope.red || hasTxt || envelope.krc || envelope.nat ? envelope : null;
    } catch {
      return null;
    } finally {
      reservation.release();
    }
  } finally {
    if (!budget) activeBudget.dispose();
  }
}
