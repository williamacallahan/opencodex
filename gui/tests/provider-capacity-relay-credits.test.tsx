import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderCapacityQuota } from "../src/components/provider-workspace/ProviderCapacityQuota";
import { LanguageProvider } from "../src/i18n/provider";

function render(quota: Record<string, unknown>): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <ProviderCapacityQuota pending={false} report={{ updatedAt: 123, quota: { updatedAt: 123, ...quota } }} />
    </LanguageProvider>,
  );
}

test("a pooling relay's report renders its pool windows and its purchased credit balance", () => {
  const markup = render({ weeklyPercent: 90.4, fiveHourPercent: 37.5, codexCredits: { balance: "52451.317714", unlimited: false } });
  expect(markup).toContain("quota-row--codex-credits");
  expect(markup).toContain("52,451.32");
  expect(markup).toContain("Credits");
});

test("a malformed relay balance renders no credits row", () => {
  const markup = render({ weeklyPercent: 10, codexCredits: { balance: "1e9" } });
  expect(markup).not.toContain("quota-row--codex-credits");
});
