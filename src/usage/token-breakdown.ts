/**
 * The four-way split shown beside every token total, and each cache component's share of sent.
 *
 * `sent` is the whole prompt (`inputTokens`), which already includes cache reads and cache writes
 * (see `OcxUsage` in `src/types/request.ts`), so the two shares are fractions of one denominator
 * and the cache counts are never added to a total again. The CLI and the dashboard both render
 * from this module so the same row cannot show two different percentages.
 */
export interface TokenBreakdownSource {
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Explicit cache-read split; preferred over the legacy `cachedInputTokens` alias for reads. */
  cacheReadInputTokens?: number | null;
  cachedInputTokens?: number | null;
  /** Absent means the upstream reported no cache-write count, which is not the same as zero. */
  cacheCreationInputTokens?: number | null;
}

export interface TokenBreakdown {
  sent: number | undefined;
  received: number | undefined;
  cacheRead: number | undefined;
  /** `undefined` is "not reported". */
  cacheWrite: number | undefined;
  /** Fraction of `sent`, 0..1; `undefined` when `sent` is zero or unknown, or the count is unknown. */
  cacheReadShare: number | undefined;
  cacheWriteShare: number | undefined;
}

function count(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function shareOf(part: number | undefined, sent: number | undefined): number | undefined {
  if (part === undefined || sent === undefined || sent <= 0) return undefined;
  return Math.min(1, part / sent);
}

export function tokenBreakdown(source: TokenBreakdownSource): TokenBreakdown {
  const sent = count(source.inputTokens);
  const cacheRead = count(source.cacheReadInputTokens) ?? count(source.cachedInputTokens);
  const cacheWrite = count(source.cacheCreationInputTokens);
  return {
    sent,
    received: count(source.outputTokens),
    cacheRead,
    cacheWrite,
    cacheReadShare: shareOf(cacheRead, sent),
    cacheWriteShare: shareOf(cacheWrite, sent),
  };
}

/**
 * A share as a percentage with at most one decimal. A positive share that would round to 0 reads
 * `<1%` and one that would round to 100 without being exactly 1 reads `<100%`, so neither end
 * claims more than the counts prove. An unknown share is an em dash.
 */
export function formatTokenShare(share: number | undefined, locale?: string): string {
  if (share === undefined) return "—";
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  if (share > 0 && share < 0.01) return `<${percent.format(0.01)}`;
  if (share < 1 && share >= 0.9995) return `<${percent.format(1)}`;
  return percent.format(share);
}
