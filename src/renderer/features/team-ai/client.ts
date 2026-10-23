import { invoke } from '@tauri-apps/api/core';
import type { TeamAction, TeamActionResult, TeamChannel, TeamPeer, TeamSessionTarget, TeamSessionState } from '@/../shared/teamAi';
import type { SessionData, SessionMessage } from '@/api/sessionClient';
export type TeamSessionData = SessionData & { liveSessionState?: string | null; liveStreamingMessage?: SessionMessage | null };
export const teamStates = (agentId: string, targets: TeamSessionTarget[]) => invoke<{ states: TeamSessionState[] }>('cmd_team_ai_states', { agentId, targets });
export const teamChannels = (agentId: string) => invoke<{ channels: TeamChannel[] }>('cmd_team_ai_channels', { agentId });
export const teamSession = (agentId: string, channelId: string, sessionKey: string, sessionId: string) =>
  invoke<{ session: TeamSessionData }>('cmd_team_ai_session', { agentId, channelId, sessionKey, sessionId });
export const teamAction = <T = TeamActionResult>(agentId: string, channelId: string, peer: Pick<TeamPeer, 'sessionKey' | 'sessionId'>, action: TeamAction) =>
  invoke<T>('cmd_team_ai_action', { agentId, channelId, sessionKey: peer.sessionKey, expectedSessionId: peer.sessionId, action });
