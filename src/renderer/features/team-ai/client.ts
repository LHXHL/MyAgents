import { invoke } from '@tauri-apps/api/core';
import type { TeamAction, TeamActionResult, TeamChannel, TeamPeer, TeamPeerConfig, TeamSessionTarget, TeamSessionState } from '@/../shared/teamAi';
export const teamStates = (agentId: string, targets: TeamSessionTarget[]) => invoke<{ states: TeamSessionState[] }>('cmd_team_ai_states', { agentId, targets });
/** Read-only; works while the Channel is stopped. */
export const teamPeerConfig = (agentId: string, channelId: string, sessionKey: string | null) => {
  if (!sessionKey) return Promise.reject(new Error('Conversation has not started'));
  return invoke<TeamPeerConfig>('cmd_team_ai_peer_config', { agentId, channelId, sessionKey });
};
export const teamChannels = (agentId: string) => invoke<{ channels: TeamChannel[] }>('cmd_team_ai_channels', { agentId });
export const teamAction = <T = TeamActionResult>(agentId: string, channelId: string, peer: Pick<TeamPeer, 'sessionKey' | 'sessionId'>, action: TeamAction) => {
  if (!peer.sessionKey) return Promise.reject(new Error('Conversation has not started'));
  return invoke<T>('cmd_team_ai_action', { agentId, channelId, sessionKey: peer.sessionKey, expectedSessionId: peer.sessionId, action });
};
/** Same Channel writer as settings, with a disk-current pending-state check. */
export const reviewTeamGroup = (channelId: string, groupId: string, decision: 'approve' | 'reject') =>
  invoke<void>(decision === 'approve' ? 'cmd_approve_group' : 'cmd_reject_group', { botId: channelId, groupId, onlyPending: true });
/** After a Chat snapshot write in a Team AI workspace; Rust no-ops unless the Session is a peer's current one. */
export const syncTeamAiPeerProfile = (agentId: string, sessionId: string) =>
  invoke<{ peerProfile: 'saved' | 'failed' | null }>('cmd_team_ai_sync_peer_profile', { agentId, sessionId });
