/**
 * quota-summary.ts — pure derivation for the header quota summary bar.
 *
 * Reads only what `/api/provider-quotas` already reports (each provider's own quota
 * endpoint, cached server-side). No usage estimation happens here: a provider without a
 * reported window simply has no row.
 */
import type { AccountQuota } from "./codex-quota-utils";
import type { TKey } from "./i18n/en";
import { quotaWindows, resetTimestamp } from "./pages/tray-data";
import { accountQuotaFromReport, type ProviderQuotaReportView } from "./provider-workspace/report";
import { pinnedProviderRank } from "./provider-workspace/catalog";

export const QUOTA_SUMMARY_WARN_PERCENT = 70;
export const QUOTA_SUMMARY_CRITICAL_PERCENT = 90;

export type QuotaSummarySeverity = "normal" | "warn" | "critical";

export interface QuotaSummaryWindow {
  id: string;
  modelId?: string;
  /** A model-family limit: shown in the details, never the provider-wide headline or severity. */
  scope?: "model";
  /** Fixed window label (5h / weekly / monthly / credits). */
  labelKey?: TKey;
  /** Provider-named window label, shown verbatim. */
  label?: string;
  /** Presentation text only (for example a measured amount and plan); identity stays in `label`. */
  displayLabel?: string;
  percent?: number;
  /** Entitlement was not reported; no percentage may be inferred. */
  unknownBudget?: true;
  resetAt?: number;
  severity: QuotaSummarySeverity;
}

