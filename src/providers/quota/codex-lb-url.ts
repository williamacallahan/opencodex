import type { OcxProviderConfig } from "../../types";

const CODEX_BACKEND_PATH = "/backend-api/codex";
const CHATGPT_ORIGIN = "https://chatgpt.com";

/**
 * A key-auth Responses provider served on the Codex backend path of a host other than ChatGPT is
 * a pooling relay such as codex-lb. Its pool usage is `GET <origin>/v1/usage` with the same key,
 * on the same origin that already receives that key for every inference request.
 */
export function codexLbUsageUrl(provider: OcxProviderConfig): string | null {
  if (provider.adapter !== "openai-responses") return null;
  try {
    const url = new URL(provider.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (url.origin === CHATGPT_ORIGIN || url.pathname.replace(/\/+$/, "") !== CODEX_BACKEND_PATH) return null;
    return `${url.origin}/v1/usage`;
  } catch {
    return null;
  }
}
