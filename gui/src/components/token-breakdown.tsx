import { formatTokenShare, tokenBreakdown, type TokenBreakdownSource } from "../../../src/usage/token-breakdown";
import { formatTokens } from "../format-tokens";
import { useT } from "../i18n/shared";

export function TokenBreakdown({ source, variant, locale }: { source: TokenBreakdownSource; variant: "stack" | "card" | "detail"; locale: string }) {
  const t = useT();
  const breakdown = tokenBreakdown(source);
  // A row with no measured usage shows its total alone; four em dashes would read as a measurement.
  if (breakdown.sent === undefined && breakdown.received === undefined && breakdown.cacheRead === undefined && breakdown.cacheWrite === undefined) return null;
  const count = (value: number | undefined) => value === undefined ? "—" : variant === "detail" ? new Intl.NumberFormat(locale).format(value) : formatTokens(value, locale);
  const sent = count(breakdown.sent);
  const received = count(breakdown.received);
  const read = count(breakdown.cacheRead);
  const write = count(breakdown.cacheWrite);
  const readShare = formatTokenShare(breakdown.cacheReadShare, locale);
  const writeShare = formatTokenShare(breakdown.cacheWriteShare, locale);
  const readOfSent = t("tokens.ofSent", { percent: readShare });
  const writeOfSent = t("tokens.ofSent", { percent: writeShare });
  const label = t("tokens.breakdownAria", { sent, received, read, write, readShare: readOfSent, writeShare: writeOfSent });
  if (variant === "stack") return (
    <span className="block text-right text-xs leading-4 text-fg-subtle tabular-nums" title={label} aria-label={label}>
      <span className="block">↑{sent} ↓{received}</span>
      <span className="block">c{read} {readShare}</span>
      <span className="block">w{write}{breakdown.cacheWrite !== undefined && ` ${writeShare}`}</span>
    </span>
  );
  if (variant === "card") return (
    <span className="block text-xs leading-4 text-fg-subtle tabular-nums">
      <span className="block">{t("tokens.sent")} {sent} · {t("tokens.received")} {received}</span>
      <span className="block">{t("tokens.cacheRead")} {read} · {readOfSent}</span>
      <span className="block">{breakdown.cacheWrite === undefined ? t("tokens.cacheWriteNotReported") : `${t("tokens.cacheWrite")} ${write} · ${writeOfSent}`}</span>
    </span>
  );
  return (
    <span className="block text-xs leading-4 text-fg-subtle tabular-nums">
      <span className="flex justify-between gap-4"><span>{t("tokens.sent")}</span><span>{sent}</span></span>
      <span className="flex justify-between gap-4"><span>{t("tokens.received")}</span><span>{received}</span></span>
      <span className="flex justify-between gap-4"><span>{t("tokens.cacheRead")}</span><span>{read} ({readOfSent})</span></span>
      {breakdown.cacheWrite === undefined
        ? <span className="block">{t("tokens.cacheWriteNotReported")}</span>
        : <span className="flex justify-between gap-4"><span>{t("tokens.cacheWrite")}</span><span>{write} ({writeOfSent})</span></span>}
      <span className="block">{t("tokens.cacheIncludedNote")}</span>
    </span>
  );
}
