import type { AgentModelSelection } from './agentConfigMutation';
import type { RuntimeType } from './types/runtime';
export interface TeamPeer {
  sessionKey: string;
  sourceType: 'private' | 'group';
  sourceId: string;
  name: string | null;
  sessionId: string | null;
  sessionIds: string[];
  lastActive: string | null;
}
export interface TeamChannel {
  channelId: string;
  platform: string;
  name: string | null;
  enabled: boolean;
  online: boolean;
  status: string;
  error?: string | null;
  peers: TeamPeer[];
}
export interface TeamModelMenu {
  snapshotObservation: string;
  runtime: RuntimeType;
  runtimeSource?: string;
  model?: string;
  reasoningEffort?: string;
  reasoningEffortChoices?: readonly string[] | null;
  options: { selection: AgentModelSelection; group: string; name: string; isCurrent: boolean; requiresNewSession: boolean }[];
}
export interface TeamTools {
  canManageExtensions: boolean;
  snapshotObservation: string;
  mcp: { id: string; name: string }[];
  plugins: { id: string; name: string }[];
  official: { id: string; name: string }[];
  mcpEnabledServers: string[];
  enabledPluginIds: string[];
  enabledOfficialToolIds: string[];
}
export type TeamAction =
  | { kind: 'options' | 'tools' | 'new' | 'stop' }
  | { kind: 'setPrimary'; sessionId: string }
  | { kind: 'selectModel'; selection: AgentModelSelection; snapshotObservation: string; confirmed: boolean }
  | { kind: 'switchRuntime'; runtime: RuntimeType; snapshotObservation: string }
  | { kind: 'setEffort'; effort: string; snapshotObservation: string }
  | { kind: 'saveTools'; snapshotObservation: string; mcpEnabledServers?: string[]; enabledPluginIds?: string[]; enabledOfficialToolIds: string[] };
export interface TeamActionResult {
  success?: boolean;
  error?: string;
  warning?: string;
  statePersisted?: boolean;
  notified?: boolean;
  sessionId?: string;
  createdSessionId?: string;
  requiresNewSession?: boolean;
  runtimeApply?: string;
  sessionConfig?: string;
}
export interface TeamSessionTarget { channelId: string; sessionKey: string; sessionId: string }
export interface TeamSessionState extends TeamSessionTarget { state: string | null; error?: string }

/** Native CLI MCP/plugins belong to CLI config; integrated/managed runtimes expose Product controls. */
export function canManageSessionExtensions(runtime: string | undefined, source: string | undefined): boolean {
  return runtime === 'builtin' || runtime === 'dsh' || source === 'managed-provider';
}
