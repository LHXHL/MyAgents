import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@/types/chat';
import { applySubagentLifecycleToContent } from './subagentActivity';
import { mergeSubagentLifecycleUpdate, type SubagentLifecycle } from '../../../shared/types/subagent-lifecycle';

describe('subagent result and lifecycle authorities', () => {
  it('fills unknown historical timing from the same activation baseline without reopening its handle', () => {
    const historical: SubagentLifecycle = {
      activation: { id: 'epoch-1', ordinal: 1, state: 'completed' },
      status: 'completed', handleState: 'closed', startedAt: 1, timingVerified: false, result: 'durable result',
    };
    const live = { ...historical, handleState: 'open' as const, startedAt: 100, finishedAt: 200, timingVerified: true };
    expect(mergeSubagentLifecycleUpdate(historical, live)).toMatchObject({
      handleState: 'closed', startedAt: 100, finishedAt: 200, timingVerified: true, result: 'durable result',
    });
    expect(mergeSubagentLifecycleUpdate(live, historical)).toMatchObject({ startedAt: 100, finishedAt: 200 });
  });
  it.each(['completed', 'failed', 'interrupted'] as const)('keeps the Agent call result after child %s', status => {
    const result = JSON.stringify({ taskId: 'work-1', agentId: 'child-1', state: 'background' });
    const content = [{ type: 'tool_use', tool: { id: 'call-1', name: 'Agent', result, isError: false, isLoading: false } }] as ContentBlock[];
    const lifecycle = { status, startedAt: 100, finishedAt: 200, result: 'child result' };
    const updated = applySubagentLifecycleToContent(content, 'call-1', lifecycle);
    expect(updated?.[0].tool).toMatchObject({ result, isError: false, isLoading: false, subagentLifecycle: lifecycle });
    expect(content[0].tool?.subagentLifecycle).toBeUndefined();
  });

  it('does not invent a tool result when child lifecycle arrives before tool completion', () => {
    const content = [{ type: 'tool_use', tool: { id: 'call-1', name: 'Agent', isLoading: true } }] as ContentBlock[];
    const updated = applySubagentLifecycleToContent(content, 'call-1', { status: 'completed', startedAt: 100, finishedAt: 200, result: 'child result' });
    expect(updated?.[0].tool?.result).toBeUndefined();
    expect(updated?.[0].tool?.isError).toBeUndefined();
    expect(updated?.[0].tool?.isLoading).toBe(true);
  });

  it('admits the next activation, rejects old activity, and preserves completed output after handle closure', () => {
    const first: SubagentLifecycle = {
      activation: { id: 'activation-1', ordinal: 1, state: 'completed' }, handleState: 'open',
      status: 'completed', startedAt: 100, finishedAt: 200, result: 'first result',
    };
    const initial = [{ type: 'tool_use', tool: {
      id: 'call-1', name: 'Agent', result: 'original handle', isError: false, subagentLifecycle: first,
    } }] as ContentBlock[];
    const second: SubagentLifecycle = {
      activation: { id: 'activation-2', ordinal: 2, state: 'running' }, handleState: 'open',
      status: 'running', startedAt: 300,
    };
    const running = applySubagentLifecycleToContent(initial, 'call-1', second);
    expect(running?.[0].tool?.subagentLifecycle).toEqual(second);
    if (!running) throw new Error('fixture lifecycle was not applied');
    expect(applySubagentLifecycleToContent(running, 'call-1', first)).toBe(running);
    const completed: SubagentLifecycle = {
      ...second, status: 'completed', finishedAt: 400, result: 'second result',
      activation: { id: 'activation-2', ordinal: 2, state: 'completed' },
    };
    const result = applySubagentLifecycleToContent(running, 'call-1', completed);
    if (!result) throw new Error('fixture completion was not applied');
    const closed = applySubagentLifecycleToContent(result, 'call-1', { ...completed, handleState: 'closed' });
    expect(closed?.[0].tool).toMatchObject({
      result: 'original handle', isError: false,
      subagentLifecycle: { status: 'completed', result: 'second result', handleState: 'closed', startedAt: 300, finishedAt: 400 },
    });
  });
});
