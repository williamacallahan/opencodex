import type { StoredResponseState } from "../state";

/**
 * Pick the snapshot entries that fit the byte budgets, in `states` order, and
 * return them already serialized.
 *
 * Bounded stubs and tombstones are selected before residents: they are the
 * only durable references a spill file has, and demotion is oldest-first, so a
 * single newest-first pass would let resident payloads consume the whole
 * budget ahead of them. Residents then fill what remains, newest-first so the
 * most recent chains survive both legacy snapshot caps.
 *
 * Each entry has to be stringified once anyway to measure it, so the kept
 * strings are returned instead of the entries: serializing the whole selection
 * again would walk up to the full snapshot budget a second time per write.
 */
const serializedEntryCache = new WeakMap<StoredResponseState, { id: string; entry: string; size: number }>();

function serializeSnapshotEntry(
  id: string,
  state: StoredResponseState,
): { entry: string; size: number } {
  const cached = serializedEntryCache.get(state);
  if (cached && cached.id === id) return cached;
  const payload = state.kind === "resident"
    ? (() => { const { sizeBytes: _sizeBytes, kind: _kind, ...resident } = state; return resident; })()
    : (() => { const { sizeBytes: _sizeBytes, ...smallState } = state; return smallState; })();
  const entry = JSON.stringify([id, payload]);
  const size = Buffer.byteLength(entry, "utf8");
  const record = { id, entry, size };
  serializedEntryCache.set(state, record);
  return record;
}

export function selectSnapshotEntries(
  states: ReadonlyMap<string, StoredResponseState>,
  totalMaxBytes: number,
  residentEntryMaxBytes: number,
): string[] {
  const ordered = [...states].reverse();
  const persisted = new Map<string, string>();
  let total = 0;
  // UTF-8 bytes, not UTF-16 code units: multibyte items otherwise slip past
  // both snapshot caps at up to 2x the intended size.
  for (const [id, state] of ordered) {
    if (state.kind === "resident") continue;
    const { entry, size } = serializeSnapshotEntry(id, state);
    if (total + size > totalMaxBytes) continue;
    total += size;
    persisted.set(id, entry);
  }
  for (const [id, state] of ordered) {
    if (state.kind !== "resident") continue;
    const { entry, size } = serializeSnapshotEntry(id, state);
    if (size > residentEntryMaxBytes) continue;
    if (total + size > totalMaxBytes) break;
    total += size;
    persisted.set(id, entry);
  }
  // Emit in map order so reload and count eviction keep the same relative order as `states`.
  const entries: string[] = [];
  for (const [id] of states) {
    const kept = persisted.get(id);
    if (kept) entries.push(kept);
  }
  return entries;
}

/**
 * The snapshot file body for serialized entries. Byte-identical to
 * `JSON.stringify({ version: 2, states: entries.map(e => JSON.parse(e)) })`: compact
 * JSON.stringify renders an array element exactly as it renders that value alone.
 */
export function snapshotPayload(serializedEntries: readonly string[]): string {
  return '{"version":2,"states":[' + serializedEntries.join(",") + "]}";
}
