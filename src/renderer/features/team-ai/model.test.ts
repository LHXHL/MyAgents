import { describe, expect, it } from 'vitest';
import type { SessionMetadata } from '@/api/sessionClient';
import type { TeamChannel, TeamPeer } from '@/../shared/teamAi';
import { observationTargets, peerLabel, sessionActivity } from './model';

const session = (id: string) => ({ id }) as SessionMetadata;
const peer = (key: string, current: string, history: string[]): TeamPeer =>
  ({ id: key, access: null, sessionKey: key, sourceId: key, sourceType: 'group', name: key, sessionId: current, sessionIds: [current, ...history], hasProfile: false });

describe('Team AI observation projection', () => {
  it('observes every current Session before any history within the bounded batch', () => {
    const history = Array.from({ length: 70 }, (_, i) => `h${i}`);
    const channel = { channelId: 'c', peers: [peer('a', 'a-now', history), peer('b', 'b-now', [])] } as unknown as TeamChannel;
    const targets = observationTargets([channel], [session('a-now'), session('b-now'), ...history.map(session)]);
    expect(targets).toHaveLength(64);
    expect(targets.slice(0, 2).map(t => t.sessionId)).toEqual(['a-now', 'b-now']);
  });

  it('only an explicit null state means no process; a missing or failed observation is unknown', () => {
    expect(sessionActivity({ state: null })).toBe('dormant');
    expect(sessionActivity(undefined)).toBe('unknown');
    expect(sessionActivity({ state: null, error: 'timeout' })).toBe('unknown');
    expect(sessionActivity({ state: 'generating' })).toBe('running');
  });
});

describe('Team AI peer names', () => {
  it('treats a recorded name equal to the platform ID as unnamed and shortens it', () => {
    expect(peerLabel({ name: 'wrjb8IEAAAjPOpPxkuFFRpFv_FoDfK_Q', sourceId: 'wrjb8IEAAAjPOpPxkuFFRpFv_FoDfK_Q' })).toBe('wrjb8I…oDfK_Q');
    expect(peerLabel({ name: ' 李奕晨 ', sourceId: 'u1' })).toBe('李奕晨');
    expect(peerLabel({ name: null, sourceId: 'u1' })).toBe('u1');
  });
});
