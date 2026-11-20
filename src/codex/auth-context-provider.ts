import { TURN_STATE_OWNER, type TurnStateConstrained } from "../server/turn-state-handles";
import type { OcxProviderConfig } from "../types";

export type OcxRuntimeProviderConfig = OcxProviderConfig & TurnStateConstrained & {
  _codexAccountOverride?: { accessToken: string; chatgptAccountId: string; kind?: "pool" | "main-pool"; poolReserve?: true };
  _codexAccountRequired?: boolean;
};

export function stripCodexRuntimeProviderFields(provider: OcxProviderConfig): OcxProviderConfig {
  const {
    [TURN_STATE_OWNER]: _owner,
    _codexAccountOverride: _override,
    _codexAccountRequired: _required,
    ...safeProvider
  } = provider as OcxRuntimeProviderConfig;
  return safeProvider;
}
