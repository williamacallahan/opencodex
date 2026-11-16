import { walkPromptCachePrefix } from "./prompt-cache-prefix";
import type { PrefixWorkerRequest, PrefixWorkerReply } from "./prompt-cache-observer";

declare const self: Worker;

// One resident worker handles the already-admitted queue; no request thread scans prompt bytes.
self.onmessage = (event: MessageEvent<PrefixWorkerRequest>) => {
  const { id, chunks, encoding } = event.data;
  let reply: PrefixWorkerReply;
  try {
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    reply = { id, prefix: walkPromptCachePrefix(bytes, encoding) };
  } catch (error) {
    // Walk failures are typed results; an exception here is a defect, so name it without prompt bytes.
    reply = { id, failed: true, error: (error instanceof Error ? `${error.name}: ${error.message}` : typeof error).slice(0, 200) };
  }
  self.postMessage(reply);
};