export interface QuotaSummaryRow {
  provider: string;
  label: string;
  headline: QuotaSummaryWindow;
  windows: QuotaSummaryWindow[];
  updatedAt?: number;
  observed: boolean;
  severity: QuotaSummarySeverity;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function quotaSeverity(percent: number | undefined): QuotaSummarySeverity {
  if (!finite(percent)) return "normal";
  if (percent >= QUOTA_SUMMARY_CRITICAL_PERCENT) return "critical";
  if (percent >= QUOTA_SUMMARY_WARN_PERCENT) return "warn";
  return "normal";
}

// Flooring keeps the displayed number on the same side of the 70/90 thresholds as the color.
export function formatQuotaPercent(percent: number | undefined): string {
  return finite(percent) ? `${Math.floor(percent)}%` : "-";
}

/** Interpret the reported decimal numbers exactly when rounding an informational balance. */
function decimalRatio(value: number): [bigint, bigint] {
  const [coefficient, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = BigInt(`${whole}${fraction}`);
  const scale = fraction.length - Number(exponent);
  return scale >= 0 ? [digits, 10n ** BigInt(scale)] : [digits * 10n ** BigInt(-scale), 1n];
}

function roundedUnavailablePercent(total: number, remaining: number): number {
  const [totalNumerator, totalDenominator] = decimalRatio(total);
  const [remainingNumerator, remainingDenominator] = decimalRatio(Math.min(remaining, total));
  const denominator = totalNumerator * remainingDenominator;
  const numerator = (denominator - remainingNumerator * totalDenominator) * 100n;
  return Number((2n * numerator + denominator) / (2n * denominator));
}

/** Among equally severe windows, long windows headline first: weekly, then monthly, then 5h. */
const HEADLINE_ORDER: TKey[] = ["quota.weeklyLimit", "quota.monthlyLimit", "quota.fiveHourLimit"];

/** Build reported quota windows with distinct IDs, including measured prepaid credits. */
function summaryWindows(quota: AccountQuota): QuotaSummaryWindow[] {
  const windows: QuotaSummaryWindow[] = quotaWindows(quota).map(window => {
    const percent = finite(window.percent) ? window.percent : undefined;
    const resetMs = resetTimestamp(window.reset);
    const modelId = "modelId" in window ? window.modelId : undefined;
    const modelScoped = modelId !== undefined || ("scope" in window && window.scope === "model");
    return {
      id: window.id,
      ...(modelId !== undefined ? { modelId } : {}),
      ...("scope" in window && window.scope === "model" ? { scope: "model" as const } : {}),
      ...("key" in window && window.key ? { labelKey: window.key } : {}),
      ...("label" in window && typeof window.label === "string" ? { label: window.label } : {}),
      ...("displayLabel" in window && typeof window.displayLabel === "string" && window.displayLabel.trim()
        ? { displayLabel: window.displayLabel }
        : {}),
      ...(percent !== undefined ? { percent } : {}),
      ...("unknownBudget" in window && window.unknownBudget === true ? { unknownBudget: true as const } : {}),
      ...(resetMs !== null ? { resetAt: resetMs } : {}),
      severity: modelScoped ? "normal" : quotaSeverity(percent),
    };
  });
  const credits = quota.creditsUsd;
  if (credits && credits.unlimited !== true && finite(credits.percent)) {
    const expiresMs = resetTimestamp(credits.expiresAt);
    windows.push({
      id: "quotaSummary.credits",
      labelKey: "quotaSummary.credits",
      percent: credits.percent,
      ...(expiresMs !== null ? { resetAt: expiresMs } : {}),
      severity: quotaSeverity(credits.percent),
    });
  }
  const workbuddy = quota.workbuddyCredits;
  // The provider can sum up to 512 packages; tolerate only their accumulated roundoff.
  if (workbuddy && workbuddy.total > 0 && workbuddy.remaining / workbuddy.total <= 1 + Number.EPSILON * 1024) {
    // Remaining is authoritative and includes frozen credits; the meter is informational.
    const percent = roundedUnavailablePercent(workbuddy.total, workbuddy.remaining);
    windows.push({
      id: "quotaSummary.creditsUnavailable",
      labelKey: "quotaSummary.creditsUnavailable",
      percent,
      severity: "normal",
    });
  }
  // Credits are appended after provider windows, whose labels can equal any fixed id.
  const used = new Set<string>();
  return windows.map(window => {
    let id = window.id;
    let suffix = 1;
    while (used.has(id)) id = `${window.id}#${suffix++}`;
    used.add(id);
    return id === window.id ? window : { ...window, id };
  });
}

function severityRank(severity: QuotaSummarySeverity): number {
  switch (severity) {
    case "critical": return 2;
    case "warn": return 1;
    case "normal": return 0;
  }
}

/** Weekly, monthly, 5h, then provider windows in report order, then credits. */
function headlinePreference(window: QuotaSummaryWindow): number {
  if (window.labelKey === "quotaSummary.credits") return HEADLINE_ORDER.length + 1;
  const fixed = window.labelKey === undefined ? -1 : HEADLINE_ORDER.indexOf(window.labelKey);
  return fixed >= 0 ? fixed : HEADLINE_ORDER.length;
}

/**
 * The headline is the binding window: the most severe one, so a spent 30-day or budget window is
 * never hidden behind a 0% weekly window. Among critical windows the fullest wins, except that
 * credits yield to a critical plan window; equal severity otherwise follows `headlinePreference`.
 * Model-family windows never headline, and a window whose reset has passed yields to a current one,
 * because its reading predates the reset.
 */
function pickHeadline(windows: QuotaSummaryWindow[], now: number): QuotaSummaryWindow | undefined {
  const measured = windows.filter(window => window.modelId === undefined && window.scope === undefined && window.percent !== undefined);
  const current = measured.filter(window => window.resetAt === undefined || window.resetAt > now);
  const ranked = (current.length > 0 ? current : measured)
    .map((window, order) => ({ window, order }))
    .sort((a, b) => severityRank(b.window.severity) - severityRank(a.window.severity)
      || Number(a.window.labelKey === "quotaSummary.credits") - Number(b.window.labelKey === "quotaSummary.credits")
      || (a.window.severity === "critical" ? (b.window.percent ?? 0) - (a.window.percent ?? 0) : 0)
      || headlinePreference(a.window) - headlinePreference(b.window)
      || a.order - b.order);
  return ranked[0]?.window ?? windows.find(window => window.unknownBudget);
}

/**
 * Build one summary row per provider that reported at least one measured window.
 * `reports` is the map produced by `freshQuotaReportsFromResponse`, so stale probes are
 * already dropped; pinned providers lead, then response order is preserved.
 */
export function buildQuotaSummary(
  reports: Record<string, ProviderQuotaReportView>,
  displayName: (provider: string) => string,
  now = Date.now(),
): QuotaSummaryRow[] {
  const rows: QuotaSummaryRow[] = [];
  for (const [provider, report] of Object.entries(reports)) {
    const quota = accountQuotaFromReport(report);
    if (!quota) continue;
    const windows = summaryWindows(quota);
    const headline = pickHeadline(windows, now);
    if (!headline) continue;
    rows.push({
      provider,
      label: report.label?.trim() || displayName(provider),
      headline,
      windows,
      ...(finite(report.updatedAt) ? { updatedAt: report.updatedAt } : {}),
      observed: report.observed === true,
      severity: headline.severity,
    });
  }
  return rows.sort((a, b) => pinnedProviderRank(a.provider) - pinnedProviderRank(b.provider));
}
