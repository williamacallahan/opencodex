import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../codex/catalog/native-models";
import { modelHasPoolReserve, poolLunaReserveSelection } from "../codex/pool-reserve";
import { codexQuotaScopeForModel } from "../codex/routing";
import { getEligiblePoolAccounts } from "../codex/routing/selection";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers-destination";
import type { routeConcreteModel } from "../router";
import type { OcxComboTarget, OcxConfig } from "../types";
import { comboTargetRateLimitCooldownRevision } from "./failover";

/** Capacity can offer a cooled target, but only dispatch can prove this request could use it. */
export function poolQuotaCooldownRevision(
  config: OcxConfig,
  comboId: string,
  target: OcxComboTarget,
  now: number,
  lookup?: typeof routeConcreteModel,
): number | undefined {
  if (!lookup || target.provider !== OPENAI_CODEX_PROVIDER_ID) return undefined;
  const revision = comboTargetRateLimitCooldownRevision(comboId, target, now);
  if (revision === undefined) return undefined;
  let route: ReturnType<typeof routeConcreteModel>;
  try {
    route = lookup(config, `${target.provider}/${target.model}`);
  } catch {
    // A concrete route that cannot resolve supplies no capacity evidence for early dispatch.
    return undefined;
  }
  if (route.providerName !== OPENAI_CODEX_PROVIDER_ID || route.codexAccountMode !== "pool"
    || route.codexAccountId !== undefined || !isCanonicalOpenAiForwardProvider(route.provider)
    || ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(route.modelId)) return undefined;
  const scope = codexQuotaScopeForModel(route.modelId);
  if (modelHasPoolReserve(route.modelId)
    && poolLunaReserveSelection(config, route.modelId, scope, {}, undefined, undefined, now).reserve) return revision;
  return getEligiblePoolAccounts(config, undefined, now, scope, undefined, true).length > 0 ? revision : undefined;
}
