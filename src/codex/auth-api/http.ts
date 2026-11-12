import { codexHomeIsAbsent } from "../codex-home-owner";
import { getCodexHome } from "../paths";
import { withNativeMainSharedClaim } from "../native-main-claim";
import { resolveNativeProfileContext } from "../native-profile-store";
import { NativeProfileError } from "../native-profile-types";
import { isDraining } from "../../server/lifecycle";

export function isNativeMainClaimUnavailable(error: unknown): error is NativeProfileError {
  return error instanceof NativeProfileError
    && (error.code === "NATIVE_MAIN_CLAIM_BUSY" || error.code === "NATIVE_MAIN_CLAIM_UNAVAILABLE");
}

/** Missing native homes leave reads unobserved; credential operations still require their claim. */
export function isNativeMainObservationUnavailable(error: unknown): error is NativeProfileError {
  if (isNativeMainClaimUnavailable(error)) return true;
  if (!(error instanceof NativeProfileError) || error.code !== "CODEX_HOME_UNAVAILABLE") return false;
  try {
    return codexHomeIsAbsent(getCodexHome());
  } catch {
    return false;
  }
}

export function withNativeMainCredentialClaim<T>(operation: () => Promise<T>): Promise<T> {
  return withNativeMainSharedClaim(resolveNativeProfileContext(), operation);
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Login-start answer while the hub drains: a browser flow opened now could not finish before the restart. */
export function loginRestartingResponse(): Response | null {
  if (!isDraining()) return null;
  const response = jsonResponse({
    error: { type: "server_error", code: "server_restarting", message: "OpenCodex is restarting; start the login again when it is back." },
  }, 503);
  response.headers.set("Retry-After", "5");
  return response;
}

export function nativeMainProfileBusyResponse(): Response {
  const response = jsonResponse({ error: "server_busy", code: "server_busy" }, 503);
  response.headers.set("Retry-After", "1");
  return response;
}

export function manualImportDisabledResponse(): Response {
  return jsonResponse({
    error: "Manual Codex account import is disabled. Use OAuth login to add a pool account.",
    code: "manual_import_disabled",
  }, 403);
}
