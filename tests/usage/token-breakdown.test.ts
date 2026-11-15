import { expect, test } from "bun:test";
import { formatTokenShare, tokenBreakdown } from "../../src/usage/token-breakdown";

test("cache shares use sent tokens, not total tokens", () => {
  const result = tokenBreakdown({ inputTokens: 57_400, outputTokens: 600, cacheReadInputTokens: 51_000, cacheCreationInputTokens: 2_000 });
  expect(result.sent).toBe(57_400);
  expect(result.received).toBe(600);
  expect(result.cacheRead).toBe(51_000);
  expect(result.cacheWrite).toBe(2_000);
  expect(formatTokenShare(result.cacheReadShare, "en-US")).toBe("88.9%");
  expect(formatTokenShare(result.cacheWriteShare, "en-US")).toBe("3.5%");
});

test("unknown writes, zero sent, and legacy cache reads stay distinct", () => {
  const result = tokenBreakdown({ inputTokens: 10, cachedInputTokens: 5 });
  expect(result.cacheRead).toBe(5);
  expect(result.cacheWrite).toBeUndefined();
  expect(result.cacheWriteShare).toBeUndefined();
  const empty = tokenBreakdown({ inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  expect(empty.cacheReadShare).toBeUndefined();
  expect(empty.cacheWriteShare).toBeUndefined();
});

test("share formatting preserves boundary distinctions", () => {
  expect(formatTokenShare(0.004, "en-US")).toBe("<1%");
  expect(formatTokenShare(0.9996, "en-US")).toBe("<100%");
  expect(formatTokenShare(1, "en-US")).toBe("100%");
  expect(formatTokenShare(undefined, "en-US")).toBe("—");
});

test("a legacy combined cache count is split into reads once a write count exists", () => {
  const result = tokenBreakdown({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 70, cacheCreationInputTokens: 20 });
  expect(result.cacheRead).toBe(50);
  expect(formatTokenShare(result.cacheReadShare, "en-US")).toBe("50%");
  expect(result.cacheWrite).toBe(20);
  expect(tokenBreakdown({ inputTokens: 100, cachedInputTokens: 10, cacheCreationInputTokens: 20 }).cacheRead).toBe(0);
  expect(tokenBreakdown({ inputTokens: 100, cacheReadInputTokens: 30, cachedInputTokens: 70, cacheCreationInputTokens: 20 }).cacheRead).toBe(30);
});

test("an aggregate row flagged cacheCreationReported false shows writes as not reported, an explicit zero stays zero", () => {
  const unreported = tokenBreakdown({ inputTokens: 100, cacheReadInputTokens: 80, cacheCreationInputTokens: 0, cacheCreationReported: false });
  expect(unreported.cacheWrite).toBeUndefined();
  expect(unreported.cacheWriteShare).toBeUndefined();
  expect(unreported.cacheRead).toBe(80);
  expect(tokenBreakdown({ inputTokens: 100, cacheCreationInputTokens: 0, cacheCreationReported: true }).cacheWrite).toBe(0);
  expect(tokenBreakdown({ inputTokens: 100, cacheCreationInputTokens: 0 }).cacheWrite).toBe(0);
});
