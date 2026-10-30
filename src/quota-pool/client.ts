import type { OcxConfig } from "../types";
import type { DataPlaneAdmission } from "../server/auth-cors";
import { resolveAdmissionModelScope, routeAllowedByScope } from "../server/admission-model-scope";
import { readQuotaPool } from "./assemble";
import type { QuotaPoolWindow } from "./contract";

/** A client can see provider quota windows, never account identity or another client's usage. */
export async function readClientCapacity(config: OcxConfig, admission: DataPlaneAdmission) {
  const scope = resolveAdmissionModelScope(config, admission);
  // A model name alone does not prove that a provider serves it. Require an explicit
  // provider grant before exposing its pool to a model-restricted client.
  if (scope?.models.length && !scope.providers.length) {
    return { available: false as const, reason: "provider_scope_required" as const };
  }
  const result = await readQuotaPool(config);
  if (!result.ok) return { available: false as const, reason: result.error };
  return {
    available: true as const,
    generatedAt: result.pool.generatedAt,
    // Never sum gateways or providers: a delegated route may consume the same account pool.
    aggregation: "per-provider" as const,
    providers: result.pool.providers
      .filter(row => !scope?.providers.length || scope.providers.includes(row.provider.toLowerCase()))
      .map(row => ({
        provider: row.provider,
        windows: row.pooled.windows
          .filter(window => !window.scopeModel || routeAllowedByScope(scope, {
            providerName: row.provider, modelId: window.scopeModel,
          }))
          .map(({ id, kind, usedPercent, used, limit, unit, resetsAt, windowSeconds, scopeModel, source, observedAt, exhausted }) => ({
            id, kind, usedPercent, used, limit, unit, resetsAt, windowSeconds, scopeModel, source, observedAt, exhausted,
          } satisfies Omit<QuotaPoolWindow, "label">)),
      })),
  };
}
