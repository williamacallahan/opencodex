/** Positive diagnostics only: an older response without the flag proves no completeness. */
export interface UsageReadMetadata {
  usageIncomplete?: true;
  usageIncompleteReason?: "oversized_rows";
}

export function readUsageMetadata(value: unknown): UsageReadMetadata {
  if (!value || typeof value !== "object" || !("usageIncomplete" in value) || value.usageIncomplete !== true) return {};
  return {
    usageIncomplete: true,
    ...("usageIncompleteReason" in value && value.usageIncompleteReason === "oversized_rows"
      ? { usageIncompleteReason: "oversized_rows" as const } : {}),
  };
}

/** Older daemons returned this failure as HTTP 200; never admit that envelope as usage data. */
export function isUsageReadFailure(value: unknown): boolean {
  return !!value && typeof value === "object" && "error" in value && value.error === "read_failed";
}

export class UsageReadFailedError extends Error {
  constructor() {
    super("usage ledger read failed");
    this.name = "UsageReadFailedError";
  }
}

/**
 * The proxy is rebuilding usage from the whole ledger in the background (503 `usage_rebuilding`).
 * Not a failure and not an empty report: keep the last valid snapshot and ask again after the delay.
 */
export class UsageRebuildingError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Usage is still being read from the usage log; it will refresh shortly.");
    this.name = "UsageRebuildingError";
  }
}

/** Admit usage data only after recognizing both current HTTP errors and legacy HTTP-200 failures. */
export async function readUsageResponseJson<T>(response: Response, fallbackMessage?: string): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(fallbackMessage ?? `${response.status} ${response.statusText}`.trim());
  }
  if (isUsageReadFailure(value)) throw new UsageReadFailedError();
  if (response.status === 503 && !!value && typeof value === "object" && "error" in value && value.error === "usage_rebuilding") {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new UsageRebuildingError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5);
  }
  if (!response.ok) throw new Error(fallbackMessage ?? `${response.status} ${response.statusText}`.trim());
  return value as T;
}

export function usageSummary30dResourceKey(
  apiBase: string,
  surface: "all" | "codex" = "all",
  targetKey?: string,
): string {
  const scope = targetKey && targetKey !== apiBase ? targetKey : apiBase;
  return surface === "codex"
    ? ["usage-summary-30d", scope, "codex"].join(":")
    : ["usage-summary-30d", scope, "all"].join(":");
}
