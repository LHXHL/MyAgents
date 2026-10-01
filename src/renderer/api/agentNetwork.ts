import { invoke } from "@tauri-apps/api/core";
import {
  metadataSchemas,
  NETWORK_BUDGETS,
} from "@myagents/agent-network-protocol";
import type { z } from "zod";
export type NetworkInfo = z.infer<typeof metadataSchemas.network>;
export type NetworkDevice = z.infer<
  typeof metadataSchemas.devices
>["items"][number];
export type NetworkAgent = z.infer<
  typeof metadataSchemas.agents
>["items"][number];
export type CallableAgent = z.infer<
  typeof metadataSchemas.callable
>["items"][number];
export interface NetworkFailure {
  code: string;
  retryable: boolean;
  details?: unknown;
}
export interface NetworkSnapshot {
  state: "signedOut" | "connecting" | "ready" | "disconnected" | "unavailable";
  principalId: string | null;
  networkId: string | null;
  error: NetworkFailure | null;
  revision: number;
  authGeneration: number;
}
export type NetworkRequest =
  | { kind: "network" }
  | { kind: "devices"; cursor: string | null; limit: number }
  | { kind: "agents"; deviceId: string; cursor: string | null; limit: number }
  | {
      kind: "callable";
      networkId: string;
      cursor: string | null;
      limit: number;
    }
  | {
      kind: "membership";
      networkId: string;
      deviceId: string;
      joined: boolean;
      mutationId: string;
      expectedMembershipRevision: number;
    }
  | {
      kind: "enabled";
      networkId: string;
      mountId: string;
      enabled: boolean;
      mutationId: string;
      expectedMembershipRevision: number;
      expectedEnableRevision: number;
    }
  | {
      kind: "description";
      networkId: string;
      mountId: string;
      description: string | null;
      mutationId: string;
      expectedMembershipRevision: number;
      expectedDescriptionRevision: number;
    }
  | { kind: "receipt"; mutationId: string };
export function networkSnapshot(): Promise<NetworkSnapshot> {
  return invoke("cmd_agent_network_snapshot");
}
export async function networkRequest(
  request: NetworkRequest,
): Promise<unknown> {
  try {
    return await invoke("cmd_agent_network_request", { request });
  } catch (error) {
    // Rechecking a mutation receipt is a read, never a second mutation.
    if (
      "mutationId" in request &&
      request.kind !== "receipt" &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ["NETWORK_REQUEST_UNCONFIRMED", "NETWORK_TRANSPORT_FAILED"].includes(
        String(error.code),
      )
    ) {
      try {
        return await invoke("cmd_agent_network_request", {
          request: { kind: "receipt", mutationId: request.mutationId },
        });
      } catch {
        throw error;
      } // A failed receipt read cannot turn an uncertain write into a definite failure.
    }
    throw error;
  }
}
export async function allNetworkDevices(): Promise<{
  items: NetworkDevice[];
  complete: boolean;
}> {
  const items: NetworkDevice[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const page = metadataSchemas.devices.parse(
      await networkRequest({
        kind: "devices",
        cursor,
        limit: NETWORK_BUDGETS.pageMax,
      }),
    );
    for (const device of page.items) {
      if (seen.has(device.deviceId)) throw new Error("NETWORK_PAGE_INVALID");
      seen.add(device.deviceId);
      items.push(device);
    }
    if (page.complete) return { items, complete: true };
    if (!page.nextCursor || page.nextCursor === cursor)
      throw new Error("NETWORK_PAGE_INVALID");
    if (items.length >= NETWORK_BUDGETS.catalogItems)
      return { items, complete: false };
    cursor = page.nextCursor;
  }
}
export async function allDeviceAgents(
  deviceId: string,
): Promise<{ items: NetworkAgent[]; complete: boolean }> {
  const items: NetworkAgent[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const page = metadataSchemas.agents.parse(
      await networkRequest({
        kind: "agents",
        deviceId,
        cursor,
        limit: NETWORK_BUDGETS.pageMax,
      }),
    );
    for (const agent of page.items) {
      if (seen.has(agent.mountId)) throw new Error("NETWORK_PAGE_INVALID");
      seen.add(agent.mountId);
      items.push(agent);
    }
    if (page.complete) return { items, complete: true };
    if (!page.nextCursor || page.nextCursor === cursor)
      throw new Error("NETWORK_PAGE_INVALID");
    if (items.length >= NETWORK_BUDGETS.catalogItems)
      return { items, complete: false };
    cursor = page.nextCursor;
  }
}
export function networkErrorKey(
  error: unknown,
  operation: "read" | "mutation" = "read",
): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (
    [
      "REVISION_CONFLICT",
      "MEMBERSHIP_REVISION_CONFLICT",
      "CONNECTION_EPOCH_MISMATCH",
    ].includes(code)
  )
    return "conflict";
  if (code === "DESCRIPTION_TOO_LARGE") return "descriptionTooLong";
  if (
    operation === "mutation" &&
    [
      "NETWORK_REQUEST_UNCONFIRMED",
      "NETWORK_TRANSPORT_FAILED",
      "MUTATION_RESULT_UNKNOWN",
    ].includes(code)
  )
    return "unconfirmed";
  if (code === "NETWORK_SERVICE_UNCONFIGURED") return "unconfigured";
  return "failed";
}
