import { walkPromptCachePrefix } from "./prompt-cache-prefix";
import type { PrefixWorkerRequest, PrefixWorkerReply } from "./prompt-cache-observer";

declare const self: Worker;

// One resident worker handles the already-admitted queue; no request thread scans prompt bytes.
self.onmessage = (event: MessageEvent<PrefixWorkerRequest>) => {
  const { id, bytes, encoding } = event.data;
  let reply: PrefixWorkerReply;
  try {
    reply = { id, prefix: walkPromptCachePrefix(bytes, encoding) };
  } catch {
    reply = { id, failed: true };
  }
  self.postMessage(reply);
};
