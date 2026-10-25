import type { AgentModelSelection } from './agentConfigMutation';
import type { RuntimeSource, RuntimeType } from './types/runtime';
import type { RuntimeBackedProviderIdentity } from './providerExecution';
import type { OfficialToolId } from './official-tools';
export interface TeamPeer {
  sessionKey: string;
  sourceType: 'private' | 'group';
  sourceId: string;
  name: string | null;
  sessionId: string | null;
  sessionIds: string[];
  /** The peer owns a profile: new Sessions use it instead of the Agent defaults. */
  hasProfile: boolean;
}
export interface TeamChannel {
  channelId: string;
  platform: string;
  name: string | null;
  enabled: boolean;
  online: boolean;
  status: string;
  /** Last connection error reported by the running Channel. */
  error?: string | null;
  /** The Channel's persisted state could not be read; peers are unknown, not empty. */
  loadError?: string | null;
  peers: TeamPeer[];
}
/**
 * Team AI peer config: the complete birth choice of one private chat / group.
 * Stored opaquely by Rust (`channels[].peerProfiles`); Node validates and composes it.
 * Permission is deliberately absent: IM births use the Runtime's unattended mode.
 */
export interface TeamPeerProfile {
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
  providerExecutionIdentity?: RuntimeBackedProviderIdentity;
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
  mcpEnabledServers?: string[];
  enabledPluginIds?: string[];
  enabledOfficialToolIds?: OfficialToolId[];
}
export interface TeamModelOption {
  selection: AgentModelSelection;
  group: string;
  name: string;
  isCurrent: boolean;
  /** The current Session can take this model without a new Session. */
  appliesNow: boolean;
}
/** What new Sessions of a peer use, plus the catalogue to edit it. */
export interface TeamPeerConfig {
  config: TeamPeerProfile;
  /** true = the peer owns a profile; false = it follows the Agent defaults. */
  custom: boolean;
  models: TeamModelOption[];
  effortChoices: readonly string[] | null;
  tools: { canManageExtensions: boolean; mcp: { id: string; name: string }[]; plugins: { id: string; name: string }[]; official: { id: string; name: string }[] };
}
export type TeamConfigChange =
  | { runtime: RuntimeType }
  | { selection: AgentModelSelection }
  | { effort: string }
  | { tools: { mcpEnabledServers?: string[]; enabledPluginIds?: string[]; enabledOfficialToolIds: string[] } };
export type TeamAction =
  | { kind: 'new' | 'clearProfile' }
  | { kind: 'setPrimary'; sessionId: string }
  | { kind: 'updateConfig'; change: TeamConfigChange };
export interface TeamActionResult {
  success?: boolean;
  error?: string;
  warning?: string;
  statePersisted?: boolean;
  notified?: boolean;
  sessionId?: string;
  createdSessionId?: string;
  sessionConfig?: string;
  /** Whether the peer profile was written (`null` when not applicable). */
  peerProfile?: 'saved' | 'failed' | null;
  /** updateConfig: whether the current Session now runs the change; `skipped` = only new Sessions take it. */
  sessionApply?: 'applied' | 'deferred' | 'pending-next-turn' | 'skipped' | 'failed';
}
export interface TeamSessionTarget { channelId: string; sessionKey: string; sessionId: string }
export interface TeamSessionState extends TeamSessionTarget { state: string | null; error?: string }

/** Native CLI MCP/plugins belong to CLI config; integrated/managed runtimes expose Product controls. */
export function canManageSessionExtensions(runtime: string | undefined, source: string | undefined): boolean {
  return runtime === 'builtin' || runtime === 'dsh' || source === 'managed-provider';
}
