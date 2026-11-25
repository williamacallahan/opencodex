/**
 * Ties an agy monitoring call to the session whose id its top-level `requestId` names.
 *
 * agy's `agent_monitoring` generate calls carry no labels and no `sessionId`; their `requestId` is
 * `<mode>/<UUID>`. When that UUID is the trajectory, cascade or root cascade id of a request this hub already
 * labelled for the same caller, the monitoring call takes that trajectory as its session.
 *
 * Memory holds only canonical UUIDs agy itself sent in `request.labels`, each mapped to the trajectory id it
 * belongs to, under the caller key (a one-way hash the account chooser already keeps), least recently used,
 * 4,096 entries, six hours after last use. The `requestId` string is read, compared and dropped. Logged: one
 * `agy.monitoring_session_match` line of cumulative counts, at most every ten minutes and only when they
 * changed; no id, key or caller is ever in it.
 */
export const MONITORING_REQUEST_ID = /^[A-Za-z_]{1,32}\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
export const MAX_SESSION_IDENTITIES = 4_096;
export const SESSION_IDENTITY_TTL_MS = 6 * 60 * 60 * 1000;
const LOG_INTERVAL_MS = 10 * 60 * 1000;

/** Canonical ids agy named in one labelled generate request. */
export interface AgyScanIds {
  trajectory?: string;
  cascade?: string;
  root?: string;
  requestId?: string;
}

type MatchKind = "trajectory" | "cascade" | "root";
interface Identity { readonly trajectory: string; readonly kind: MatchKind; lastUsed: number }

const identities = new Map<string, Identity>();
const counts = { matched_trajectory: 0, matched_cascade: 0, matched_root_cascade: 0, unmatched: 0, no_request_id_uuid: 0 };
let lastLoggedAt = Number.NEGATIVE_INFINITY;
let lastLoggedKey = "";

const keyFor = (caller: string, uuid: string): string => `${caller}\0${uuid.toLowerCase()}`;

const STRENGTH: Record<MatchKind, number> = { root: 0, cascade: 1, trajectory: 2 };

function put(caller: string, uuid: string | undefined, trajectory: string, kind: MatchKind, now: number): void {
  if (uuid === undefined) return;
  const key = keyFor(caller, uuid);
  const existing = identities.get(key);
  // A root agent's id stays with the root agent; a later subagent naming the same root must not take it over.
  if (existing && STRENGTH[existing.kind] > STRENGTH[kind] && now - existing.lastUsed <= SESSION_IDENTITY_TTL_MS) {
    existing.lastUsed = now;
    identities.delete(key);
    identities.set(key, existing);
    return;
  }
  identities.delete(key);
  identities.set(key, { trajectory, kind, lastUsed: now });
  while (identities.size > MAX_SESSION_IDENTITIES) identities.delete(identities.keys().next().value!);
}

/** Remember the ids of a request that was labelled with a trajectory. */
export function rememberAgySession(caller: string, ids: AgyScanIds, now = Date.now()): void {
  if (ids.trajectory === undefined) return;
  try {
    put(caller, ids.root, ids.trajectory, "root", now);
    put(caller, ids.cascade, ids.trajectory, "cascade", now);
    put(caller, ids.trajectory, ids.trajectory, "trajectory", now);
  } catch {
    // A diagnostic map never fails a request.
  }
}

function logCounts(now: number): void {
  const key = Object.values(counts).join(",") + `,${identities.size}`;
  if (key === lastLoggedKey || now - lastLoggedAt < LOG_INTERVAL_MS) return;
  lastLoggedAt = now;
  lastLoggedKey = key;
  console.info(`[opencodex] level=info event=agy.monitoring_session_match ${Object.entries(counts).map(([name, value]) => `${name}=${value}`).join(" ")} map_size=${identities.size}`);
}

/** The trajectory a monitoring call's `requestId` names for this caller, or undefined. Counts every call it sees. */
export function resolveMonitoringSession(caller: string, requestId: string | undefined, now = Date.now()): string | undefined {
  try {
    const uuid = requestId === undefined ? undefined : MONITORING_REQUEST_ID.exec(requestId)?.[1];
    if (uuid === undefined) {
      counts.no_request_id_uuid += 1;
      return undefined;
    }
    const key = keyFor(caller, uuid);
    const found = identities.get(key);
    if (!found || now - found.lastUsed > SESSION_IDENTITY_TTL_MS) {
      if (found) identities.delete(key);
      counts.unmatched += 1;
      return undefined;
    }
    found.lastUsed = now;
    identities.delete(key);
    identities.set(key, found);
    counts[found.kind === "root" ? "matched_root_cascade" : found.kind === "cascade" ? "matched_cascade" : "matched_trajectory"] += 1;
    return found.trajectory;
  } catch {
    return undefined;
  } finally {
    try { logCounts(now); } catch { /* a diagnostic never affects the relay */ }
  }
}

export function agyMonitoringStateForTests(): { size: number; counts: typeof counts } {
  return { size: identities.size, counts: { ...counts } };
}

export function resetAgyMonitoringStateForTests(): void {
  identities.clear();
  for (const name of Object.keys(counts) as (keyof typeof counts)[]) counts[name] = 0;
  lastLoggedAt = Number.NEGATIVE_INFINITY;
  lastLoggedKey = "";
}
