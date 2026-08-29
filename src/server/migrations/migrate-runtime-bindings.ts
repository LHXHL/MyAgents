import {
  parseAgentRuntimePreference,
  preferenceFromLegacyAgentFacts,
  type AgentRuntimePreference,
} from "../../shared/integrated-runtimes/identity";
import { atomicModifyConfig, type AgentConfigSlim } from "../utils/admin-config";

export const AGENT_RUNTIME_PREFERENCE_SCHEMA_VERSION = 1;

type RuntimePreferenceAgent = Partial<AgentConfigSlim> & {
  [key: string]: unknown;
  runtimePreference?: unknown;
  runtime?: unknown;
  runtimeConfig?: unknown;
  providerId?: unknown;
  channels?: unknown;
};

type RuntimePreferenceChannel = {
  [key: string]: unknown;
  id?: unknown;
  overrides?: unknown;
};

export type RuntimePreferenceMigrationResult = {
  migratedAgents: number;
  migratedChannels: number;
  incompatibleAgentIds: string[];
  incompatibleChannelIds: string[];
};

export function migrateAgentRuntimePreferenceRecord(
  agent: RuntimePreferenceAgent,
):
  | { status: "unchanged"; agent: RuntimePreferenceAgent }
  | {
      status: "migrated";
      agent: RuntimePreferenceAgent & {
        runtimePreference: AgentRuntimePreference;
      };
    }
  | { status: "incompatible"; agent: RuntimePreferenceAgent } {
  if (agent.runtimePreference !== undefined) {
    return parseAgentRuntimePreference(agent.runtimePreference)
      ? { status: "unchanged", agent }
      : { status: "incompatible", agent };
  }
  const runtimeSource =
    agent.runtimeConfig &&
    typeof agent.runtimeConfig === "object" &&
    !Array.isArray(agent.runtimeConfig)
      ? (agent.runtimeConfig as Record<string, unknown>).source
      : undefined;
  const preference = preferenceFromLegacyAgentFacts({
    runtime: agent.runtime,
    runtimeSource,
    providerId: agent.providerId,
  });
  if (!preference) return { status: "incompatible", agent };
  return {
    status: "migrated",
    agent: {
      ...agent,
      runtimePreference: preference,
    },
  };
}

export async function migrateAgentRuntimePreferences(): Promise<RuntimePreferenceMigrationResult> {
  let migratedAgents = 0;
  let migratedChannels = 0;
  const incompatibleAgentIds: string[] = [];
  const incompatibleChannelIds: string[] = [];

  await atomicModifyConfig((config) => {
    const agents = (config.agents ?? []) as RuntimePreferenceAgent[];
    let changed = false;
    const nextAgents = agents.map((agent) => {
      const result = migrateAgentRuntimePreferenceRecord(agent);
      let nextAgent = result.agent;
      if (result.status === "migrated") {
        changed = true;
        migratedAgents += 1;
      } else if (result.status === "incompatible") {
        incompatibleAgentIds.push(String(agent.id ?? "<unknown>"));
      }
      const channels = Array.isArray(nextAgent.channels)
        ? (nextAgent.channels as RuntimePreferenceChannel[])
        : undefined;
      if (channels) {
        const nextChannels = channels.map((channel) => {
          if (
            !channel.overrides ||
            typeof channel.overrides !== "object" ||
            Array.isArray(channel.overrides)
          ) {
            return channel;
          }
          const overrides = channel.overrides as RuntimePreferenceAgent;
          if (
            overrides.runtime === undefined &&
            overrides.runtimePreference === undefined
          ) {
            return channel;
          }
          const channelResult = migrateAgentRuntimePreferenceRecord({
            ...overrides,
            providerId: overrides.providerId ?? nextAgent.providerId,
          });
          if (channelResult.status === "migrated") {
            changed = true;
            migratedChannels += 1;
          } else if (channelResult.status === "incompatible") {
            incompatibleChannelIds.push(
              `${String(nextAgent.id ?? "<unknown>")}/${String(channel.id ?? "<unknown>")}`,
            );
          }
          if (channelResult.agent === overrides) return channel;
          const nextOverrides = { ...channelResult.agent };
          if (overrides.providerId === undefined) delete nextOverrides.providerId;
          return { ...channel, overrides: nextOverrides };
        });
        if (nextChannels.some((channel, index) => channel !== channels[index])) {
          nextAgent = {
            ...nextAgent,
            channels: nextChannels as AgentConfigSlim["channels"],
          };
        }
      }
      return nextAgent;
    });
    const currentVersion = config.agentRuntimePreferenceSchemaVersion;
    if (currentVersion !== AGENT_RUNTIME_PREFERENCE_SCHEMA_VERSION) changed = true;
    return changed
      ? {
          ...config,
          agents: nextAgents as AgentConfigSlim[],
          agentRuntimePreferenceSchemaVersion:
            AGENT_RUNTIME_PREFERENCE_SCHEMA_VERSION,
        }
      : config;
  });

  return {
    migratedAgents,
    migratedChannels,
    incompatibleAgentIds,
    incompatibleChannelIds,
  };
}
