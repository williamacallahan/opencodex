import { MODEL_ADAPTER_OVERRIDE_ALLOWED, modelIdsInList, type OcxProviderConfig } from "../types";
import { isCanonicalOpenAiForwardProvider, isOpenAiOperatedResponsesDestination, responsesTransportUrl } from "../providers/openai-tiers-destination";

type Sampling = { temperature?: number | null; topP?: number | null };

export function rejectsSamplingDefaults(provider: OcxProviderConfig, modelId: string): boolean {
  if (isCanonicalOpenAiForwardProvider(provider)) return true;
  // OpenAI's GPT-6.2 migration guide explicitly excludes both sampling fields.
  // A relay can also route other models to external sources; don't assume they reject sampling.
  if (modelId !== "gpt-6.2-sol" && modelId !== "gpt-6.2-astra") return false;
  const override = provider.modelAdapters?.[modelId];
  const adapter = override && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(override) ? override : provider.adapter;
  if (adapter !== "openai-responses") return false;
  const responsesProvider = adapter === provider.adapter ? provider : { ...provider, adapter };
  if (isOpenAiOperatedResponsesDestination(responsesProvider)) return true;
  const destination = URL.parse(responsesTransportUrl(responsesProvider));
  return (provider.authMode ?? "key") === "key" && destination?.protocol === "https:"
    && !destination.username && !destination.password && !destination.search && !destination.hash
    && (destination.pathname === "/backend-api/codex/responses" || destination.pathname === "/backend-api/codex/v1/responses");
}

export function applyChatSamplingDefaults(
  body: Record<string, unknown>, provider: OcxProviderConfig, modelId: string, client: Sampling,
): void {
  const sampling = resolveSamplingDefaults(provider, String(body.model), client, modelId);
  const sentIds = [modelId, String(body.model)];
  if (sampling.temperature !== undefined && !modelIdsInList(provider.noTemperatureModels, sentIds)) {
    body.temperature = sampling.temperature;
  }
  if (sampling.topP !== undefined && !modelIdsInList(provider.noTopPModels, sentIds)) {
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
