import { BOUNDED_BODY_MAX_BYTES, decodeUtf8WithValidity } from "../../lib/bounded-body";
import { carryProviderResponseProvenance } from "../../providers/request-pacing";

// Quota and combo error classification must not open a second reader or deadline after handback.
type Inspection = { text: string; utf8Valid: boolean; displaySafe: boolean; truncated: boolean };
const inspectedBodies = new WeakMap<Response, Uint8Array | Inspection | null>();
export function inspectedReserveRefusal(response: Response) {
  const stored = inspectedBodies.get(response);
  if (stored === undefined) return undefined;
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

/** Inspect one prefix. On handback the client owns the prefix, outstanding read and unread tail. */
export async function inspectReserveRefusal(response: Response, waitMs: number, signal: AbortSignal): Promise<{
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
    return inspected(wrap(new ReadableStream<Uint8Array>({
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
  };
  let wake: (() => void) | undefined;
  const interrupt = () => wake?.();
  const end = performance.now() + waitMs;
  const timer = setTimeout(interrupt, waitMs);
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    // Bound empty/tiny chunks too. One interrupt handler owns only the current read.
    for (let pulls = 0; pulls < 256 && performance.now() < end && !signal.aborted; pulls++) {
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
