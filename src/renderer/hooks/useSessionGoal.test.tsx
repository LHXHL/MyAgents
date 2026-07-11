import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CronTask } from '@/types/cronTask';
import { useSessionGoal } from './useSessionGoal';

const api = vi.hoisted(() => ({
  createGoalTask: vi.fn(),
  markGoalTerminal: vi.fn(),
}));

vi.mock('@/api/cronTaskClient', () => ({
  createGoalTask: api.createGoalTask,
  getGoalTask: vi.fn(),
  getSessionGoalTask: vi.fn(),
  isTaskExecuting: vi.fn(),
  markGoalTerminal: api.markGoalTerminal,
  pauseGoalTask: vi.fn(),
  resumeGoalTask: vi.fn(),
}));

const createdGoal: CronTask = {
  id: 'goal-1',
  workspacePath: '/tmp/workspace',
  sessionId: 'session-1',
  tabId: 'tab-1',
  prompt: 'finish release',
  intervalMinutes: 5,
  endConditions: { aiCanExit: true },
  runMode: 'single_session',
  status: 'running',
  executionCount: 0,
  createdAt: '2026-07-10T10:00:00.000Z',
  notifyEnabled: true,
  schedule: { kind: 'loop' },
  goalStatus: 'active',
  goalObjective: 'finish release',
  goalRevision: 1,
};

