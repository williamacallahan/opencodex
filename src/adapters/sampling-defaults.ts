import { modelInList, type OcxProviderConfig } from "../types";
import { isCanonicalOpenAiForwardProvider, isOpenAiOperatedResponsesDestination } from "../providers/openai-tiers-destination";
import { isCodexLbResponsesEndpoint } from "../providers/quota/codex-lb-url";

type Sampling = { temperature?: number | null; topP?: number | null };

export function rejectsSamplingDefaults(provider: OcxProviderConfig, modelId: string): boolean {
  if (isCanonicalOpenAiForwardProvider(provider)) return true;
  // OpenAI's GPT-6.2 migration guide explicitly excludes both sampling fields.
  // A relay can also route other models to external sources; don't assume they reject sampling.
  return (modelId === "gpt-6.2-sol" || modelId === "gpt-6.2-astra")
    && (isOpenAiOperatedResponsesDestination(provider) || isCodexLbResponsesEndpoint(provider, provider.adapter));
}

export function applyChatSamplingDefaults(
  body: Record<string, unknown>, provider: OcxProviderConfig, modelId: string, client: Sampling,
): void {
  const sampling = resolveSamplingDefaults(provider, String(body.model), client, modelId);
  if (sampling.temperature !== undefined && !modelInList(provider.noTemperatureModels, modelId)) {
    body.temperature = sampling.temperature;
  }
  if (sampling.topP !== undefined && !modelInList(provider.noTopPModels, modelId)) {
    body.top_p = sampling.topP;
  }
}

/** Fill missing client sampling values from the selected upstream model, then its catalog id. */
export function resolveSamplingDefaults(
  provider: OcxProviderConfig,
  modelId: string,
  client: Sampling,
  catalogModelId?: string,
): { temperature?: number; topP?: number } {
  const records = rejectsSamplingDefaults(provider, modelId) ? undefined : provider.modelSamplingDefaults;
  const defaults = records && (Object.hasOwn(records, modelId) ? records[modelId]
    : catalogModelId && Object.hasOwn(records, catalogModelId) ? records[catalogModelId] : undefined);
  return {
    temperature: client.temperature ?? defaults?.temperature,
    topP: client.topP ?? defaults?.topP,
  };
}
