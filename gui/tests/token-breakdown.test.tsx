import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TokenBreakdown } from "../src/components/token-breakdown";
import { LanguageProvider } from "../src/i18n/provider";

const source = { inputTokens: 57_400, outputTokens: 600, cacheReadInputTokens: 51_000, cacheCreationInputTokens: 2_000 };

for (const variant of ["stack", "card", "detail"] as const) {
  test(`${variant} renders both cache shares`, () => {
    const markup = renderToStaticMarkup(<LanguageProvider><TokenBreakdown source={source} variant={variant} locale="en" /></LanguageProvider>);
    expect(markup).toContain("88.9%");
    expect(markup).toContain("3.5%");
  });
}

test("unreported cache writes and missing sent tokens stay unknown", () => {
  const markup = renderToStaticMarkup(<LanguageProvider><TokenBreakdown source={{ outputTokens: 600 }} variant="card" locale="en" /></LanguageProvider>);
  expect(markup).toContain("—");
  expect(markup).toContain("Cache write: not reported");
  const stack = renderToStaticMarkup(<LanguageProvider><TokenBreakdown source={{ inputTokens: 57_400 }} variant="stack" locale="en" /></LanguageProvider>);
  expect(stack).toContain("w—");
});
