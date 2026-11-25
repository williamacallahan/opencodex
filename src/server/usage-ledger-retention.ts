/**
 * Runtime owner for the opt-in usage-ledger size limit (#5063).
 *
 * The trim in `src/usage/ledger-retention.ts` is suspended until the archive catalog can publish a
 * trimmed prefix and the new live ledger in one durable decision (structure/usage-archive.md,
 * "Suspended trim"). A configured limit is still stored and reported, and an append that crosses it
 * still schedules one check off the request's turn, which warns once per process that the ledger is
 * being kept whole. Nothing is trimmed, so no ledger reader needs invalidating.
 */
import { currentUsageLogRevision, setUsageLedgerAppendHook } from "../usage/log";
import { enforceUsageLedgerSizeLimit, usageLedgerLimitApplies } from "../usage/ledger-retention";
import type { UsageLedgerRetentionStatus } from "../usage/retention-contract";

let configuredMaxBytes: number | undefined;
let scheduledEnforcement: ReturnType<typeof setTimeout> | null = null;
let suspensionWarned = false;

/** Appends only schedule the check, in one coalesced, unref'd timer, so the crossing request never pays for it. */
const ENFORCEMENT_DELAY_MS = 1_000;

function enforceNow(): void {
  try {
    const result = enforceUsageLedgerSizeLimit(configuredMaxBytes);
    if (result.kind === "deferred" && !suspensionWarned) {
      suspensionWarned = true;
      console.warn(
        `[usage-retention] the usage ledger is ${result.currentBytes} bytes, over its ${configuredMaxBytes}-byte limit; trimming is suspended until the archive can publish trimmed rows safely, so the ledger is kept whole`,
      );
    }
  } catch (error) {
    // Never fail a request because the limit could not be checked.
    console.warn(
      `[usage-retention] could not check the usage ledger size limit: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function safeCurrentUsageLogBytes(): number {
  try {
    return currentUsageLogRevision()?.size ?? 0;
  } catch {
    return 0;
  }
}

function scheduleEnforcement(): void {
  if (scheduledEnforcement !== null || suspensionWarned || configuredMaxBytes === undefined) return;
  if (safeCurrentUsageLogBytes() <= configuredMaxBytes) return;
  scheduledEnforcement = setTimeout(() => {
    scheduledEnforcement = null;
    enforceNow();
  }, ENFORCEMENT_DELAY_MS);
  scheduledEnforcement.unref?.();
}

/** Install or update the policy. `undefined` removes the hook entirely. */
export function setUsageLedgerRetention(maxBytes: number | undefined): void {
  configuredMaxBytes = maxBytes;
  suspensionWarned = false;
  if (scheduledEnforcement !== null) {
    clearTimeout(scheduledEnforcement);
    scheduledEnforcement = null;
  }
  setUsageLedgerAppendHook(maxBytes === undefined ? null : scheduleEnforcement);
  if (maxBytes !== undefined) scheduleEnforcement();
}

/** The first minute after listen belongs to startup work and the first requests, not a segment scan. */
const ARCHIVE_TOTALS_STARTUP_DELAY_MS = 60_000;
/** Segments built per background pass, newest first. A build of a 100 MB segment takes a few seconds. */
export const ARCHIVE_TOTALS_PASS_SEGMENTS = 4;
/** Idle time between passes, so a backlog of hundreds of segments keeps the loop busy only briefly per pass. */
export const ARCHIVE_TOTALS_PASS_INTERVAL_MS = 5 * 60_000;
let archiveTotalsStartupTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Build totals for segments that have none (written before totals existed, a crash, a format bump),
 * starting a minute after the server starts serving, so the first archive read after a restart is not
 * all `pending`. Each pass builds at most {@link ARCHIVE_TOTALS_PASS_SEGMENTS} segments, newest first,
 * and re-arms after {@link ARCHIVE_TOTALS_PASS_INTERVAL_MS} while any remain. Scheduled from the
 * background lifecycle's startup run, beside the storage policy's; the timers are unref'd and the work
 * itself is a dynamic import, so startup pays one timer. A failed pass warns and does not re-arm.
 */
export function scheduleArchiveTotalsStartupBuild(
  delayMs = ARCHIVE_TOTALS_STARTUP_DELAY_MS,
  pass: { segments: number; intervalMs: number } = { segments: ARCHIVE_TOTALS_PASS_SEGMENTS, intervalMs: ARCHIVE_TOTALS_PASS_INTERVAL_MS },
): void {
  if (archiveTotalsStartupTimer) return;
  const generation = archiveTotalsPassGeneration;
  archiveTotalsStartupTimer = setTimeout(() => {
    void import("../usage/archive-query")
      .then(({ buildMissingArchiveTotals }) => buildMissingArchiveTotals(pass.segments))
      .then(remaining => {
        if (generation !== archiveTotalsPassGeneration) return;
        archiveTotalsStartupTimer = null;
        if (remaining > 0) scheduleArchiveTotalsStartupBuild(pass.intervalMs, pass);
      })
      .catch(error => {
        if (generation === archiveTotalsPassGeneration) archiveTotalsStartupTimer = null;
        console.warn(`[usage-archive] hourly totals for existing segments could not be built: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, delayMs);
  archiveTotalsStartupTimer.unref?.();
}

/** Bumped by a stop, so a pass already running when the lifecycle stops never re-arms. */
let archiveTotalsPassGeneration = 0;

export function stopArchiveTotalsStartupBuild(): void {
  archiveTotalsPassGeneration += 1;
  if (archiveTotalsStartupTimer) clearTimeout(archiveTotalsStartupTimer);
  archiveTotalsStartupTimer = null;
}

export function configuredUsageLedgerMaxBytes(): number | undefined {
  return configuredMaxBytes;
}

/** `enforcement: "suspended"` when the ledger is over an applicable limit that the suspended trim does not enforce. */
export function usageLedgerRetentionStatus(maxBytes: number | undefined = configuredMaxBytes): UsageLedgerRetentionStatus {
  const currentBytes = safeCurrentUsageLogBytes();
  return {
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    currentBytes,
    ...(usageLedgerLimitApplies(maxBytes) && currentBytes > maxBytes ? { enforcement: "suspended" as const } : {}),
  };
}
