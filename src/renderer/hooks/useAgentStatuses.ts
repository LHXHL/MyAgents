// Narrow view over the existing app-level Agent status projection.
import { useCallback, useSyncExternalStore } from 'react';
import {
  subscribeAgentStatuses,
  getAgentStatusesSnapshot,
  refreshAgentStatuses,
} from './taskCenterStore';

export interface ActiveSessionData {
  sessionKey: string;
  sessionId: string;
  sourceType: 'private' | 'group';
  sourceId?: string;
  sourceDisplayName?: string;
  lastSenderName?: string;
  workspacePath: string;
  messageCount: number;
  metadataBirthPending?: boolean;
  metadataIndexed?: boolean;
  lastActive: string;
}

interface ChannelStatusData {
  channelId: string;
  channelType: string;
  name?: string;
  status: 'online' | 'connecting' | 'error' | 'stopped';
  botUsername?: string;
  uptimeSeconds: number;
  lastMessageAt?: string;
  activeSessions: ActiveSessionData[];
  errorMessage?: string;
  restartCount: number;
  bufferedMessages: number;
  bindUrl?: string;
  bindCode?: string;
}

interface AgentStatusData {
  agentId: string;
  agentName: string;
  enabled: boolean;
  channels: ChannelStatusData[];
}

type AgentStatusMap = Record<string, AgentStatusData>;

const subscribeDisabled = () => () => {};

export function useAgentStatuses(enabled = true) {
  const snapshot = useSyncExternalStore(enabled ? subscribeAgentStatuses : subscribeDisabled, getAgentStatusesSnapshot);
  const refresh = useCallback(() => { if (enabled) refreshAgentStatuses(); }, [enabled]);
  return { statuses: snapshot.statuses, loading: enabled && snapshot.loading, refresh };
}

export type { AgentStatusData, ChannelStatusData, AgentStatusMap };
