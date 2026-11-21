import { responsesTransportUrl, stripTrailingSlashes } from "../openai-tiers-destination";
import type { RouteResult } from "../../router";
import type { OcxProviderConfig } from "../../types";

const CODEX_BACKEND_PATH = "/backend-api/codex";
const CHATGPT_ORIGIN = "https://chatgpt.com";

/** Cooldown policy follows the resolved destination, not the combo target's or provider's name. */
export function hasUpstreamSeatPool(route: Pick<RouteResult, "provider" | "modelId" | "staticPolicy">, wire = route.staticPolicy.model.adapter): boolean {
  return route.provider.modelCapabilities?.[route.modelId]?.upstreamSeatPool === true
    || isCodexLbResponsesEndpoint(route.provider, wire);
}

/** Only the two key-auth Responses handlers on a Codex relay base share its seat pool. */
export function isCodexLbResponsesEndpoint(provider: OcxProviderConfig, wire: string, target?: string): boolean {
  if ((provider.authMode ?? "key") !== "key" || !codexLbUsageUrl(provider, wire)) return false;
  const base = stripTrailingSlashes(provider.baseUrl);
  const url = target ?? responsesTransportUrl(provider);
  return url === `${base}/responses` || url === `${base}/v1/responses`;
}

/** Base-level detection used for native Luna placement, independent of cooldown policy. */
export function isCodexLbProvider(provider: OcxProviderConfig): boolean {
  return codexLbUsageUrl(provider) !== null;
}

/**
 * A key-auth Responses provider served on the Codex backend path of a host other than ChatGPT is
 * a pooling relay such as codex-lb. Its pool usage is `GET <origin>/v1/usage` with the same key,
 * on the same origin that already receives that key for every inference request.
 */
export function codexLbUsageUrl(provider: OcxProviderConfig, wire = provider.adapter): string | null {
  if (wire !== "openai-responses") return null;
  try {
    const url = new URL(provider.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (url.origin === CHATGPT_ORIGIN || url.pathname.replace(/\/+$/, "") !== CODEX_BACKEND_PATH) return null;
    return `${url.origin}/v1/usage`;
  } catch {
    return null;
  }
}
