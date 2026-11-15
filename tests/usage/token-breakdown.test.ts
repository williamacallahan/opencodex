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
