import { invoke } from '@tauri-apps/api/core';
import type { TeamAction, TeamActionResult, TeamChannel, TeamPeer, TeamSessionTarget, TeamSessionState } from '@/../shared/teamAi';
export const teamStates = (agentId: string, targets: TeamSessionTarget[]) => invoke<{ states: TeamSessionState[] }>('cmd_team_ai_states', { agentId, targets });
export const teamChannels = (agentId: string) => invoke<{ channels: TeamChannel[] }>('cmd_team_ai_channels', { agentId });
export const teamAction = <T = TeamActionResult>(agentId: string, channelId: string, peer: Pick<TeamPeer, 'sessionKey' | 'sessionId'>, action: TeamAction) =>
  invoke<T>('cmd_team_ai_action', { agentId, channelId, sessionKey: peer.sessionKey, expectedSessionId: peer.sessionId, action });
/** After a Chat snapshot write in a Team AI workspace; Rust no-ops unless the Session is a peer's current one. */
export const syncTeamAiPeerProfile = (agentId: string, sessionId: string) =>
  invoke<{ peerProfile: 'saved' | 'failed' | null }>('cmd_team_ai_sync_peer_profile', { agentId, sessionId });
