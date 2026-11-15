import { TokenBreakdown } from "../components/token-breakdown";
import { formatTokens } from "../format-tokens";
import { useT } from "../i18n/shared";
import type { TokenBreakdownSource } from "../../../src/usage/token-breakdown";

/**
 * Tokens cell of a log row. The breakdown describes this request's own usage, so it sits beside
 * the per-request total; an absolute context checkpoint (Kiro) is a different measurement and
 * keeps the primary slot on its own.
 */
export function LogTokensCell({ requestTotal, contextTotal, usage, estimated, locale }: {
  requestTotal: number | undefined;
  contextTotal: number;
  usage: TokenBreakdownSource | undefined;
  estimated: boolean;
  locale: string;
}) {
  const t = useT();
  const prefix = estimated ? "~" : "";
  const separateCheckpoint = contextTotal !== requestTotal;
  return (
    <>
      <span>{prefix}{formatTokens(contextTotal, locale)}</span>
      {separateCheckpoint && requestTotal !== undefined && (
        <span className="text-[11.5px] leading-tight text-fg-subtle">{t("logs.detail.totalTokens")} {prefix}{formatTokens(requestTotal, locale)}</span>
      )}
      <TokenBreakdown source={usage ?? {}} locale={locale} variant="stack" />
    </>
  );
}
