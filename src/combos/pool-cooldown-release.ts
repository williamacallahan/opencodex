import { codexQuotaScopeForModel } from "../codex/routing";
import { getEligiblePoolAccounts } from "../codex/routing/selection";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
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
 */
export function releaseRecoveredPoolQuotaCooldowns(
  config: OcxConfig,
  comboId: string,
  combo: NormalizedComboConfig,
  now: number,
): void {
  for (const target of combo.targets) {
    if (target.provider !== OPENAI_CODEX_PROVIDER_ID) continue;
    const revision = comboTargetRateLimitCooldownRevision(comboId, target, now);
    if (revision === undefined) continue;
    if (getEligiblePoolAccounts(config, undefined, now, codexQuotaScopeForModel(target.model)).length > 0) {
      clearComboTargetCooldownIfUnchanged(comboId, target, revision);
    }
  }
}
