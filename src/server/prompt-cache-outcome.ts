import { createHash } from "node:crypto";
import { baseProviderLabel } from "../providers/label";
import { classifyCacheTelemetryProvenance, type CacheTelemetryProvenance, type UsageStatus } from "../usage/log";
import type { OcxUsage } from "../types";

/**
 * One `prompt_cache.outcome` line per finished request, with the field names and meanings of the
 * LLM gateway's event of the same name, so this hub's cache hit rate is recorded and alerted on by
 * the same queries. Field semantics: `prompt_tokens` is the whole prompt including cache reads and
 * writes, `cached_tokens` the reads, `cache_eligible` marks the turns that could have hit.
 */

// Copied from llm-gateway backend/app/common/prompt_cache_eligibility.py. First match wins; a
// dated snapshot continues the prefix with "-".
const DEFAULT_MIN_CACHEABLE_PROMPT_TOKENS = 1024;
const ANTHROPIC_MINIMUMS: ReadonlyArray<readonly [string, number]> = [
  ["claude-mythos-preview", 2048], ["claude-sonnet-5-5", 512], ["claude-haiku-5-5", 512], ["claude-opus-5-5", 512],
  ["claude-opus-4-8", 1024], ["claude-opus-4-7", 2048], ["claude-opus-4-6", 4096], ["claude-opus-4-5", 4096],
  ["claude-opus-4-1", 1024], ["claude-haiku-4-5", 4096], ["claude-haiku-3-5", 2048], ["claude-3-5-haiku", 2048],
  ["claude-sonnet-4", 1024], ["claude-mythos-5", 512], ["claude-fable-5", 512], ["claude-sonnet-5", 1024],
  ["claude-opus-5", 512], ["claude-opus-4", 1024],
];

export function minimumCacheablePromptTokens(model: string): number {
  const id = model.trim().toLowerCase().split("/").at(-1)!.split(":")[0]!.replaceAll(".", "-");
  if (id.startsWith("gemini-")) return id.startsWith("gemini-2-") ? 2048 : 4096;
  for (const [prefix, minimum] of ANTHROPIC_MINIMUMS) {
    if (id === prefix || id.startsWith(`${prefix}-`)) return minimum;
  }
  return DEFAULT_MIN_CACHEABLE_PROMPT_TOKENS;
}

/** Pool dispatch logs `anthropic-<seat>` / `openai-main`; the existing label owner maps them to the family. */
export function providerFamily(provider: string): string {
  return baseProviderLabel(provider);
}

const TELEMETRY: Record<CacheTelemetryProvenance, "reported" | "missing" | "unavailable"> = {
  observed: "reported", unknown: "missing", synthesized: "unavailable",
};

export interface PromptCacheOutcomeInput {
  provider: string;
  requestedModel: string;
  servedModel: string;
  usage: OcxUsage | undefined;
  usageStatus: UsageStatus;
  wireParsed: boolean;
  /** The serving adapter's wire carries the cache fields natively (Anthropic Messages, OpenAI Responses). */
  nativeCacheWire: boolean;
  succeeded: boolean;
  locallyAnswered: boolean;
  comboParent: boolean;
  conversationId?: string;
}

/** The whole prompt: inputTokens already includes cache detail; a raw additive report is completed here. */
function promptTokens(usage: OcxUsage | undefined): number {
  if (!usage) return 0;
  const reads = usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? 0;
  const writes = usage.cacheCreationInputTokens ?? 0;
  return reads + writes > usage.inputTokens ? usage.inputTokens + reads + writes : usage.inputTokens;
}

function logfmtValue(value: string | number | boolean): string {
  const text = String(value);
  return /^[A-Za-z0-9_.:\-/@]+$/.test(text) ? text : JSON.stringify(text);
}

export function promptCacheOutcomeLine(input: PromptCacheOutcomeInput): string {
  const provenance = classifyCacheTelemetryProvenance(input.usage, { wireParsed: input.wireParsed });
  // An all-zero detail read off a wire is ambiguous only where a bridge could have written zero
  // defaults. A native wire's own cached field of 0 is a measured miss: leaving it out of the
  // denominator would let a total cache collapse silence the hit-rate alert.
  const telemetry = provenance === "synthesized" && input.nativeCacheWire ? "reported" : TELEMETRY[provenance];
  const prompt = promptTokens(input.usage);
  const family = providerFamily(input.provider);
  const cached = input.usage?.cacheReadInputTokens ?? input.usage?.cachedInputTokens;
  const eligible = input.succeeded && !input.locallyAnswered && !input.comboParent
    && input.usageStatus === "reported" && telemetry === "reported"
    && prompt >= minimumCacheablePromptTokens(input.servedModel);
  const fields: Array<[string, string | number | boolean | undefined]> = [
    ["event", "prompt_cache.outcome"],
    ["provider_name", family],
    ["provider_id", input.provider],
    ["namespace", family],
    ["requested_model", input.requestedModel],
    ["served_model", input.servedModel],
    ["telemetry", telemetry],
    ["cache_eligible", eligible],
    ["prompt_tokens", prompt],
    ["cached_tokens", cached ?? 0],
    ["cache_write_tokens", input.usage?.cacheCreationInputTokens ?? 0],
    ["key_hash", input.conversationId
      ? createHash("sha256").update(input.conversationId).digest("hex").slice(0, 16) : undefined],
  ];
  return `[opencodex] level=info ${fields.filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${logfmtValue(value!)}`).join(" ")}`;
}
