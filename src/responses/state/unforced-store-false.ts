/**
 * Closed provenance and replay gating for unforced store:false client tool call responses.
 *
 * An unforced store:false response is cached exclusively to allow the client to send a matching
 * function/custom tool output continuation on the next turn. Normal replay, text continuation, or
 * mismatched output without a matching pending call fails replay and requires the client to
 * supply the full conversation.
 */

export function hasPendingClientToolCall(output: readonly unknown[]): boolean {
  return output.some(item =>
    !!item && typeof item === "object" && clientToolOutputType((item as { type?: unknown }).type) !== undefined,
  );
}

export function allowsUnforcedStoreFalseReplay(
  stored: readonly unknown[],
  providerOutputStart: number | undefined,
  clientInput: readonly unknown[],
  carried: number,
): boolean {
  if (typeof providerOutputStart !== "number" || !Number.isSafeInteger(providerOutputStart)
    || providerOutputStart < 0 || providerOutputStart > stored.length) return false;
  const anchor = providerOutputStart;
  // call_id -> expected output type and the stored index of the call it answers.
  const pendingCallIds = new Map<string, { outputType: string; index: number }>();
  stored.slice(anchor).forEach((item, offset) => {
    if (item && typeof item === "object") {
      const outputType = clientToolOutputType((item as { type?: unknown }).type);
      const callId = (item as { call_id?: unknown }).call_id;
      if (outputType && typeof callId === "string" && callId) pendingCallIds.set(callId, { outputType, index: anchor + offset });
    }
  });
  // A carried result answers a pending call only when it comes after that call: a provider can reuse
  // a call_id, and an older result for the earlier call must not clear the new one.
  for (let i = 0; i < carried; i++) {
    const item = clientInput[i];
    if (item && typeof item === "object") {
      const callId = (item as { call_id?: unknown }).call_id;
      const pending = typeof callId === "string" ? pendingCallIds.get(callId) : undefined;
      if (pending && pending.outputType === (item as { type?: unknown }).type && i > pending.index) {
        pendingCallIds.delete(callId as string);
      }
    }
  }
  return clientInput.slice(carried).some(item => {
    if (item && typeof item === "object") {
      const callId = (item as { call_id?: unknown }).call_id;
      return typeof callId === "string" && pendingCallIds.get(callId)?.outputType === (item as { type?: unknown }).type;
    }
    return false;
  });
}

/** Closed call/output pairs supported by the client-owned continuation path. */
function clientToolOutputType(type: unknown): string | undefined {
  if (type === "function_call") return "function_call_output";
  if (type === "custom_tool_call") return "custom_tool_call_output";
  return undefined;
}
