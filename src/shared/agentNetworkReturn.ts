import { CANONICAL_UUID } from "@myagents/agent-network-protocol";

/** Opaque App-owned return context, bound to one accepted inbox turn/watch.
 * It conveys no authority by itself: Rust verifies the live target process,
 * connection generation and original operation before emitting an event. */
export interface NetworkReturnReference {
  opId: string;
  returnRouteId: string;
}

export function parseNetworkReturnReference(
  value: unknown,
): NetworkReturnReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.opId !== "string" ||
    !CANONICAL_UUID.test(record.opId) ||
    typeof record.returnRouteId !== "string" ||
    !CANONICAL_UUID.test(record.returnRouteId)
  )
    return null;
  return { opId: record.opId, returnRouteId: record.returnRouteId };
}
