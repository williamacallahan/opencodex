import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TokenBreakdown } from "../src/components/token-breakdown";
import { LanguageProvider } from "../src/i18n/provider";
import { LogTokensCell } from "../src/pages/logs-token-cell";
import { sumTokenSplits } from "../src/pages/logs-token-split";

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

test("conversation splits sum over contributing entries only and stay unknown when a contributor lacks one", () => {
  const measured = { total: 110, usage: { inputTokens: 100, outputTokens: 10 } };
  const failed = { total: undefined, usage: undefined };
  expect(sumTokenSplits([measured, failed])).toEqual({ inputTokens: 100, outputTokens: 10 });
  expect(sumTokenSplits([failed])).toEqual({});
  expect(sumTokenSplits([measured, { total: 40, usage: { inputTokens: 30, outputTokens: 10, cachedInputTokens: 70, cacheCreationInputTokens: 20 } }]))
    .toEqual({ inputTokens: 130, outputTokens: 20 });
  expect(sumTokenSplits([
    { total: 110, usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 70, cacheCreationInputTokens: 20 } },
    { total: 20, usage: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 1 } },
  ])).toEqual({ inputTokens: 110, outputTokens: 20, cacheReadInputTokens: 55, cacheCreationInputTokens: 21 });
  expect(sumTokenSplits([{ total: 9 }, measured])).toEqual({});
});

test("a context checkpoint keeps the primary slot and the request breakdown sits beside the request total", () => {
  const usage = { inputTokens: 100, outputTokens: 20 };
  const html = renderToStaticMarkup(<LanguageProvider><LogTokensCell requestTotal={120} contextTotal={50_000} usage={usage} estimated={false} locale="en" /></LanguageProvider>);
  const checkpoint = html.indexOf("50K");
  const requestLine = html.indexOf("Total tokens");
  const breakdown = html.indexOf("↑100");
  expect(checkpoint).toBeGreaterThanOrEqual(0);
  expect(requestLine).toBeGreaterThan(checkpoint);
  expect(breakdown).toBeGreaterThan(requestLine);
  expect(html).toContain("120");
  const plain = renderToStaticMarkup(<LanguageProvider><LogTokensCell requestTotal={120} contextTotal={120} usage={usage} estimated={false} locale="en" /></LanguageProvider>);
  expect(plain).not.toContain("Total tokens");
  expect(plain.indexOf("↑100")).toBeGreaterThan(plain.indexOf("120"));
});
