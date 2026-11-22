import { expect, test } from "bun:test";
import { sortWorkspaceItems, type ProviderSortMode, type WorkspaceItem } from "../src/provider-workspace/catalog";
import { freshQuotaReportsFromResponse } from "../src/provider-workspace/report";
import { buildQuotaSummary } from "../src/quota-summary";

const pinned = ["anthropic", "google-antigravity", "openai"];

test("Anthropic, Antigravity and OpenAI lead the provider rail in every sort mode", () => {
  const items = ["zai", "openai", "devin", "google-antigravity", "codex-lb", "anthropic", "kimi-code"]
    .map((name): WorkspaceItem => ({ name, adapter: "openai-chat", baseUrl: "https://example.test/v1", tier: "paid" }));
  const modes: ProviderSortMode[] = ["az", "za", "free-paid", "paid-free", "accounts-first"];
  for (const mode of modes) {
    const names = sortWorkspaceItems(items, mode).map(item => item.name);
    expect(names.slice(0, 3)).toEqual(pinned);
  }
  expect(sortWorkspaceItems(items, "az").map(item => item.name).slice(3)).toEqual(["codex-lb", "devin", "kimi-code", "zai"]);
  expect(sortWorkspaceItems(items, "za").map(item => item.name).slice(3)).toEqual(["zai", "kimi-code", "devin", "codex-lb"]);
});

test("the quota bar lists the pinned providers first and keeps report order for the rest", () => {
  const now = Date.UTC(2026, 10, 22, 12);
  const reports = freshQuotaReportsFromResponse(
    ["zai", "openai", "devin", "anthropic", "codex-lb", "google-antigravity"]
      .map(provider => ({ provider, updatedAt: now, quota: { weeklyPercent: 10, updatedAt: now } })),
    now,
  );
  expect(buildQuotaSummary(reports, name => name, now).map(row => row.provider))
    .toEqual([...pinned, "zai", "devin", "codex-lb"]);
});
