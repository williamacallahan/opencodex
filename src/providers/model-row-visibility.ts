import type { OcxConfig } from "../types";
import { COMBO_NAMESPACE, comboDisabledModelSelectors } from "../combos/identifiers";
import { antigravityFamilyDisabled, projectAntigravitySelectedModels, type AntigravityEffortFamilyRow } from "./antigravity-effort-families";
import { initialModelSelectionPending } from "./initial-model-selection";
import { routedSlug, slugEquals, slugEquivalenceKey } from "./slug-codec";

/**
 * The one owner of "this model row is switched off". The catalog hides a row by it and the data
 * plane refuses a client that names the row by it, so nothing is hidden without also being refused.
 */
export interface ModelRowIdentity extends AntigravityEffortFamilyRow {
  /** Public alias a combo or alias row is listed under. */
  alias?: string;
  nativeAlias?: boolean;
}

type VisibilityConfig = Pick<OcxConfig, "disabledModels" | "providers" | "modelDiscovery">;

/** The provider's `selectedModels` allowlist as slug-equivalence keys; undefined when none is set. */
export function selectionAllowSet(
  config: Pick<OcxConfig, "providers">,
  provider: string,
  rows: readonly AntigravityEffortFamilyRow[] = [],
): ReadonlySet<string> | undefined {
  const selected = config.providers[provider]?.selectedModels;
  // Keyed the way `sync.ts` keys the same list, so a slash-bearing native id and the encoded slug
  // the Codex picker displays are one entry (the key is deliberately lossy, see the catalog tests).
  return Array.isArray(selected) && selected.length > 0
    ? new Set(projectAntigravitySelectedModels(provider, selected, rows).map(id => slugEquivalenceKey(routedSlug(provider, id))))
    : undefined;
}

/** Whether a provider's model row is disabled, pending first selection, outside its allowlist or in a disabled family. */
export function modelRowHidden(
  config: VisibilityConfig,
  row: ModelRowIdentity,
  rows: readonly AntigravityEffortFamilyRow[] = [],
  allow: ReadonlySet<string> | undefined = selectionAllowSet(config, row.provider, rows),
): boolean {
  const provider = config.providers[row.provider];
  if (initialModelSelectionPending(provider) || provider?.disabled === true) return true;
  if (antigravityFamilyDisabled(config, row, rows)) return true;
  const nativeAlias = row.provider === COMBO_NAMESPACE && row.nativeAlias === true;
  // disabledModels may be stored raw (canonical) or encoded (legacy UI writes). Combo management
  // stores the public alias, while canonical `combo/<id>` references stay valid through slugEquals.
  for (const stored of config.disabledModels ?? []) {
    if (row.alias !== undefined && stored === row.alias && !nativeAlias) return true;
    if (slugEquals(stored, row.provider, row.id)) return true;
  }
  return allow !== undefined && !allow.has(slugEquivalenceKey(routedSlug(row.provider, row.id)));
}

/** Whether any persisted selector of this combo is disabled. */
export function comboRowDisabled(
  config: Pick<OcxConfig, "combos" | "disabledModels">,
  comboId: string,
): boolean {
  const disabled = new Set(config.disabledModels ?? []);
  return comboDisabledModelSelectors(comboId, config.combos?.[comboId] ?? {}).some(selector => disabled.has(selector));
}

/** A native (provider-less) slug or an account-qualified native selector stored in disabledModels. */
export function nativeSelectorDisabled(config: Pick<OcxConfig, "disabledModels">, ...selectors: string[]): boolean {
  const disabled = new Set(config.disabledModels ?? []);
  return selectors.some(selector => disabled.has(selector));
}

/**
 * Selectors of one provider that the hub's own settings have clients name: the featured sub-agent
 * roster, the injection model and the role-tier lists. A client naming one is refused when the
 * provider's `selectedModels` omits it, so a write that omits any is refused up front.
 */
export function hubNamedSelectors(
  config: Pick<OcxConfig, "subagentModels" | "injectionModel" | "codexRoleTiers">,
  provider: string,
): string[] {
  const named = [
    ...(config.subagentModels ?? []),
    ...(config.injectionModel ? [config.injectionModel] : []),
    ...Object.values(config.codexRoleTiers ?? {}).flat(),
  ];
  return [...new Set(named.filter((selector): selector is string => typeof selector === "string" && selector.startsWith(provider + "/")))];
}

/** The hub-named selectors a proposed `selectedModels` list for this provider would leave out. */
export function selectionOmittedHubSelectors(
  config: Pick<OcxConfig, "subagentModels" | "injectionModel" | "codexRoleTiers">,
  provider: string,
  proposed: readonly string[],
): string[] {
  const kept = new Set(proposed.map(id => slugEquivalenceKey(routedSlug(provider, id))));
  return hubNamedSelectors(config, provider).filter(selector => !kept.has(slugEquivalenceKey(selector)));
}
