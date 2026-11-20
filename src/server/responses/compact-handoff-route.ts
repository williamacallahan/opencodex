import { contextPrincipalIdOf, type DataPlaneAdmission } from "../auth-cors";
import { sessionLaneIdFromRequest } from "../request-log-conversation";

const COMPACT_HANDOFF_ROUTE_TTL_MS = 24 * 60 * 60_000;
const COMPACT_HANDOFF_ROUTE_MAX_ENTRIES = 2_048;
const COMPACT_HANDOFF_MODEL_MAX_LENGTH = 512;

interface CompactHandoffRoute {
  model: string;
  lastUsedAt: number;
}

/**
 * The Codex client does not send its newly selected model on an automatic
 * previous-model compact request. Keep the last route that demonstrably compacted
 * this same thread so a quota-blocked previous model has one safe fallback target.
 */
const compactHandoffRoutes = new Map<string, CompactHandoffRoute>();

export function clearCompactHandoffRoutesForTests(): void {
  compactHandoffRoutes.clear();
}

function pruneCompactHandoffRoutes(now: number): void {
  for (const [key, entry] of compactHandoffRoutes) {
    if (now - entry.lastUsedAt > COMPACT_HANDOFF_ROUTE_TTL_MS) compactHandoffRoutes.delete(key);
  }
  while (compactHandoffRoutes.size > COMPACT_HANDOFF_ROUTE_MAX_ENTRIES) {
    const oldest = compactHandoffRoutes.keys().next().value;
    if (typeof oldest !== "string") return;
    compactHandoffRoutes.delete(oldest);
  }
}

/**
 * The handoff map is process-global, so a caller-controlled lane header alone
 * cannot be the key: two authenticated clients sending the same lane header
 * would share one fallback route. Namespace the lane by the admitted principal.
 * A loopback or missing admission has no authenticated identity to bind this
 * cross-request state to, so it is ineligible rather than trusted.
 */
function compactHandoffRouteKey(req: Request, admission: DataPlaneAdmission | undefined): string | null {
  const lane = sessionLaneIdFromRequest(req.headers);
  if (!lane || !admission || admission.kind === "loopback") return null;
  // Fail closed rather than substituting a weaker identity. `keyId` survives a
  // rotation and every identity-less environment admission would collapse into
  // one bucket, which is the collision this key exists to prevent. Production
  // admission always mints `contextPrincipalId` for configured and environment
  // holders, so no real authenticated caller loses the route.
  const principal = contextPrincipalIdOf(admission);
  if (!principal) return null;
  return `${principal}\u0000${lane}`;
}

export function rememberCompactHandoffRoute(
  req: Request,
  admission: DataPlaneAdmission | undefined,
  model: string,
  now = Date.now(),
): void {
  const key = compactHandoffRouteKey(req, admission);
  if (!key || model.length > COMPACT_HANDOFF_MODEL_MAX_LENGTH) return;
  pruneCompactHandoffRoutes(now);
  compactHandoffRoutes.delete(key);
  compactHandoffRoutes.set(key, { model, lastUsedAt: now });
  pruneCompactHandoffRoutes(now);
}

export function forgetCompactHandoffRoute(req: Request, admission?: DataPlaneAdmission): void {
  const key = compactHandoffRouteKey(req, admission);
  if (key) compactHandoffRoutes.delete(key);
}

export function compactHandoffRoute(
  req: Request,
  admission: DataPlaneAdmission | undefined,
  previousModel: string,
  now = Date.now(),
): string | null {
  const key = compactHandoffRouteKey(req, admission);
  if (!key) return null;
  pruneCompactHandoffRoutes(now);
  const entry = compactHandoffRoutes.get(key);
  if (!entry || entry.model === previousModel) return null;
  compactHandoffRoutes.delete(key);
  compactHandoffRoutes.set(key, { ...entry, lastUsedAt: now });
  return entry.model;
}

