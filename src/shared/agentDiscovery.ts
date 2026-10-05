import { z } from "zod";
import {
  CANONICAL_UUID,
  parseAgentReference,
  NETWORK_BUDGETS,
} from "@myagents/agent-network-protocol";

export const mentionAgentSchema = z.strictObject({
  selector: z.string().min(1).max(256),
  name: z.string().min(1).max(4096),
  isLocal: z.boolean(),
  icon: z.string().max(256).nullable().optional(),
  deviceId: z.string().max(256).nullable(),
  deviceName: z.string().max(4096).nullable(),
  platform: z.string().max(256).nullable(),
  description: z.string().max(4096).nullable(),
  networkName: z.string().max(512).nullable().optional(),
  connectionId: z.string().max(256).optional(),
  source: z
    .strictObject({
      serviceId: z.string().regex(CANONICAL_UUID),
      networkId: z.string().regex(CANONICAL_UUID),
    })
    .nullable(),
});
export type MentionAgentInfo = z.infer<typeof mentionAgentSchema>;
export const discoveryContextSchema = z.strictObject({
  authGeneration: z.number().int().nonnegative(),
  principalId: z.string().max(256).nullable(),
  networkId: z.string().max(256).nullable(),
});
export const discoveryNetworkSchema = z.strictObject({
  connectionId: z.string().max(256),
  networkName: z.string().max(512),
  complete: z.boolean(),
  networkStatus: z.string().max(64),
  context: discoveryContextSchema
    .extend({
      deviceId: z.string(),
      deviceName: z.string().nullable(),
      platform: z.string(),
    })
    .nullable(),
  error: z
    .object({ code: z.string(), retryable: z.boolean() })
    .passthrough()
    .optional(),
});
export const agentDiscoverySchema = z.strictObject({
  networks: z.array(discoveryNetworkSchema).optional(),
  items: z.array(mentionAgentSchema).max(NETWORK_BUDGETS.catalogItems),
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
  authGeneration: z.number().int().nonnegative(),
  principalId: z.string().max(256).nullable(),
  networkId: z.string().max(256).nullable(),
});
export type AgentDiscovery = z.infer<typeof agentDiscoverySchema>;
const key = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase("en-US");
export function filterMentionAgents(
  items: MentionAgentInfo[],
  keyword: string,
): MentionAgentInfo[] {
  const query = key(keyword.trim());
  return items
    .filter(
      (item) =>
        !query ||
        [item.name, item.deviceName, item.networkName, item.description].some(
          (text) => text && key(text).includes(query),
        ),
    )
    .sort(
      (a, b) =>
        Number(b.isLocal) - Number(a.isLocal) ||
        key(a.name).localeCompare(key(b.name), "en-US") ||
        (a.deviceId ?? "").localeCompare(b.deviceId ?? "") ||
        a.selector.localeCompare(b.selector),
    );
}
export function validateMentionAgent(input: unknown): MentionAgentInfo {
  const item = mentionAgentSchema.parse(input);
  if (item.isLocal) {
    if (
      item.source ||
      item.selector.startsWith("ma-agent:") ||
      item.selector.startsWith("ma-session:")
    )
      throw new Error("AGENT_SCOPE_INVALID");
  } else {
    const reference = parseAgentReference(item.selector);
    if (
      !item.source ||
      reference.serviceId !== item.source.serviceId ||
      reference.networkId !== item.source.networkId ||
      !item.deviceId
    )
      throw new Error("AGENT_SCOPE_INVALID");
  }
  return item;
}

/** A saved mention is bound to its issuing network, independent of page selection. */
export function discoveryContext(
  discovery: AgentDiscovery,
  agent: MentionAgentInfo,
) {
  if (!agent.isLocal && agent.connectionId && discovery.networks) {
    return (
      discovery.networks.find((n) => n.connectionId === agent.connectionId)
        ?.context ?? null
    );
  }
  return discovery;
}
