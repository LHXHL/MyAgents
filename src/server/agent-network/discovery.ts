import { resolvePersistedAgentWorkspaceRegistry } from "../utils/agent-workspace-identity";
import {
  isProjectArchived,
  isProjectVisibleToUser,
} from "../../shared/config-types";
import { z } from "zod";
import { NETWORK_BUDGETS } from "@myagents/agent-network-protocol";
import {
  mentionAgentSchema,
  discoveryNetworkSchema,
  type AgentDiscovery,
  type MentionAgentInfo,
} from "../../shared/agentDiscovery";
import { managementApi } from "../utils/management-api-client";

const remoteSchema = z.strictObject({
  items: z
    .array(
      mentionAgentSchema.extend({ localAgentId: z.string().min(1).max(256) }),
    )
    .max(NETWORK_BUDGETS.catalogItems),
  complete: z.boolean(),
  networkStatus: z.enum([
    "signedOut",
    "connecting",
    "ready",
    "disconnected",
    "unavailable",
    "incomplete",
    "error",
  ]),
  networks: z.array(discoveryNetworkSchema).optional(),
  context: z
    .strictObject({
      authGeneration: z.number().int().nonnegative(),
      deviceId: z.string(),
      deviceName: z.string().nullable(),
      platform: z.string(),
      networkId: z.string().nullable(),
      principalId: z.string().nullable(),
    })
    .nullable(),
});
interface LocalAgent {
  agentId: string;
  name: string;
  archived?: boolean;
  icon?: string;
}
export async function discoverAgents(
  local: LocalAgent[],
  localOnly = false,
): Promise<AgentDiscovery> {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  const result = sidecarId
    ? await managementApi(
        "/api/agent-network/discovery",
        "POST",
        { sidecarId, localOnly },
        { timeoutMs: 8_000 },
      )
    : null;
  const remote =
    result?.ok === true ? remoteSchema.safeParse(result.data) : null;
  const network = remote?.success ? remote.data : null;
  const context = network?.context;
  const items: MentionAgentInfo[] = local
    .filter((item) => !item.archived)
    .map((item) =>
      mentionAgentSchema.parse({
        selector: item.agentId,
        name: item.name,
        icon: item.icon ?? null,
        isLocal: true,
        deviceId: context?.deviceId ?? null,
        deviceName: context?.deviceName ?? null,
        platform: context?.platform ?? null,
        description: null,
        source: null,
      }),
    );
  const locals = new Map(items.map((item) => [item.selector, item]));
  if (network)
    for (const candidate of network.items) {
      if (
        candidate.deviceId ===
        (network.networks?.find(
          (n) => n.connectionId === candidate.connectionId,
        )?.context?.deviceId ?? context?.deviceId)
      ) {
        // Only the actual owning device/local identity may collapse this alias.
        const owned = locals.get(candidate.localAgentId);
        if (owned) owned.description = candidate.description;
        continue;
      }
      items.push(
        mentionAgentSchema.parse({
          selector: candidate.selector,
          name: candidate.name,
          icon: candidate.icon ?? null,
          isLocal: false,
          deviceId: candidate.deviceId,
          deviceName: candidate.deviceName,
          platform: candidate.platform,
          description: candidate.description,
          source: candidate.source,
          networkName: candidate.networkName,
          connectionId: candidate.connectionId,
        }),
      );
    }
  const limited = items.length > NETWORK_BUDGETS.catalogItems;
  return {
    networks: network?.networks,
    items: limited ? items.slice(0, NETWORK_BUDGETS.catalogItems) : items,
    complete: !limited && (network?.complete ?? false),
    networkStatus: limited ? "incomplete" : (network?.networkStatus ?? "error"),
    authGeneration: context?.authGeneration ?? 0,
    principalId: context?.principalId ?? null,
    networkId: context?.networkId ?? null,
  };
}

/** Shared business projection. Admin HTTP and query preparation use the same
 * Workspace identity owner, without importing an API handler into SessionEngine. */
export async function getAgentDiscovery(
  localOnly = false,
): Promise<AgentDiscovery> {
  const registry = await resolvePersistedAgentWorkspaceRegistry();
  return discoverAgents(
    registry.agentProjections
      .filter(
        (identity) =>
          !identity.project ||
          (isProjectVisibleToUser(identity.project) &&
            !isProjectArchived(identity.project)),
      )
      .map((identity) => ({
        agentId: identity.agent.id,
        name: identity.agent.name,
        icon: identity.project?.icon,
      })),
    localOnly,
  );
}
