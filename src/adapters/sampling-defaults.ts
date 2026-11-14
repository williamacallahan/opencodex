import { modelInList, type OcxProviderConfig } from "../types";

type Sampling = { temperature?: number | null; topP?: number | null };

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
  const records = provider.modelSamplingDefaults;
  const defaults = records && (Object.hasOwn(records, modelId) ? records[modelId]
    : catalogModelId && Object.hasOwn(records, catalogModelId) ? records[catalogModelId] : undefined);
  return {
    temperature: client.temperature ?? defaults?.temperature,
    topP: client.topP ?? defaults?.topP,
  };
}
