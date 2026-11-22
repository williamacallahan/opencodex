/** Hard cap for canonicalizing ANY item. Past it, the item is not comparable. */
const REPLAY_FINGERPRINT_MAX_BYTES = 8 * 1024;
/** Depth ceiling so a pathologically nested item cannot blow the canonicalizer. */
const REPLAY_FINGERPRINT_MAX_DEPTH = 64;
const MESSAGE_KEYS = new Set(["type", "role", "content"]);

/**
 * One shape for a plain user turn: `{role: "user", content: <text>}`.
 *
 * A string `input` is stored as `{role: "user", content: <string>}` (state.ts `inputItems`), and a
 * client that resends that turn may send the typed form `{type: "message", role: "user", content:
 * [{type: "input_text", text}]}`. Both name the same turn; without this the carried prefix reads 0
 * and replay prepends the turn a second time.
 *
 * Only that exact pair folds: role `user`, no keys beyond type/role/content, non-empty text, and
 * either string content or one part whose only keys are `type: "input_text"` and `text`. Adapters read
 * other tags differently (a user `output_text` or `text` part parses as empty or does not close a
 * Luna turn, and Chat drops an empty-string assistant turn but keeps an empty typed one), so every
 * other shape compares byte for byte.
 */
function canonicalUserText(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const record = item as Record<string, unknown>;
  if (record.role !== "user" || (record.type !== undefined && record.type !== "message")) return item;
  if (!Object.keys(record).every(key => MESSAGE_KEYS.has(key))) return item;
  const content = record.content;
  if (typeof content === "string") return content ? { role: "user", content } : item;
  if (!Array.isArray(content) || content.length !== 1) return item;
  const part = content[0] as Record<string, unknown> | null;
  if (!part || typeof part !== "object" || Array.isArray(part)) return item;
  if (Object.keys(part).length !== 2 || part.type !== "input_text" || typeof part.text !== "string" || !part.text) return item;
  return { role: "user", content: part.text };
}

/**
 * Canonical, order-stable fingerprint for one input item, or null when the item cannot be
 * compared safely.
 *
 * Byte-counted DURING the walk rather than serialize-then-measure: a tool result can be
 * megabytes and this runs on the request path, so the point of the cap is to stop early,
 * not to discover afterwards that we should have. Object keys are sorted so two
 * semantically identical items cannot differ by key order alone.
 *
 * The cap applies to EVERY item. An `id`/`call_id` is additional occurrence evidence, never
 * a substitute for content equality, so an over-cap identified tool item is non-comparable
 * exactly like an over-cap message.
 */
function replayItemFingerprint(item: unknown): string | null {
  const folded = canonicalUserText(item);
  // The cap judges the item as sent: folding must not make an over-cap message comparable.
  if (folded !== item && canonicalFingerprint(item) === null) return null;
  return canonicalFingerprint(folded);
}

function canonicalFingerprint(item: unknown): string | null {
  const out: string[] = [];
  let bytes = 0;
  const push = (text: string): boolean => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > REPLAY_FINGERPRINT_MAX_BYTES) return false;
    out.push(text);
    return true;
  };
  const walk = (value: unknown, depth: number): boolean => {
    if (depth > REPLAY_FINGERPRINT_MAX_DEPTH) return false;
    if (value === null || typeof value !== "object") return push(JSON.stringify(value) ?? "null");
    if (Array.isArray(value)) {
      if (!push("[")) return false;
      for (const element of value) {
        if (!walk(element, depth + 1)) return false;
        if (!push(",")) return false;
      }
      return push("]");
    }
    if (!push("{")) return false;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (!push(JSON.stringify(key))) return false;
      if (!walk((value as Record<string, unknown>)[key], depth + 1)) return false;
      if (!push(",")) return false;
    }
    return push("}");
  };
  return walk(item, 0) ? out.join("") : null;
}

/** Non-empty provider-issued `id`/`call_id` on an item, else null. */
export function providerIssuedIdentity(item: unknown): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as { id?: unknown; call_id?: unknown };
  for (const candidate of [record.id, record.call_id]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}

/**
 * Number of leading stored items the client already carries verbatim, or 0.
 *
 * Requires an exact ordered run: every stored item must match the client input item at the
 * same index. Any not-comparable item aborts to 0 — skipping just that item could align two
 * different occurrences and manufacture a false positive, and a false positive here deletes
 * real conversation history.
 *
 * Known gap (FU-2): stored input can contain proxy-injected guidance the client never saw,
 * and ids repaired after recording. Those sessions do not match here and expand as before.
 */
export function clientCarriedPrefixLength(stored: readonly unknown[], clientInput: readonly unknown[]): number {
  if (stored.length === 0 || clientInput.length < stored.length) return 0;
  for (let index = 0; index < stored.length; index += 1) {
    const storedPrint = replayItemFingerprint(stored[index]);
    if (storedPrint === null) return 0;
    const clientPrint = replayItemFingerprint(clientInput[index]);
    if (clientPrint === null || storedPrint !== clientPrint) return 0;
  }
  return stored.length;
}
