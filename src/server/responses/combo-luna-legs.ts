import { targetKey, type getCombo } from "../../combos";
import { modelHasPoolReserve } from "../../codex/pool-reserve";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { isCodexLbProvider } from "../../providers/quota/codex-lb-url";
import type { RouteResult } from "../../router";
import type { OcxConfig } from "../../types";

type Combo = NonNullable<ReturnType<typeof getCombo>>;
type ComboTarget = Combo["targets"][number];

const notStarted = new WeakSet<object>();
/** The transport proved this attempt's request never reached the host: a connect failure before any byte. */
export const markUpstreamNotStarted = (attemptLog: object): void => { notStarted.add(attemptLog); };

/**
 * Where a failover combo orders its native ChatGPT pool around a relay that fronts its own pool:
 * native Reserve (strict), then the relay, then native ordinary Luna, then the remaining targets.
 * Without this order a Reserve refusal let the native target spend ordinary Luna, so the relay's
 * own Reserve was never offered.
 */
export interface LunaReserveLegPlan {
  nativeKey: string;
  relayKey: string;
  /** Declared targets plus the extra native ordinary leg, for the shared send budget. */
  legCount: number;
}

export function planLunaReserveLegs(
  config: OcxConfig,
  combo: Combo,
  portable: () => boolean,
  resolve: (target: ComboTarget) => RouteResult | undefined,
  eligible: (target: ComboTarget) => boolean,
  hopAllowed: (from: ComboTarget, to: ComboTarget) => boolean,
): LunaReserveLegPlan | undefined {
  // Configured model ids are enough to rule out every other combo before any route is resolved.
  if (combo.strategy !== "failover" || !combo.targets.some(target => modelHasPoolReserve(target.model)) || !portable()) return undefined;
  const nativeIndex = combo.targets.findIndex(target => {
    if (!modelHasPoolReserve(target.model)) return false;
    const route = resolve(target);
    return route?.codexAccountMode === "pool" && isCanonicalOpenAiForwardProvider(route.provider);
  });
  const native = combo.targets[nativeIndex];
  const relay = combo.targets[nativeIndex + 1];
  const relayProvider = relay && config.providers[relay.provider];
  if (!native || !relay || !relayProvider || relay.metered || !modelHasPoolReserve(relay.model) || !isCodexLbProvider(relayProvider)
    || !eligible(native) || !eligible(relay)
    // Both added hops must pass fallback policy, or a strict-Reserve refusal would end in fallback_refused where native ordinary Luna used to serve.
    || !hopAllowed(native, relay) || !hopAllowed(relay, native)) return undefined;
  return { nativeKey: targetKey(native), relayKey: targetKey(relay), legCount: combo.targets.length + 1 };
}

/** Only evidence that the relay never received the turn lets native ordinary Luna send it again. */
export const relayProvedNotStarted = (attemptLog: object, sendCount: number): boolean => sendCount === 0 || notStarted.has(attemptLog);
