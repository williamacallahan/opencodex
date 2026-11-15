import { tokenBreakdown, type TokenBreakdownSource } from "../../../src/usage/token-breakdown";

export interface TokenSplitContributor {
  /** The entry's per-request token total; `undefined` when it measured nothing. */
  total: number | undefined;
  usage?: TokenBreakdownSource;
}

export interface TokenSplitTotals {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Sum each split over exactly the entries that contributed to the total. A split is unknown only
 * when a contributor has a total but lacks that split, so an unmeasured request (no usage, no
 * total) cannot hide the breakdown of the requests that were measured.
 */
export function sumTokenSplits(entries: readonly TokenSplitContributor[]): TokenSplitTotals {
  const contributors = entries.filter(entry => entry.total !== undefined).map(entry => tokenBreakdown(entry.usage ?? {}));
  const sum = (pick: (split: ReturnType<typeof tokenBreakdown>) => number | undefined): number | undefined => {
    let total = 0;
    for (const split of contributors) {
      const part = pick(split);
      if (part === undefined) return undefined;
      total += part;
    }
    return contributors.length > 0 ? total : undefined;
  };
  const inputTokens = sum(split => split.sent);
  const outputTokens = sum(split => split.received);
  const cacheReadInputTokens = sum(split => split.cacheRead);
  const cacheCreationInputTokens = sum(split => split.cacheWrite);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
  };
}
