/**
 * Runtime owner for the opt-in usage-ledger size limit (#5063).
 *
 * The compactor in `src/usage/ledger-retention.ts` knows how to publish a smaller ledger safely.
 * This is the part that decides when, and -- the half #5063 was missing -- what has to be
 * discarded afterwards.
 *
 * Deleting rows from usage.jsonl invalidates three readers that do not watch the file: the
 * 2,000-entry Logs ring, which otherwise keeps serving rows the ledger no longer has; the
 * retained usage aggregate and failure projection, whose checkpoints now point past a boundary
 * that moved; and the request-history index, whose source identity has changed. A compaction
 * that skips any of them makes the dashboard disagree with the ledger, which is the disagreement
 * this batch exists to remove.
 */
import { currentUsageLogRevision, setUsageLedgerAppendHook } from "../usage/log";
import { enforceUsageLedgerSizeLimit } from "../usage/ledger-retention";
import { discardRetainedFailureProjection } from "../usage/failure-projection-cache";
import { rehydrateRequestLogsAfterLedgerReplacement } from "./request-log";
import type { UsageLedgerRetentionStatus } from "../usage/retention-contract";

let configuredMaxBytes: number | undefined;
let enforcing = false;
let scheduledEnforcement: ReturnType<typeof setTimeout> | null = null;

/**
 * Appends only schedule the compaction. Copying the retained span (0.9 GB under a 1 GB limit)
 * inside the append made the request that crossed the line pay for it; one coalesced, unref'd
 * timer runs it in its own turn instead. The compaction is still fully synchronous, so no
 * in-process append can interleave with it, and its revision guard covers everything else.
 */
const ENFORCEMENT_DELAY_MS = 1_000;

function invalidateLedgerReaders(): void {
  // Ordered cheapest-first, and each guarded on its own: a projection that fails to discard
  // must not stop the ring from being rebuilt, because the ring is the surface an operator is
  // looking at while this happens.
  try { discardRetainedFailureProjection(); } catch { /* rebuildable by construction */ }
  void (async () => {
    try {
      const { discardRetainedUsageAggregate } = await import("./management/usage-aggregate-cache");
      discardRetainedUsageAggregate();
    } catch { /* rebuildable by construction */ }
    try {
      const { closeRequestHistoryIndex } = await import("../routing/history/indexer");
      closeRequestHistoryIndex();
    } catch { /* the index rebuilds from its own source-identity contract */ }
  })();
  try { rehydrateRequestLogsAfterLedgerReplacement(); } catch { /* the ring refills as rows arrive */ }
}

/** Builds the hourly totals of a segment a trim just published. */
type SegmentPublishedHook = (segmentPath: string) => unknown;

const scheduleSegmentTotals: SegmentPublishedHook = async segmentPath => {
  const { scheduleArchiveTotalsBuild } = await import("../usage/archive-totals");
  await scheduleArchiveTotalsBuild(segmentPath);
};
let onSegmentPublished: SegmentPublishedHook = scheduleSegmentTotals;

/**
 * Runs from a timer after the trim's turn has ended, never in its tail: the ledger is already
 * published, so a totals build that fails costs only a lazy rebuild when the archive is next read.
 */
function buildTotalsAfterTrim(segmentPath: string): void {
  const hook = onSegmentPublished;
  const timer = setTimeout(() => {
    void (async () => {
      try {
        await hook(segmentPath);
      } catch (error) {
        console.warn(`[usage-retention] the ledger was trimmed but the archive segment's hourly totals could not be built: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, 0);
  timer.unref?.();
}

function enforceNow(): void {
  // Re-entrancy guard, not a lock. The compaction's own publication writes nothing through
  // appendUsageEntry -- this exists so a future caller cannot start a second pass over a file
  // the first one is replacing.
  if (enforcing) return;
  enforcing = true;
  try {
    const result = enforceUsageLedgerSizeLimit(configuredMaxBytes);
    if (result.kind === "replaced") {
      invalidateLedgerReaders();
      buildTotalsAfterTrim(result.archivePath);
    }
  } catch (error) {
    // Never fail a request because history could not be trimmed. The limit is not enforced and
    // says so; the next append tries again from a fresh revision.
    console.warn(
      `[usage-retention] could not enforce the usage ledger size limit: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    enforcing = false;
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
  if (scheduledEnforcement !== null || configuredMaxBytes === undefined) return;
  if (safeCurrentUsageLogBytes() <= configuredMaxBytes) return;
  scheduledEnforcement = setTimeout(() => {
    scheduledEnforcement = null;
    enforceNow();
  }, ENFORCEMENT_DELAY_MS);
  scheduledEnforcement.unref?.();
}

/**
 * Install or update the policy. `undefined` removes the hook entirely. `onSegmentPublished` replaces
 * the totals build that follows each trim; only a test that needs that build to fail passes it.
 */
export function setUsageLedgerRetention(maxBytes: number | undefined, options: { onSegmentPublished?: SegmentPublishedHook } = {}): void {
  configuredMaxBytes = maxBytes;
  onSegmentPublished = options.onSegmentPublished ?? scheduleSegmentTotals;
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

export function usageLedgerRetentionStatus(maxBytes: number | undefined = configuredMaxBytes): UsageLedgerRetentionStatus {
  return {
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    currentBytes: safeCurrentUsageLogBytes(),
  };
}
