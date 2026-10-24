// Pure projections for the Team AI page. Authority stays with the Rust Channel
// owner (peers, bindings, profiles) and SessionStore (Session metadata); these
// helpers only shape that data for display.
import type { SessionMetadata } from '@/api/sessionClient';
import type { TeamChannel, TeamPeer, TeamSessionState } from '@/../shared/teamAi';

/** What the operator needs to know about a Session right now. `dormant` = no
 *  process: not an error, the Channel starts it on the next message. `unknown`
 *  = the observation itself failed, which must not be shown as dormant. */
export type SessionActivity = 'running' | 'starting' | 'compacting' | 'error' | 'interrupted' | 'idle' | 'dormant' | 'unknown';

export function sessionActivity(observation: Pick<TeamSessionState, 'state' | 'error'> | undefined): SessionActivity {
  // No observation row (e.g. beyond the bounded batch) is unknown; only an explicit
  // `state: null` from the Channel owner proves there is no process.
  if (!observation || observation.error) return 'unknown';
  const state = observation.state;
  switch (state) {
    case 'running':
    case 'generating':
    case 'streaming':
      return 'running';
    case 'starting':
    case 'compacting':
    case 'error':
    case 'interrupted':
      return state;
    case null:
    case undefined:
      return 'dormant';
    default:
      return 'idle';
  }
}

export const isBusyActivity = (activity: SessionActivity) =>
  activity === 'running' || activity === 'starting' || activity === 'compacting';

export const shortId = (id: string) => (id.length > 16 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id);

/** Operator-facing peer name; unnamed peers fall back to a stable short ID. */
export const peerLabel = (peer: Pick<TeamPeer, 'name' | 'sourceId'>) => peer.name?.trim() || shortId(peer.sourceId);

/** Why a Channel cannot accept changes, or null when it is online. */
export function channelOffline(channel: TeamChannel): 'disabled' | 'connecting' | 'error' | 'offline' | null {
  if (!channel.enabled) return 'disabled';
  if (channel.online) return null;
  if (channel.status === 'connecting' || channel.status === 'error') return channel.status;
  return 'offline';
}

export interface PeerRow {
  channel: TeamChannel;
  peer: TeamPeer;
  current?: SessionMetadata;
  activity: SessionActivity;
  lastActiveMs: number;
}

const timeOf = (value?: string | null) => {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

export const peerRowKey = (channelId: string, sessionKey: string) => `${channelId}\u0000${sessionKey}`;

/** One flat list across Bots, most recently active first. */
export function buildPeerRows(channels: TeamChannel[], sessions: SessionMetadata[], states: TeamSessionState[]): PeerRow[] {
  const byId = new Map(sessions.map(session => [session.id, session]));
  return channels
    .flatMap(channel => channel.peers.map(peer => {
      const current = peer.sessionId ? byId.get(peer.sessionId) : undefined;
      const state = states.find(s => s.channelId === channel.channelId && s.sessionKey === peer.sessionKey && s.sessionId === peer.sessionId);
      return {
        channel,
        peer,
        current,
        activity: sessionActivity(state),
        lastActiveMs: Math.max(timeOf(peer.lastActive), timeOf(current?.lastActiveAt)),
      };
    }))
    .sort((a, b) => b.lastActiveMs - a.lastActiveMs);
}

export function matchesPeerQuery(row: PeerRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.peer.name, row.peer.sourceId, row.channel.name].some(value => value?.toLowerCase().includes(q));
}

/** A peer's earlier Sessions (newest first) and how many are no longer readable. */
export function peerHistory(peer: TeamPeer, sessions: SessionMetadata[]): { items: SessionMetadata[]; missing: number } {
  const ids = [...new Set(peer.sessionIds)].filter(id => id !== peer.sessionId);
  const byId = new Map(sessions.map(session => [session.id, session]));
  const items = ids.map(id => byId.get(id)).filter((session): session is SessionMetadata => !!session);
  items.sort((a, b) => timeOf(b.lastActiveAt) - timeOf(a.lastActiveAt));
  return { items, missing: ids.length - items.length };
}

/** A failed observation request leaves every target unknown rather than dormant. */
export const unobserved = (targets: ReturnType<typeof observationTargets>): TeamSessionState[] =>
  targets.map(target => ({ ...target, state: null, error: 'unavailable' }));

/** Observation targets, bounded by the Rust command limit: every peer's current
 *  Session first, then history (only history can show "finishing"). */
export function observationTargets(channels: TeamChannel[], sessions: SessionMetadata[]) {
  const known = new Set(sessions.map(session => session.id));
  const target = (channel: TeamChannel, peer: TeamPeer, sessionId: string) => ({ channelId: channel.channelId, sessionKey: peer.sessionKey, sessionId });
  const current = channels.flatMap(channel => channel.peers
    .filter(peer => peer.sessionId && known.has(peer.sessionId))
    .map(peer => target(channel, peer, peer.sessionId!)));
  const history = channels.flatMap(channel => channel.peers.flatMap(peer =>
    [...new Set(peer.sessionIds)].filter(id => id !== peer.sessionId && known.has(id)).map(id => target(channel, peer, id))));
  return [...current, ...history].slice(0, 64);
}
