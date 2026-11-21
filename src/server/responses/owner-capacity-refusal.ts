import { comboFailureDecision } from "../../combos/failover";
import { isPlainObject } from "../../lib/plain-data";
import type { ConsumedComboFailure } from "./core-options";
import { isReserveQuotaCode } from "./combo-stream-preflight";

/** An owner may release opaque state only on positive quota evidence, not on every hoppable 429. */
export function isOwnerCapacityRefusal(status: number, failure: Pick<ConsumedComboFailure,
  "wsConfirmedCapacity" | "wrappedReserveQuota" | "upstreamCode" | "upstreamRootCode" | "upstreamType" | "classificationText">): boolean {
  if (failure.wsConfirmedCapacity !== undefined) return failure.wsConfirmedCapacity;
  const { upstreamCode: code, upstreamRootCode: rootCode, upstreamType } = failure;
  return (failure.wrappedReserveQuota === true || ((status === 429 || status === 402)
    && isReserveQuotaCode(code ?? upstreamType) && (!upstreamType || isReserveQuotaCode(upstreamType))))
    && (!rootCode || isReserveQuotaCode(rootCode))
    && comboFailureDecision(status, failure.classificationText, { code, rootCode }) === "hop";
}

/** Classify the original terminal before presentation can discard a conflicting verdict. */
export function terminalOwnerCapacityStatus(frame: unknown, wrapperStatus?: 402 | 429): 402 | 429 | undefined {
  if (!isPlainObject(frame)) return;
  const snapshot = frame.response;
  if (wrapperStatus !== undefined ? frame.type !== "error" || snapshot !== undefined
    : !isPlainObject(snapshot) || (frame.type !== "response.failed" && frame.type !== "response.incomplete")) return;
  const response = isPlainObject(snapshot) ? snapshot : undefined;
  const error = wrapperStatus !== undefined ? frame.error : response?.error ?? response?.incomplete_details;
  if (!isPlainObject(error)) return;
  const code = error.code ?? error.reason ?? error.type;
  if (typeof code !== "string" || !isReserveQuotaCode(code)) return;
  const status = wrapperStatus ?? (code === "usage_not_included" ? 402 : 429);
  if (response?.status != null && frame.type !== `response.${response.status}`) return;
  const messages: string[] = [];
  for (const carrier of [frame, response, frame.error, frame.last_error, frame.incomplete_details, response?.error, response?.last_error, response?.incomplete_details]) {
    if (carrier == null) continue;
    if (!isPlainObject(carrier) || carrier.retryable === false || [carrier.code, carrier.reason, carrier === frame ? null : carrier.type]
      .some(tag => tag != null && !isReserveQuotaCode(tag))) return;
    if (typeof carrier.message === "string") messages.push(carrier.message);
  }
  return isOwnerCapacityRefusal(status, { upstreamCode: code, classificationText: messages.join("\n") }) ? status : undefined;
}
