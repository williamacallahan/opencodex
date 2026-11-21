import { BOUNDED_BODY_MAX_BYTES, BOUNDED_BODY_TIMEOUT_MS, decodeUtf8WithValidity } from "../../lib/bounded-body";
import { carryProviderResponseProvenance } from "../../providers/request-pacing";

// A retry probe must not read again after handback. The terminal consumer owns the remaining stream.
type Inspection = { text: string; utf8Valid: boolean; displaySafe: boolean; truncated: boolean };
const deferredReads = new WeakSet<Response>();
const inspectedBodies = new WeakMap<Response, Uint8Array | Inspection | null>();
export function inspectedReserveRefusal(response: Response, consumer: "retry" | "final" = "retry") {
  const stored = inspectedBodies.get(response);
  if (stored === undefined || (stored === null && consumer === "final")) return undefined;
  if (stored === null) return { text: "", displaySafe: false, truncated: true, utf8Valid: false };
  if (!(stored instanceof Uint8Array)) return stored;
  const result = { ...decodeUtf8WithValidity(stored), displaySafe: true, truncated: false };
  inspectedBodies.set(response, result);
  return result;
}
function inspected(response: Response, bytes?: Uint8Array) {
  inspectedBodies.set(response, bytes ?? null);
  return { response, bytes };
}

/** Finish a handed-back slow read once, before a quota decision could skip the remaining seats. */
export async function finishReserveWalkInspection(response: Response, signal: AbortSignal): Promise<Response> {
  if (!deferredReads.delete(response)) return response;
  const final = await inspectReserveRefusal(response, BOUNDED_BODY_TIMEOUT_MS, signal, true);
  signal.throwIfAborted();
  return final.response;
}

/** Inspect one prefix. On handback the client owns the prefix, outstanding read and unread tail. */
export async function inspectReserveRefusal(response: Response, waitMs: number, signal: AbortSignal, final = false): Promise<{
  response: Response; bytes?: Uint8Array;
}> {
  const body = response.body;
  if (!body) return inspected(response, new Uint8Array(0));
  if (Number(response.headers.get("content-length")) > BOUNDED_BODY_MAX_BYTES) return inspected(response);
  const reader = body.getReader();
  let prefix = new Uint8Array(0);
  let used = 0;
  const wrap = (stream: ReadableStream<Uint8Array>) => carryProviderResponseProvenance(response, new Response(stream, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  }));
  // The chunk crossing the cap already belongs to the producer. Transfer it, never tee or copy it.
  const handBack = (pending?: ReturnType<typeof reader.read>, extra?: Uint8Array) => {
    const chunks: Uint8Array[] = [];
    if (used) chunks.push(prefix.subarray(0, used));
    if (extra) chunks.push(extra);
    const handed = inspected(wrap(new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = chunks.shift();
        if (chunk) { controller.enqueue(chunk); return; }
        try {
          const next = await (pending ?? reader.read()); pending = undefined;
          if (next.done) { reader.releaseLock(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { reader.releaseLock(); controller.error(error); }
      },
      cancel(reason) { return reader.cancel(reason).finally(() => reader.releaseLock()); },
    }, { highWaterMark: 0 })));
    if (final || extra) inspectedBodies.set(handed.response, { text: "", displaySafe: false, truncated: true, utf8Valid: false });
    else deferredReads.add(handed.response);
    return handed;
  };
  let wake: (() => void) | undefined;
  const interrupt = () => wake?.();
  const end = performance.now() + waitMs;
  const timer = setTimeout(interrupt, waitMs);
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    // Bound empty/tiny chunks too. One interrupt handler owns only the current read.
    for (let pulls = 0; (final || pulls < 256) && performance.now() < end && !signal.aborted; pulls++) {
      const pending = reader.read();
      const next = await new Promise<Awaited<typeof pending> | undefined>((resolve, reject) => {
        wake = () => resolve(undefined);
        void pending.then(resolve, reject);
      });
      if (!next) return handBack(pending);
      if (next.done) {
        reader.releaseLock();
        const bytes = prefix.subarray(0, used);
        return inspected(wrap(new ReadableStream({ start(c) { if (used) c.enqueue(bytes); c.close(); } })), bytes);
      }
      if (next.value.byteLength > BOUNDED_BODY_MAX_BYTES - used) return handBack(undefined, next.value);
      if (used + next.value.byteLength > prefix.length) {
        const grown = new Uint8Array(Math.min(BOUNDED_BODY_MAX_BYTES, Math.max(used + next.value.byteLength, 2 * prefix.length)));
        grown.set(prefix); prefix = grown;
      }
      prefix.set(next.value, used); used += next.value.byteLength;
    }
    return handBack();
  } catch {
    // An errored source is still the caller's response, including bytes preceding the error.
    return handBack();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", interrupt);
  }
}
