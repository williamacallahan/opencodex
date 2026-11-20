import { loadConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";

const phase = process.argv[2];
const first = phase === "first";
const createdAt = new Date().toISOString();
const keys = first ? ["caller", "other"].map(id => ({ id, name: id, key: crypto.randomUUID(), createdAt })) : loadConfig().apiKeys!;
const caller = keys[0]!;
const rotated = crypto.randomUUID();
const served: string[] = [];
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (req.method !== "POST") return Response.json({ data: [] });
  const { model } = await req.json();
  served.push(model);
  return Response.json({ id: `resp_${crypto.randomUUID()}`, object: "response", model, status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
} });
const targets = (first ? ["original", "fresh"] : ["fresh", "original"]).map(model => ({ provider: "fixture", model }));
saveConfig({ port: 0, hostname: "0.0.0.0", defaultProvider: "fixture",
  apiKeys: [{ ...caller, pendingRotation: { id: "rotation", key: rotated, createdAt, expiresAt: new Date(Date.now() + 60_000).toISOString() } }, keys[1]!],
  providers: { fixture: { adapter: "openai-responses", baseUrl: `${upstream.url.origin}/v1`, apiKey: "fixture", allowPrivateNetwork: true, models: ["original", "fresh"] } },
  combos: { pair: { strategy: "failover", targets } },
});
const localFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  if (new URL(input instanceof Request ? input.url : input).hostname !== "127.0.0.1") throw new Error("Non-fixture fetch");
  return localFetch(input, init);
}, { preconnect() {} });
const server = startServer(0);
try {
  for (const key of first ? [caller.key, caller.key] : [caller.key, keys[1]!.key, rotated]) {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json", "x-opencodex-api-key": key, "thread-id": "restart-thread" },
      body: JSON.stringify({ model: "combo/pair", input: "another turn", stream: false, store: false }),
      signal: AbortSignal.timeout(5000),
    });
    await res.arrayBuffer();
    if (res.status !== 200) throw new Error(`Fixture turn returned ${res.status}`);
  }
  console.log(`served=${served.join(",")}`);
  if (phase === "unclean") process.exit(17); // Leave the store open, without the server's final flush.
} finally {
  await server.stop(true);
  await upstream.stop(true);
}
process.exit(0);
