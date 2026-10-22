import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyQueryReasoningEffort,
  initializeQueryReasoningEffort,
  resetLifecycleForTest,
  setQuerySession,
} from './lifecycle';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(resetLifecycleForTest);

describe('Query reasoning effort control', () => {
  it('serializes rapid choices and explicitly resets the model default', async () => {
    const first = deferred();
    const applyFlagSettings = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const query = { applyFlagSettings } as unknown as Query;
    setQuerySession(query);
    initializeQueryReasoningEffort(query, 'low');
    const high = applyQueryReasoningEffort(query, 'high');
    const medium = applyQueryReasoningEffort(query, 'medium');
    const reset = applyQueryReasoningEffort(query, null);
    await vi.waitFor(() => expect(applyFlagSettings).toHaveBeenCalledTimes(1));
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: 'high' });
    first.resolve();
    await Promise.all([high, medium, reset]);
    expect(applyFlagSettings.mock.calls).toEqual([
      [{ effortLevel: 'high' }], [{ effortLevel: 'medium' }], [{ effortLevel: null }],
    ]);
    await applyQueryReasoningEffort(query, null);
    expect(applyFlagSettings).toHaveBeenCalledTimes(3);
  });

  it('does not treat an uncertain failed write as its prior acknowledged setting', async () => {
    const applyFlagSettings = vi.fn().mockRejectedValueOnce(new Error('control failed')).mockResolvedValue(undefined);
    const query = { applyFlagSettings } as unknown as Query;
    setQuerySession(query);
    initializeQueryReasoningEffort(query, 'low');
    await expect(applyQueryReasoningEffort(query, 'high')).rejects.toThrow('control failed');
    await applyQueryReasoningEffort(query, 'low');
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: 'low' });
  });

  it('rejects replaced Query writes immediately and ignores their late completion', async () => {
    const oldAck = deferred();
    const oldApply = vi.fn(() => oldAck.promise);
    const oldQuery = { applyFlagSettings: oldApply } as unknown as Query;
    setQuerySession(oldQuery);
    initializeQueryReasoningEffort(oldQuery, 'low');
    const oldWrite = applyQueryReasoningEffort(oldQuery, 'high');
    const rejected = expect(oldWrite).rejects.toThrow('Query was replaced');
    await vi.waitFor(() => expect(oldApply).toHaveBeenCalledTimes(1));
    const nextApply = vi.fn().mockResolvedValue(undefined);
    const nextQuery = { applyFlagSettings: nextApply } as unknown as Query;
    setQuerySession(nextQuery);
    initializeQueryReasoningEffort(nextQuery, 'low');
    await rejected;
    await applyQueryReasoningEffort(nextQuery, 'high');
    oldAck.resolve();
    await applyQueryReasoningEffort(nextQuery, 'high');
    expect(nextApply).toHaveBeenCalledTimes(1);
    await expect(applyQueryReasoningEffort(oldQuery, 'medium')).rejects.toThrow('Query was replaced');
  });
});
