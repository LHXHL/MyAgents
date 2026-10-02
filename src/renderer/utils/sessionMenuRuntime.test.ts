import { describe, expect, it } from 'vitest';
import type { SessionMetadata } from '@/api/sessionClient';
import { sessionMenuRuntimeIdentity } from './sessionMenuRuntime';

describe('sessionMenuRuntimeIdentity', () => {
  const metadata = { id: 'session-a', runtime: 'dsh', runtimeSource: 'integrated' } as SessionMetadata;
  const noLiveRuntime = { liveRuntime: null, liveRuntimeSource: null, liveRuntimeSessionId: null };

  it('shows the launch runtime while a new workspace still has a pending id', () => {
    expect(sessionMenuRuntimeIdentity({
      sessionId: 'pending-tab-a', metadata: null,
      launchRuntime: 'dsh', launchRuntimeSource: 'integrated',
      ...noLiveRuntime,
    })).toEqual({ runtime: 'dsh', runtimeSource: 'integrated' });
  });

  it('uses the matching Session snapshot after birth, even if Agent defaults changed', () => {
    expect(sessionMenuRuntimeIdentity({
      sessionId: 'session-a', metadata,
      launchRuntime: 'builtin', launchRuntimeSource: null,
      ...noLiveRuntime,
    })).toEqual({ runtime: 'dsh', runtimeSource: 'integrated' });
  });

  it('uses the matching live Runtime while the first-turn metadata is being persisted', () => {
    expect(sessionMenuRuntimeIdentity({
      sessionId: 'session-a', metadata: null,
      launchRuntime: 'builtin', launchRuntimeSource: null,
      liveRuntime: 'dsh', liveRuntimeSource: 'integrated', liveRuntimeSessionId: 'session-a',
    })).toEqual({ runtime: 'dsh', runtimeSource: 'integrated' });
  });

  it('does not show a previous Session or Agent runtime while restoring another Session', () => {
    expect(sessionMenuRuntimeIdentity({
      sessionId: 'session-b', metadata,
      launchRuntime: 'builtin', launchRuntimeSource: null,
      liveRuntime: 'dsh', liveRuntimeSource: 'integrated', liveRuntimeSessionId: 'session-a',
    })).toEqual({ runtime: null, runtimeSource: null });
  });
});
