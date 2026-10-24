import { describe, expect, it } from 'vitest';
import type { SessionMetadata } from '@/api/sessionClient';
import type { TeamChannel, TeamPeer } from '@/../shared/teamAi';
import { observationTargets, sessionActivity } from './model';

const session = (id: string) => ({ id }) as SessionMetadata;
const peer = (key: string, current: string, history: string[]): TeamPeer =>
  ({ sessionKey: key, sourceId: key, sourceType: 'group', name: key, sessionId: current, sessionIds: [current, ...history], lastActive: null, hasProfile: false });

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
