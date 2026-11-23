/**
 * Browser-safe Antigravity quota window family predicates.
 *
 * Antigravity accounts carry Gemini, Argon (Gemini model pool), Claude/3P, and per-model
 * windows. Dashboard summaries, capacity gauges, passthrough load-balancing, and the menu
 * bar use these predicates to rank accounts and headlines by the highest Gemini usage while
 * ignoring Claude usage values and leaving non-Gemini diagnostic rows out of headlines.
 */

export interface AntigravityWindowShape {
  label?: string;
  modelId?: string;
}

const GEM_SUMMARY_RE = /^gem(?:\s*\([^)]*\))?$/i;
const ARGON_SUMMARY_RE = /^argon(?:\s*\([^)]*\))?$/i;
const GEMINI_OR_ARGON_TOKEN_RE = /(?:^|[^a-z0-9])(?:gemini|argon)(?:[^a-z0-9]|$)/i;
const CLA_SUMMARY_RE = /^cla(?:\s*\([^)]*\))?$/i;
const CLAUDE_FAMILY_TOKEN_RE = /(?:^|[^a-z0-9])(?:claude|opus|sonnet|fable|gpt[-_]?oss|3p)(?:[^a-z0-9]|$)/i;

function windowIdentityText(window: AntigravityWindowShape): string {
  const label = typeof window.label === "string" ? window.label.trim() : "";
  const modelId = typeof window.modelId === "string" ? window.modelId.trim() : "";
  return `${label} ${modelId}`.trim();
}

export function isAntigravityGeminiWindow(window: AntigravityWindowShape): boolean {
  const label = typeof window.label === "string" ? window.label.trim() : "";
  if (GEM_SUMMARY_RE.test(label) || ARGON_SUMMARY_RE.test(label)) return true;
  return GEMINI_OR_ARGON_TOKEN_RE.test(windowIdentityText(window));
}

export function isAntigravityClaudeWindow(window: AntigravityWindowShape): boolean {
  if (isAntigravityGeminiWindow(window)) return false;
  const label = typeof window.label === "string" ? window.label.trim() : "";
  if (CLA_SUMMARY_RE.test(label)) return true;
  return CLAUDE_FAMILY_TOKEN_RE.test(windowIdentityText(window));
}

export function stripAntigravityClaudeWindows<T extends AntigravityWindowShape>(
  windows: readonly T[] | undefined,
): T[] | undefined {
  if (!windows || !windows.some(isAntigravityClaudeWindow)) {
    return windows as T[] | undefined;
  }
  return windows.filter(window => !isAntigravityClaudeWindow(window));
}

export function stripAntigravityClaudeQuota<
  Q extends { customWindows?: T[]; displayWindows?: T[] },
  T extends AntigravityWindowShape = AntigravityWindowShape,
>(quota: Q): Q {
  const customChanged = Array.isArray(quota.customWindows) && quota.customWindows.some(isAntigravityClaudeWindow);
  const displayChanged = Array.isArray(quota.displayWindows) && quota.displayWindows.some(isAntigravityClaudeWindow);
  if (!customChanged && !displayChanged) return quota;
  const next: Q = { ...quota };
  if (customChanged) {
    const kept = stripAntigravityClaudeWindows(quota.customWindows);
    if (kept && kept.length > 0) next.customWindows = kept;
    else delete next.customWindows;
  }
  if (displayChanged) {
    const kept = stripAntigravityClaudeWindows(quota.displayWindows);
    if (kept && kept.length > 0) next.displayWindows = kept;
    else delete next.displayWindows;
  }
  return next;
}
