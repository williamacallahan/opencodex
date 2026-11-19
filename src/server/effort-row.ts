import { comboModelId, comboPublicModelId } from "../combos/types";
import { detectCursorInstalls } from "../integrations/cursor-detect";
import {
  loadCursorEffortTable,
  type CursorEffortTable,
} from "../integrations/cursor-effort-table";
import {
  canonicalizeReasoningEfforts,
  configuredReasoningEfforts,
  isDeclaredReasoningEffort,
} from "../reasoning-effort";
import { hasOwnProvider } from "../config/provider-name";
import { resolveModelAlias } from "../providers/default-aliases";
import { knownModelIdsForProvider, previewRouteModel } from "../router";
import { policyModelId, policyPublicModelId } from "../routing/profile";
import type { OcxConfig } from "../types";
import { routedSlug } from "../providers/slug-codec";
import { predictCursorEffort } from "./models-capabilities";

const EFFORT_ROW_SEPARATOR = "--";
const NO_REASONING_ROW_SUFFIX = `${EFFORT_ROW_SEPARATOR}none`;

export interface ParsedEffortRowId {
  baseId: string;
  effort: string;
}

export type EffortRowKnownIds = ReadonlySet<string> | ((id: string) => boolean);

export interface EffortRowOptions {
  knownIds?: EffortRowKnownIds;
  table?: CursorEffortTable | null;
  supportsReasoning?: boolean;
}

export function isKnownId(knownIds: EffortRowKnownIds | undefined, id: string): boolean {
  return typeof knownIds === "function"
    ? knownIds(id)
    : knownIds?.has(id) === true || knownIds?.has(id.toLowerCase()) === true;
}

export function effortRowId(baseId: string, effort: string): string {
  return `${baseId}${EFFORT_ROW_SEPARATOR}${effort}`;
}

/**
 * Exact configured/public ids that must beat the synthetic terminal-suffix grammar.
 * This is request-local because live-model cache contents can change while the server runs.
 */
export function knownEffortRowIds(config: OcxConfig): Set<string> {
  const ids = new Set<string>();
  const addAlias = (id: string): void => {
    ids.add(id);
    // Model aliases are resolved case-insensitively. Preserve that contract here so an
    // alias cannot be mistaken for a synthetic effort row before ordinary routing runs.
    ids.add(id.toLowerCase());
  };
  for (const [providerName, provider] of Object.entries(config.providers)) {
    const known = knownModelIdsForProvider(providerName, provider, config);
    const namespaces = [providerName, provider.alias].filter((value): value is string => (
      typeof value === "string" && value.length > 0
    ));
    for (const id of known) {
      ids.add(id);
      ids.add(routedSlug(providerName, id));
      for (const namespace of namespaces) ids.add(`${namespace}/${id}`);
    }
    for (const alias of Object.values(provider.modelAliases ?? {})) {
      addAlias(alias);
      for (const namespace of namespaces) addAlias(`${namespace}/${alias}`);
    }
  }
  for (const [id, combo] of Object.entries(config.combos ?? {})) {
    ids.add(comboModelId(id));
    ids.add(comboPublicModelId(id, combo));
  }
  for (const [id, profile] of Object.entries(config.routingProfiles ?? {})) {
    ids.add(policyModelId(id));
    ids.add(policyPublicModelId(id, profile));
  }
  return ids;
}

/** Resolve the installed Private Inference effort table once for the current request. */
export function loadDetectedCursorEffortTable(): CursorEffortTable | null {
  const privateInference = detectCursorInstalls().find(install => install.build === "private-inference");
  return loadCursorEffortTable(privateInference);
}

export function parseEffortRowId(
  id: string,
  config: Pick<OcxConfig, "cursorEffortRows">,
  options: EffortRowOptions = {},
): ParsedEffortRowId | null {
  if (config.cursorEffortRows !== true || isKnownId(options.knownIds, id)) return null;

  const separator = id.lastIndexOf(EFFORT_ROW_SEPARATOR);
  if (separator <= 0) return null;
  const baseId = id.slice(0, separator);
  const effort = id.slice(separator + EFFORT_ROW_SEPARATOR.length);
  // Cursor rows don't advertise none. A fully qualified, explicitly declared none has its own check.
  if (effort === "none" || !isDeclaredReasoningEffort(effort)) return null;
  if (predictCursorEffort(baseId, options.table ?? null, options.supportsReasoning).ladder !== null) {
    return null;
  }
  return { baseId, effort };
}

/** A model-only client can explicitly turn off reasoning for a proven routed model. */
export function parseNoReasoningEffortRowId(id: string, config: OcxConfig): ParsedEffortRowId | null {
  if (!id.endsWith(NO_REASONING_ROW_SUFFIX)) return null;
  const baseId = id.slice(0, -NO_REASONING_ROW_SUFFIX.length);
  const slash = baseId.indexOf("/");
  if (slash <= 0) return null;
  const providerName = baseId.slice(0, slash);
  const modelId = baseId.slice(slash + 1);
  if (!hasOwnProvider(config.providers, providerName)) return null;
  const provider = config.providers[providerName];
  const ladders = provider.modelReasoningEfforts;
  if (!ladders || !Object.hasOwn(ladders, modelId) || !ladders[modelId]?.includes("none")) return null;

  const known = knownModelIdsForProvider(providerName, provider, config);
  const requestedModel = id.slice(slash + 1);
  if (!known.includes(modelId) || isKnownId(knownEffortRowIds(config), id)
    || provider.retainModels?.includes(requestedModel) || Object.hasOwn(provider.modelDisplayNames ?? {}, requestedModel)
    || resolveModelAlias(config, provider, known, requestedModel, providerName)) return null;
  try {
    const route = previewRouteModel(config, baseId);
    if (route.routeKind === "explicit-provider" && route.providerName === providerName && route.modelId === modelId
      && configuredReasoningEfforts(route.provider, modelId, { refreshMetadata: false })?.includes("none")) {
      return { baseId, effort: "none" };
    }
  } catch {
    // A disabled or unavailable base cannot claim this selector; leave the original ID to routing.
    return null;
  }
  return null;
}

/** Parse one ingress selector against the current config and installed Cursor table. */
export function parseRequestEffortRowId(id: string, config: OcxConfig): ParsedEffortRowId | null {
  if (config.cursorEffortRows !== true) return null;
  // Ordinary ids carry no separator; bail before the known-id scan and install detection so
  // the flag costs nothing on the request path for models that are not effort rows.
  if (id.lastIndexOf(EFFORT_ROW_SEPARATOR) <= 0) return null;
  return parseEffortRowId(id, config, {
    knownIds: knownEffortRowIds(config),
    table: loadDetectedCursorEffortTable(),
  });
}

export function expandCursorEffortRow<T extends { id: string }>(
  row: T,
  efforts: readonly string[] | undefined,
  config: Pick<OcxConfig, "cursorEffortRows">,
  options: EffortRowOptions = {},
): T[] {
  if (config.cursorEffortRows !== true) return [row];

  const supported = canonicalizeReasoningEfforts(
    (efforts ?? []).filter(effort => effort !== "none" && isDeclaredReasoningEffort(effort)),
  );
  const supportsReasoning = options.supportsReasoning ?? supported.length > 0;
  if (predictCursorEffort(row.id, options.table ?? null, supportsReasoning).ladder !== null) {
    return [row];
  }
  return [
    row,
    ...supported
      .map(effort => effortRowId(row.id, effort))
      .filter(id => !isKnownId(options.knownIds, id))
      .map(id => ({ ...row, id })),
  ];
}
