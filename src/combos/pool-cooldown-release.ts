import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../codex/catalog/native-models";
import { modelHasPoolReserve, poolLunaReserveSelection } from "../codex/pool-reserve";
import { codexQuotaScopeForModel } from "../codex/routing";
import { getEligiblePoolAccounts } from "../codex/routing/selection";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers-destination";
import { providerCodexAccountMode } from "../providers/registry";
import type { OcxConfig } from "../types";
import { clearComboTargetCooldownIfUnchanged, comboTargetRateLimitCooldownRevision } from "./failover";
import type { NormalizedComboConfig } from "./types";

/**
 * Lift a combo's 429 cooldown on the native Codex pool target once the pool can serve again.
 *
 * When every pool account is spent, the pool's own refusal cools the target so the combo stops
 * asking it, and that refusal can carry a Retry-After of a day. The pool, not the combo, owns
 * per-account quota: an account whose weekly window resets becomes eligible again, and the stale
 * target cooldown would otherwise keep every turn on a lower target until the day ran out. On
 * 2026-11-20 one account reset at 06:04Z while the Sol, Terra and Astra combos stayed cooled
 * until the next day.
 *
 * Only a pool-served `openai` row qualifies: in direct mode the caller's own login serves the
 * turn and pool eligibility says nothing about it. Account-gated models and accounts the pool is
 * holding back for recovery are refused by the request path even when eligible here, so they
 * keep their cooldown.
 */
export function releaseRecoveredPoolQuotaCooldowns(
  config: OcxConfig,
  comboId: string,
  combo: NormalizedComboConfig,
  now: number,
): void {
  const row = config.providers[OPENAI_CODEX_PROVIDER_ID];
  if (!row || row.disabled === true || !isCanonicalOpenAiForwardProvider(row)
    || providerCodexAccountMode(OPENAI_CODEX_PROVIDER_ID, row) !== "pool") return;
  for (const target of combo.targets) {
    if (target.provider !== OPENAI_CODEX_PROVIDER_ID) continue;
    if (ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(target.model.toLowerCase().split("/").at(-1) ?? "")) continue;
    const revision = comboTargetRateLimitCooldownRevision(comboId, target, now);
    if (revision === undefined) continue;
    const scope = codexQuotaScopeForModel(target.model);
    const reserve = modelHasPoolReserve(target.model)
      ? poolLunaReserveSelection(config, target.model, scope, {}, undefined, undefined, now)
      : undefined;
    if ((reserve?.reserve && getEligiblePoolAccounts(config, undefined, now, reserve.quotaScope, reserve.options, true).length > 0)
      || getEligiblePoolAccounts(config, undefined, now, scope, undefined, true).length > 0) {
      clearComboTargetCooldownIfUnchanged(comboId, target, revision);
    }
  }
}
