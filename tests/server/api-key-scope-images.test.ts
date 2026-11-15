/**
 * Per-key model and provider scope on the standalone Images relay (#5049).
 *
 * This endpoint never enters the router, so the scope landed with #5265 did not
 * reach it: an authenticated key could spend any configured image backend. Each
 * case below pins one of the four destinations this handler can choose and
 * asserts the refusal happens before the paid upstream call.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_NOT_ALLOWED_FOR_KEY, UNNAMED_DESTINATION_MODEL } from "../../src/server/admission-model-scope";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import { handleImages } from "../../src/server/images";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SCOPED_KEY = "ocx_data_" + "i".repeat(40);
const OPEN_KEY = "ocx_data_" + "o".repeat(40);
const SCOPED: DataPlaneAdmission = { kind: "configured", keyId: "scoped", source: "bearer" };
const UNSCOPED: DataPlaneAdmission = { kind: "configured", keyId: "open", source: "bearer" };

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home = "";
let upstreamCalls: string[] = [];
let upstreamInit: Array<RequestInit & { proxy?: string | false }> = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-images-scope-"));
  process.env.OPENCODEX_HOME = home;
  upstreamCalls = [];
  upstreamInit = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit & { proxy?: string | false }) => {
    upstreamCalls.push(String(input));
    if (init) upstreamInit.push(init);
    return Response.json({ created: 1, data: [{ b64_json: "aGk=" }] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

type Scope = { allowedProviders?: string[]; allowedModels?: string[] };

function config(scope: Scope, overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai-apikey",
    providers: {
      "openai-apikey": {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "fixture-images-key",
        authMode: "key",
      },
    },
    apiKeys: [
      { id: "scoped", name: "mail", key: SCOPED_KEY, createdAt: "2026-01-01T00:00:00.000Z", ...scope },
      { id: "open", name: "coding", key: OPEN_KEY, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    ...overrides,
  } as OcxConfig;
}

function imagesRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + SCOPED_KEY },
    body: JSON.stringify(body),
  });
}

function logContext(): RequestLogContext {
  return { model: "image_gen", provider: "unknown" } as RequestLogContext;
}

async function denial(response: Response): Promise<{ type: string; model: string }> {
  const payload = await response.json() as { error: { type: string; model: string } };
  return payload.error;
}

test("a scoped key cannot relay images through a provider it may not reach", async () => {
  const response = await handleImages(
    imagesRequest({ model: "gpt-image-1", prompt: "a cat" }),
    config({ allowedProviders: ["some-other-provider"] }),
    "generations",
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(403);
  const error = await denial(response);
  expect(error.type).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
  // The caller learns which of its own requests was refused, nothing about the destination.
  expect(error.model).toBe("gpt-image-1");
  expect(upstreamCalls).toEqual([]);
});

test("the same key still reaches the destination its scope names", async () => {
  const response = await handleImages(
    imagesRequest({ model: "gpt-image-1", prompt: "a cat" }),
    config({ allowedProviders: ["openai-apikey"], allowedModels: ["gpt-image-1"] }),
    "generations",
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(200);
  expect(upstreamCalls).toHaveLength(1);
  expect(upstreamCalls[0]).toContain("/v1/images/generations");
});

test.each(["generations", "edits"] as const)("image %s uses the provider's route and preserves inherited routing", async endpoint => {
  for (const proxy of [undefined, "http://proxy.example:8080", "direct"] as const) {
    const cfg = config({});
    cfg.providers["openai-apikey"]!.proxy = proxy;
    const response = await handleImages(imagesRequest({ prompt: "a cat" }), cfg, endpoint, logContext(), undefined, UNSCOPED);
    expect(response.status).toBe(200);
    expect(upstreamCalls.at(-1)).toBe(`https://api.openai.com/v1/images/${endpoint}`);
    expect(upstreamInit.at(-1)?.proxy).toBe(proxy === "direct" ? false : proxy === undefined ? undefined : "http://proxy.example:8080/");
  }
});

test("image provider bypasses its proxy for matching destinations and rejects an invalid route", async () => {
  const cfg = config({});
  Object.assign(cfg.providers["openai-apikey"]!, { proxy: "http://proxy.example:8080", noProxy: "api.openai.com" });
  expect((await handleImages(imagesRequest({ prompt: "a cat" }), cfg, "generations", logContext(), undefined, UNSCOPED)).status).toBe(200);
  expect(upstreamInit.at(-1)?.proxy).toBe(false);
  cfg.providers["openai-apikey"]!.proxy = "invalid";
  await expect(handleImages(imagesRequest({ prompt: "a cat" }), cfg, "generations", logContext(), undefined, UNSCOPED)).rejects.toThrow();
  expect(upstreamCalls).toHaveLength(1);
});

test("a body that names no model cannot satisfy a model list", async () => {
  const response = await handleImages(
    imagesRequest({ prompt: "a cat" }),
    config({ allowedModels: ["gpt-image-1"] }),
    "generations",
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(403);
  expect((await denial(response)).model).toBe(UNNAMED_DESTINATION_MODEL);
  expect(upstreamCalls).toEqual([]);
});

test("naming the refusal marker in a scope grants nothing", async () => {
  // The marker is how a refusal says "nobody named a model". An operator who
  // copies it out of that refusal into allowedModels must not thereby allow
  // whatever the upstream would have picked.
  const response = await handleImages(
    imagesRequest({ prompt: "a cat" }),
    config({ allowedModels: [UNNAMED_DESTINATION_MODEL] }),
    "generations",
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(403);
  expect(upstreamCalls).toEqual([]);
});

test("standalone xAI image relay uses the selected provider route", async () => {
  const cfg = config({}, {
    images: { bridgeEnabled: true },
    providers: { xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "fixture-xai-key", authMode: "key", proxy: "http://proxy.test:3128" } },
  });
  await handleImages(imagesRequest({ prompt: "a cat" }), cfg, "generations", logContext(), undefined, UNSCOPED);
  expect(upstreamCalls).toEqual(["https://api.x.ai/v1/images/generations"]);
  expect(upstreamInit[0]?.proxy).toBe("http://proxy.test:3128/");
});

test("the xAI image bridge is a destination the scope covers", async () => {
  const response = await handleImages(
    imagesRequest({ model: "gpt-image-1", prompt: "a cat" }),
    config({ allowedProviders: ["openai-apikey"] }, {
      images: { bridgeEnabled: true },
      providers: {
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "fixture-xai-key", authMode: "key" },
      },
    } as Partial<OcxConfig>),
    "generations",
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(403);
  expect((await denial(response)).type).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
  expect(upstreamCalls).toEqual([]);
});

test("Antigravity image generation is refused on its own resolved model", async () => {
  const response = await handleImages(
    imagesRequest({ model: "gpt-image-1", prompt: "a cat" }),
    config({ allowedModels: ["gpt-image-1"] }, {
      providers: {
        "google-antigravity": {
          adapter: "google-antigravity",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
        },
      },
    } as Partial<OcxConfig>),
    "generations",
    logContext(),
    undefined,
    SCOPED,
  );
  // The caller asked for an allowed selector; the branch resolves a different
  // model on a different provider, which is the substitution the scope exists to catch.
  expect(response.status).toBe(403);
  expect(upstreamCalls).toEqual([]);
});

test("a key with no scope keeps reaching every image destination", async () => {
  const response = await handleImages(
    imagesRequest({ model: "gpt-image-1", prompt: "a cat" }),
    config({ allowedProviders: ["some-other-provider"] }),
    "generations",
    logContext(),
    undefined,
    UNSCOPED,
  );
  expect(response.status).toBe(200);
  expect(upstreamCalls).toHaveLength(1);
});
