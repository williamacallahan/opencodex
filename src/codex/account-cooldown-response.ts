// Local quota advice is not an upstream target-wide retry directive. Response identity keeps
// this distinction private to the process: headers, body copies and HTTP hops cannot mint it.
const issuerCapacityResponses = new WeakSet<Response>();
export function markIssuerCapacityRefusal(response: Response): Response { issuerCapacityResponses.add(response); return response; }
export const isIssuerCapacityRefusal = (response: Response): boolean => issuerCapacityResponses.has(response);

const accountCooldownResponses = new WeakSet<Response>();

/** Minted only by mapCodexAuthContextErrorToResponse for an ordinary CodexAccountCooldownError. */
export function markCodexAccountCooldownResponse(response: Response): Response {
  accountCooldownResponses.add(response);
  return response;
}

export function isCodexAccountCooldownResponse(response: Response): boolean {
  return accountCooldownResponses.has(response);
}

/** Preserve provenance across the combo's bounded error-body reconstruction. */
const lunaStoreMismatchResponses = new WeakSet<Response>();
export function markLunaStoreMismatchResponse(response: Response): Response {
  lunaStoreMismatchResponses.add(response);
  return response;
}
export const isLunaStoreMismatchResponse = (response: Response): boolean => lunaStoreMismatchResponses.has(response);

export function carryCodexAccountCooldownResponse(from: Response, to: Response): void {
  if (issuerCapacityResponses.has(from)) issuerCapacityResponses.add(to);
  if (accountCooldownResponses.has(from)) accountCooldownResponses.add(to);
  if (lunaStoreMismatchResponses.has(from)) lunaStoreMismatchResponses.add(to);
}
