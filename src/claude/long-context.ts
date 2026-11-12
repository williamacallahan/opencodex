/**
 * Long-context thresholds shared by every Claude surface
 * (devlog/_plan/261009_claude_1m_default/020_long_context_eligibility.md).
 *
 * A leaf module: desktop-3p.ts and desktop-profile.ts need the predicate, and context-windows.ts
 * already imports desktop-3p.ts, so the predicate cannot live there.
 */
import { isAnthropicInstanceId } from "../providers/anthropic-instance-id";

export const ONE_MILLION = 1_000_000;

/** A window at or below this is Claude Code's own default accounting; widening it gains nothing. */
export const AUTO_CONTEXT_FLOOR = 200_000;

/**
 * Auto-context defaults (devlog 260712 020, user-approved).
 *
 * The compact window is the token count at which Claude Code starts compacting, and it is
 * also the floor `shouldMarkOneMillion` uses — a model may only carry the marker if it can
 * host this window. 350,000 was chosen when the widest native row advertised 372,000.
 *
 * It now matches the auto-compaction limit the Codex catalog ships for the same models
 * (`nativeAutoCompactLimit`: 829,800 against the 922,000 native window). Leaving the two
 * apart meant one model compacting at 350k under Claude Code and at 829,800 under Codex.
 * The value stays clear of the measured 922,000 ceiling by ~92k, so compaction still has
 * room to run before the upstream refuses.
 */
export const AUTO_COMPACT_WINDOW_DEFAULT = 829_800;

/**
 * The native id each Claude Code tier alias resolves to (2.1.321: `--model opus` sends
 * `claude-opus-5-5`, `sonnet` sends `claude-sonnet-5-5`, `fable` sends `claude-fable-5-2`).
 * Behind a gateway Claude Code accounts an unmarked id at 200k, so an unset tier slot is filled
 * with this id when the map marks it (#5755). A marked alias cannot stand in: Claude Code sends
 * `sonnet[1m]` upstream unresolved. Haiku has no entry; its 200k window never marks.
 *
 * Exported from this leaf so the dashboard's manual-env block (gui/src/pages/claude-manual-env.ts)
 * imports the ids: its hand-kept copy stayed on `claude-sonnet-5` and `claude-fable-5-1` when
 * these changed, and context-windows.ts would pull the catalog into the dashboard bundle.
 */
export const CLAUDE_CODE_NATIVE_TIERS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", fable: "claude-fable-5-2" } as const;

/**
 * Whether a window earns the 1M selection on a surface whose Claude Code runner may not inherit
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW (Desktop pickers, discovery, Desktop 3P, generated subagents).
 * A window >= 1M always does. A smaller one does when it can host the default compact window, so
 * a runner that has the variable compacts in time, and one that lacks it overflows into the
 * `prompt is too long` envelope (anthropicErrorBody) and compacts reactively. The floor is fixed
 * on purpose: a custom compact window must not re-admit a 372k route (#854).
 */
export function isLongContextWindow(window: number | undefined): boolean {
  if (typeof window !== "number" || window <= 0) return false;
  return window >= ONE_MILLION || (window > AUTO_CONTEXT_FLOOR && window >= AUTO_COMPACT_WINDOW_DEFAULT);
}

/**
 * A Claude model on an Anthropic-named route. Claude windows are 200k or a genuine 1M and a bare
 * id rides the native passthrough, so the long-window rule never widens one: a Claude row listed
 * under 1M is a capped one, and on a runner without the compaction env it keeps the 200k
 * accounting it had before long windows were widened. Keyed on the model id as well, so a
 * configured gateway that only shares the name `anthropic2` and serves other models keeps the
 * long-window rule. A custom `anthropic2` gateway serving Claude below 1M is treated like a pool
 * row on these surfaces, which is the pre-existing (unwidened) behavior.
 */
export function isAnthropicClaudeRoute(provider: string, modelId: string): boolean {
  return isAnthropicInstanceId(provider) && modelId.startsWith("claude-");
}

/** Desktop 3P / picker / discovery / dashboard 1M eligibility for one provider route. */
export function claudeSurfaceSupportsOneMillion(provider: string, modelId: string, window: number | undefined): boolean {
  if (isAnthropicClaudeRoute(provider, modelId)) return typeof window === "number" && window >= ONE_MILLION;
  return isLongContextWindow(window);
}

/** Same, for a `provider/id` route string. */
export function routeSupportsOneMillion(route: string, window: number | undefined): boolean {
  const slash = route.indexOf("/");
  return claudeSurfaceSupportsOneMillion(route.slice(0, slash), route.slice(slash + 1), window);
}