describe('useSessionGoal creation surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createGoalTask.mockResolvedValue(createdGoal);
    api.markGoalTerminal.mockResolvedValue({ ...createdGoal, status: 'stopped', goalStatus: 'canceled' });
  });

  it('creates only through an explicit Goal draft and keeps the returned projection', async () => {
    const { result } = renderHook(() => useSessionGoal({
      workspacePath: '/tmp/workspace',
      sessionId: 'session-1',
    }));

    await act(async () => {
      await result.current.start({
        taskKind: 'goal',
        prompt: '',
        intervalMinutes: 5,
        endConditions: { aiCanExit: true },
        runMode: 'single_session',
        notifyEnabled: true,
        permissionMode: 'fullAgency',
        schedule: { kind: 'loop' },
      }, 'finish release');
    });

    expect(api.createGoalTask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'finish release',
      permissionMode: 'fullAgency',
    }));
    expect(api.createGoalTask).toHaveBeenCalledWith(expect.not.objectContaining({
      tabId: expect.anything(),
      providerIntent: expect.anything(),
      runtime: expect.anything(),
      delivery: expect.anything(),
      goalStatus: expect.anything(),
    }));
    expect(result.current.state.task?.id).toBe('goal-1');
  });

  it('cancels an in-flight create only after an explicit draft cancel', async () => {
    let resolveCreate!: (task: CronTask) => void;
    api.createGoalTask.mockImplementation(() => new Promise(resolve => { resolveCreate = resolve; }));
    const { result } = renderHook(() => useSessionGoal({
      workspacePath: '/tmp/workspace',
      sessionId: 'session-1',
    }));
    const config = {
      taskKind: 'goal' as const,
      prompt: 'finish release',
      intervalMinutes: 5,
      endConditions: { aiCanExit: true },
      runMode: 'single_session' as const,
      notifyEnabled: true,
      schedule: { kind: 'loop' as const },
    };

    let startPromise!: ReturnType<typeof result.current.start>;
    act(() => { startPromise = result.current.start(config); });
    act(() => result.current.cancelPendingStart());
    await act(async () => { resolveCreate(createdGoal); });

    await expect(startPromise).resolves.toBeNull();
    expect(api.markGoalTerminal).toHaveBeenCalledWith(
      'goal-1',
      'canceled',
      'Canceled before Goal Mode started',
    );
  });

  it('does not cancel a Rust-accepted Goal merely because its Tab unmounts', async () => {
    let resolveCreate!: (task: CronTask) => void;
    api.createGoalTask.mockImplementation(() => new Promise(resolve => { resolveCreate = resolve; }));
    const { result, unmount } = renderHook(() => useSessionGoal({
      workspacePath: '/tmp/workspace',
      sessionId: 'session-1',
    }));
    const startPromise = result.current.start({
      taskKind: 'goal',
      prompt: 'finish release',
      intervalMinutes: 5,
      endConditions: { aiCanExit: true },
      runMode: 'single_session',
      notifyEnabled: true,
      schedule: { kind: 'loop' },
    });

    unmount();
    resolveCreate(createdGoal);

    await expect(startPromise).resolves.toEqual(createdGoal);
    expect(api.markGoalTerminal).not.toHaveBeenCalled();
  });

  it('preserves an accepted Goal while the Tab adopts its pre-materialized identity', async () => {
    const realGoal = { ...createdGoal, sessionId: 'session-real' };
    api.createGoalTask.mockResolvedValue(realGoal);
    const materializeOwner = vi.fn(async () => ({
      sessionId: 'session-real',
      workspacePath: '/tmp/workspace',
    }));
    const { result, rerender } = renderHook(({ sessionId }) => useSessionGoal({
      workspacePath: '/tmp/workspace',
      sessionId,
      materializeOwner,
    }), { initialProps: { sessionId: 'pending-tab-1' } });

    await act(async () => {
      await result.current.start({
        taskKind: 'goal',
        prompt: 'finish release',
        intervalMinutes: 5,
        endConditions: { aiCanExit: true },
        runMode: 'single_session',
        notifyEnabled: true,
        schedule: { kind: 'loop' },
      });
    });
    expect(api.createGoalTask).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-real',
    }));
    expect(result.current.state.task?.sessionId).toBe('session-real');

    act(() => {
      rerender({ sessionId: 'session-real' });
    });

    expect(result.current.state.task?.sessionId).toBe('session-real');
  });

  it('cancels the whole materialize-and-create operation before Goal persistence', async () => {
    let resolveMaterialize!: (owner: { sessionId: string; workspacePath: string }) => void;
    const materializeOwner = vi.fn(() => new Promise<{ sessionId: string; workspacePath: string }>(
      resolve => { resolveMaterialize = resolve; },
    ));
    const { result } = renderHook(() => useSessionGoal({
      workspacePath: '/tmp/workspace',
      sessionId: 'pending-tab-1',
      materializeOwner,
    }));

    let startPromise!: ReturnType<typeof result.current.start>;
    act(() => {
      startPromise = result.current.start({
        taskKind: 'goal',
        prompt: 'finish release',
        intervalMinutes: 5,
        endConditions: { aiCanExit: true },
        runMode: 'single_session',
        notifyEnabled: true,
        schedule: { kind: 'loop' },
      });
    });
    act(() => result.current.cancelPendingStart());
    await act(async () => {
      resolveMaterialize({ sessionId: 'session-real', workspacePath: '/tmp/workspace' });
    });

    await expect(startPromise).resolves.toBeNull();
    expect(api.createGoalTask).not.toHaveBeenCalled();
  });

  it('detaches an in-flight create when the Tab switches to same-workspace history', async () => {
    const pendingGoal = { ...createdGoal, sessionId: 'pending-tab-1' };
    let resolveCreate!: (task: CronTask) => void;
    api.createGoalTask.mockImplementation(() => new Promise(resolve => { resolveCreate = resolve; }));
    const { result, rerender } = renderHook(({ sessionId }) => useSessionGoal({
      workspacePath: '/tmp/workspace',
      sessionId,
    }), { initialProps: { sessionId: 'pending-tab-1' } });

    let startPromise!: ReturnType<typeof result.current.start>;
    act(() => {
      startPromise = result.current.start({
        taskKind: 'goal',
        prompt: 'finish release',
        intervalMinutes: 5,
        endConditions: { aiCanExit: true },
        runMode: 'single_session',
        notifyEnabled: true,
        schedule: { kind: 'loop' },
      });
    });
    act(() => rerender({ sessionId: 'unrelated-history' }));
    await act(async () => { resolveCreate(pendingGoal); });

    await expect(startPromise).resolves.toEqual(pendingGoal);
    expect(result.current.state.task).toBeNull();
    expect(result.current.state.isStarting).toBe(false);
    expect(api.markGoalTerminal).not.toHaveBeenCalled();
  });
});
