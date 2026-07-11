import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { CronTask } from '@/types/cronTask';
import { useCronTask } from './useCronTask';

function task(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: 'task-1',
    workspacePath: '/tmp/workspace',
    sessionId: 'session-1',
    prompt: 'keep going',
    intervalMinutes: 5,
    endConditions: { aiCanExit: true },
    runMode: 'single_session',
    status: 'running',
    executionCount: 0,
    createdAt: '2026-07-10T10:00:00.000Z',
    notifyEnabled: true,
    schedule: { kind: 'every', minutes: 5 },
    ...overrides,
  };
}

describe('useCronTask surface ownership', () => {
  it('restores an ordinary time-based Cron', () => {
    const { result } = renderHook(() => useCronTask({
      workspacePath: '/tmp/workspace',
      sessionId: 'session-1',
    }));

    act(() => result.current.restoreFromTask(task()));

    expect(result.current.state.task?.id).toBe('task-1');
    expect(result.current.state.config?.taskKind).toBe('cron');
  });

  it('refuses to restore a retired legacy Loop', () => {
    const { result } = renderHook(() => useCronTask({
      workspacePath: '/tmp/workspace',
      sessionId: 'session-1',
    }));

    act(() => result.current.restoreFromTask(task({ schedule: { kind: 'loop' } })));

    expect(result.current.state.task).toBeNull();
    expect(result.current.state.config).toBeNull();
  });
});
