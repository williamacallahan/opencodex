import { settleUsageColdRebuildForTests } from "../../src/usage/cold-rebuild-slot";

/** The pending answers a usage route sends while its whole-ledger rebuild runs in the background. */
const PENDING_ERRORS = new Set(["usage_rebuilding", "usage_facets_unavailable", "hub_usage_pending"]);

/**
 * A usage read the way a client retries it: a 503 pending answer is followed by the rebuild finishing
 * and one more request, which must then be served. Tests that assert the pending answer itself call
 * the route directly instead.
 */
export async function settledUsageResponse(request: () => Promise<Response | null>): Promise<Response> {
  let response = await request();
  for (let attempt = 0; attempt < 3 && response?.status === 503; attempt += 1) {
    const body = await response.clone().json().catch(() => null) as { error?: unknown } | null;
    const code = typeof body?.error === "object" && body.error !== null ? (body.error as { code?: unknown }).code : body?.error;
    // A HEAD answer has no body; its Retry-After header alone marks it pending.
    if (!PENDING_ERRORS.has(String(code)) && !(body === null && response.headers.has("retry-after"))) break;
    await settleUsageColdRebuildForTests();
    response = await request();
  }
  if (!response) throw new Error("usage route returned no response");
  return response;
}
