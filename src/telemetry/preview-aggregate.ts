import { currentUsageLogRevision, usageLogIdentityKey } from "../usage/log";
import { aggregateTelemetryForDay, type DailyTelemetryAggregate } from "./aggregate";

/**
 * The aggregate a dashboard preview shows, without ever making the request wait for it.
 *
 * A day's aggregate scans usage.jsonl from its first byte, which on a large ledger takes longer than
 * the dashboard waits, and the telemetry and profile panels poll. So a request gets a completed
 * aggregate for the same home, ledger file and UTC day, or `pending` while one shared build runs in
 * the background, or `unavailable` when the last build failed. A send never reads this: it builds a
 * complete aggregate of its own (`aggregateTelemetryForDay`).
 */
export type TelemetryPreviewAggregate =
  | { status: "ready"; aggregate: DailyTelemetryAggregate }
  | { status: "pending" | "unavailable" };

/** How long a completed aggregate is served before a rebuild picks up rows appended since. */
export const TELEMETRY_PREVIEW_FRESH_MS = 10 * 60 * 1000;
/** After a failed build, requests report `unavailable` this long before one tries again. */
const FAILED_BUILD_RETRY_MS = 60 * 1000;

interface PreviewBuild {
  key: string;
  startedAt: number;
  completed?: { at: number; aggregate: DailyTelemetryAggregate };
  failedAt?: number;
  running: boolean;
}

/** One entry: a dashboard previews one day at a time, and a new key supersedes the old build's answer. */
let current: PreviewBuild | null = null;

function startBuild(key: string, day: string, now: number, previous: PreviewBuild | null): PreviewBuild {
  const build: PreviewBuild = {
    key,
    startedAt: now,
    running: true,
    ...(previous?.key === key && previous.completed ? { completed: previous.completed } : {}),
  };
  current = build;
  void aggregateTelemetryForDay(day).then(
    aggregate => {
      build.running = false;
      build.completed = { at: build.startedAt, aggregate };
      delete build.failedAt;
    },
    () => {
      build.running = false;
      build.failedAt = Date.now();
    },
  );
  return build;
}

export function telemetryPreviewAggregate(day: string, configDir: string, now: number = Date.now()): TelemetryPreviewAggregate {
  let identity: string;
  try {
    identity = usageLogIdentityKey(currentUsageLogRevision());
  } catch {
    return { status: "unavailable" };
  }
  const key = JSON.stringify([configDir, identity, day]);
  const build = current?.key === key ? current : null;
  const completed = build?.completed;
  const fresh = completed !== undefined && now - completed.at >= 0 && now - completed.at < TELEMETRY_PREVIEW_FRESH_MS;
  if (!build) {
    startBuild(key, day, now, null);
    return { status: "pending" };
  }
  const recentlyFailed = build.failedAt !== undefined && now - build.failedAt >= 0 && now - build.failedAt < FAILED_BUILD_RETRY_MS;
  // A stale aggregate for the same day stays served while its replacement picks up late appends.
  if (!fresh && !build.running && !recentlyFailed) startBuild(key, day, now, build);
  if (completed) return { status: "ready", aggregate: completed.aggregate };
  return build.failedAt !== undefined && !build.running ? { status: "unavailable" } : { status: "pending" };
}

/** Resolves once no preview build is running; for tests and benchmarks that need the completed answer. */
export async function settleTelemetryPreviewBuildForTests(): Promise<void> {
  while (current?.running) await new Promise(resolve => setTimeout(resolve, 5));
}

export function resetTelemetryPreviewAggregateForTests(): void {
  current = null;
}
