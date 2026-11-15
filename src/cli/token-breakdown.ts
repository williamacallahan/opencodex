import { tokenBreakdown, formatTokenShare, type TokenBreakdownSource } from "../usage/token-breakdown";

export const TOKEN_BREAKDOWN_HEADERS = ["Sent", "Received", "Cache read", "Cache write"];

export function tokenBreakdownCells(source: TokenBreakdownSource, formatCount: (count: number) => string): string[] {
  const breakdown = tokenBreakdown(source);
  const count = (value: number | undefined) => value === undefined ? "-" : formatCount(value);
  return [
    count(breakdown.sent),
    count(breakdown.received),
    `${count(breakdown.cacheRead)} (${formatTokenShare(breakdown.cacheReadShare)})`,
    breakdown.cacheWrite === undefined ? "not reported" : `${count(breakdown.cacheWrite)} (${formatTokenShare(breakdown.cacheWriteShare)})`,
  ];
}

export function tokenBreakdownLine(source: TokenBreakdownSource, formatCount: (count: number) => string): string {
  return tokenBreakdownCells(source, formatCount).map((cell, index) => `${TOKEN_BREAKDOWN_HEADERS[index]} ${cell}`).join(" | ");
}
