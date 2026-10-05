import { managementApi } from "../utils/management-api-client";
import {
  parseNetworkReturnReference,
  type NetworkReturnReference,
} from "../../shared/agentNetworkReturn";
import type { SessionEvent } from "../inbox/session-event";
import { returnSessionEventSchema } from "@myagents/agent-network-protocol";

export type NetworkReturnSettlement = "delivered" | "unconfirmed" | "dropped";

/** Preserve the existing terminal hook and per-turn metadata. The App owns
 * the peer identity and encryption; a Sidecar cannot select a remote device. */
export async function deliverNetworkReturn(
  reference: NetworkReturnReference,
  event: SessionEvent,
): Promise<NetworkReturnSettlement> {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (
    !sidecarId ||
    !parseNetworkReturnReference(reference) ||
    !returnSessionEventSchema.safeParse(event).success
  )
    return "dropped";
  const result = await managementApi(
    "/api/agent-network/return",
    "POST",
    {
      sidecarId,
      reference,
      event,
    },
    { timeoutMs: 32_000 },
  );
  if (result.ok !== true)
    return result.code === "transport_outcome_unknown"
      ? "unconfirmed"
      : "dropped";
  return result.settlement === "delivered" || result.settlement === "dropped"
    ? result.settlement
    : "unconfirmed";
}
