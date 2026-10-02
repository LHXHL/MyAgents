import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { projectWorkHistory, providerContentFailed } from './history-content';
import { mergeSubagentLifecycleUpdate } from '../../../shared/types/subagent-lifecycle';
import type { DshNativeHistory } from './mutations';

function fixture(): DshNativeHistory {
  const data = [
    ['myagents/operation/accepted', { clientOperationId: 'operation-1', acceptedAt: 100 }],
    ['myagents/work/created', {
      taskId: 'task-1', agentId: 'child-1', initialChildEventSeq: 1,
      authority: { callId: 'call-1', clientOperationId: 'operation-1' }, birth: { type: 'Explore' },
      description: 'Inspect fixture', mode: 'continuable', model: 'fixture-model',
    }],
    ['myagents/work/epoch', {
      taskId: 'task-1', agentId: 'child-1', ordinal: 1, childStartSeq: 1, childEndSeq: 8,
      stopReason: 'completed', result: 'first result',
    }],
    ['myagents/work/activated', { taskId: 'task-1', agentId: 'child-1', ordinal: 2, childStartSeq: 9 }],
    ['myagents/work/epoch', {
      taskId: 'task-1', agentId: 'child-1', ordinal: 2, childStartSeq: 9, childEndSeq: 18,
      stopReason: 'completed', result: 'second result',
    }],
    ['myagents/work/stopping', { taskId: 'task-1', agentId: 'child-1' }],
    ['myagents/work/settled', {
      taskId: 'task-1', agentId: 'child-1', terminal: 'aborted', result: 'cumulative handle output',
    }],
  ] as const;
  return {
    inheritedEventCount: 0,
    runtimeSessionId: 'root-1', durableSequence: data.length,
    transcriptPostcondition: 'a'.repeat(64), mutationBoundaries: [],
    events: data.map(([eventType, value], sequence) => ({
      sequence, eventType, eventSha256: 'b'.repeat(64),
      data: { ...value, sessionId: 'root-1', eventSeq: sequence },
    })),
  };
}

describe('native child history presentation', () => {
  it.each([null, 'unavailable', { inputTokens: -1, outputTokens: 2 }])(
    'preserves a completed child when historical usage is unusable: %j', usage => {
      const history = fixture();
      const events = history.events.map(event => event.eventType === 'myagents/work/epoch'
        ? { ...event, data: { ...(event.data as object), usage } } : event);
      const child = projectWorkHistory({ ...history, events }, 'call-1');
      expect(child).toMatchObject({ status: 'completed', result: 'second result', handleState: 'closed' });
      expect(child?.usage).toBeUndefined();
    },
  );

  it('reconstructs later execution without changing earlier tool success or completion facts', () => {
    const history = fixture();
    const first = projectWorkHistory({ ...history, events: history.events.slice(0, 3) }, 'call-1');
    expect(first).toMatchObject({ handleState: 'open', status: 'completed', result: 'first result' });
    const running = projectWorkHistory({ ...history, events: history.events.slice(0, 4) }, 'call-1');
    expect(running).toMatchObject({ handleState: 'open', status: 'running', activation: { ordinal: 2 } });
    expect(running?.result).toBeUndefined();
    expect(running?.activation?.id).not.toBe(first?.activation?.id);
    const closed = projectWorkHistory(history, 'call-1');
    expect(closed).toMatchObject({
      handleState: 'closed', status: 'completed', activation: { ordinal: 2, state: 'completed' },
      result: 'second result', timingVerified: false,
    });
  });

  it('rejects a conflicting durable work owner', () => {
    const history = fixture();
    const events = history.events.map(event => event.sequence === 2
      ? { ...event, data: { ...(event.data as object), agentId: 'foreign-child' } } : event);
    expect(() => projectWorkHistory({ ...history, events }, 'call-1')).toThrow('durable owner');
  });

  it('preserves reserved activation identity through waiting, closure and explicit reopen', () => {
    const history = fixture();
    const events = history.events.slice(0, 2).map(event => event.sequence === 1 ? { ...event, data: {
      ...(event.data as object), admission: 'reserved', initialChildEventSeq: undefined,
      birth: { type: 'general-purpose', parentSessionId: 'root-1', depth: 1, provider: 'fixture-provider', modelProfileRevision: 'profile-1' },
    } } : event);
    const append = (eventType: string, data: Record<string, unknown>) => events.push({ eventType, sequence: events.length,
      eventSha256: 'b'.repeat(64), data: { taskId: 'task-1', agentId: 'child-1', sessionId: 'root-1', eventSeq: events.length, ...data } });
    const project = () => projectWorkHistory({ ...history, events }, 'call-1');
    const queued = project();
    expect(queued).toMatchObject({ activation: { ordinal: 1, state: 'queued' }, tree: { parentAgentId: 'root-1' } });
    append('myagents/work/started', { initialChildEventSeq: 5 });
    append('myagents/work/phase', { ordinal: 1, phase: 'waiting_child' });
    expect(project()).toMatchObject({ activation: { id: queued?.activation?.id, state: 'waiting_child' } });
    append('myagents/work/epoch', { ordinal: 1, childStartSeq: 5, stopReason: 'completed', result: 'retained success' });
    append('myagents/work/settled', { terminal: 'aborted' });
    const closed = project();
    expect(closed).toMatchObject({ status: 'completed', handleState: 'closed', result: 'retained success' });
    append('myagents/work/reopened', { previousSettlementSeq: events.length - 1 });
    const reopened = project();
    expect(reopened).toMatchObject({ handleState: 'open', result: 'retained success', activation: { id: queued?.activation?.id } });
    expect(mergeSubagentLifecycleUpdate(reopened, closed!)).toEqual(reopened);
    expect(mergeSubagentLifecycleUpdate(closed, reopened!)).toMatchObject({ handleState: 'open', result: 'retained success' });
    append('myagents/work/phase', { ordinal: 2, phase: 'queued' });
    const expected = createHash('sha256').update(['myagents-work-activation-v2', 'child-1', '2', ''].join('\0')).digest('hex');
    expect(project()).toMatchObject({ activation: { id: expected, ordinal: 2, state: 'queued' }, status: 'running' });
  });

  it('keeps a deep child with the same native tool ID out of the root tool projection', () => {
    const history = fixture();
    const nested = { ...history.events[1]!, sequence: 7, data: {
      ...(history.events[1]!.data as object), taskId: 'task-2', agentId: 'grandchild', eventSeq: 7,
      birth: { type: 'general-purpose', parentSessionId: 'child-1', depth: 2 },
    } };
    expect(projectWorkHistory({ ...history, events: [...history.events, nested] }, 'call-1')).toMatchObject({ agentId: 'child-1' });
  });

  it('recognizes explicit failures while retaining unknown Provider text', () => {
    expect(providerContentFailed('[{"content":{"status_code":400}}]')).toBe(true);
    expect(providerContentFailed('The reference mentions HTTP 400.')).toBe(false);
    expect(providerContentFailed([])).toBe(false);
  });
});
