import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types/chat';
import {
  clearAllBackgroundTaskStatuses,
  collectCompletedBackgroundToolIdsFromHistory,
  getActiveBackgroundTasks,
  getBackgroundTaskStatus,
  hydrateBackgroundTaskStatusesFromHistory,
  registerBackgroundTask,
  setBackgroundTaskStatus,
} from './backgroundTaskStatus';

const history = (runId?: string): Message[] => [{
  id: `task-notification-agent-${runId ?? 'legacy'}`,
  role: 'user', timestamp: new Date(),
  content: `<task-notification>${JSON.stringify({taskId: 'agent', toolUseId: 'tool', status: 'completed', runId})}</task-notification>`,
}];

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
  clearAllBackgroundTaskStatuses();
});
afterEach(() => { clearAllBackgroundTaskStatuses(); vi.unstubAllGlobals(); });

describe('background task execution identity', () => {
  it('keeps a resumed run active through stale live events and history hydration', () => {
    registerBackgroundTask('agent', 'tool', { runId: 'run-1' }, 'session');
    setBackgroundTaskStatus('agent', 'completed', 'tool', 'session', 'run-1');
    registerBackgroundTask('agent', 'tool', { runId: 'run-2' }, 'session');
    expect(getBackgroundTaskStatus('tool', 'session')).toBe('running');
    expect(setBackgroundTaskStatus('agent', 'completed', 'tool', 'session', 'run-1')).toBe(false);
    hydrateBackgroundTaskStatusesFromHistory([...history(), ...history('run-1')], 'session');
    expect(getActiveBackgroundTasks('session')).toHaveLength(1);
    expect(collectCompletedBackgroundToolIdsFromHistory(history('run-1'), 'session').has('tool')).toBe(false);
    setBackgroundTaskStatus('agent', 'completed', 'tool', 'session', 'run-2');
    expect(getActiveBackgroundTasks('session')).toEqual([]);
  });

  it('reconciles an orphan only with its own run and rejects old starts', () => {
    setBackgroundTaskStatus('agent', 'failed', undefined, 'session', 'run-1');
    registerBackgroundTask('agent', 'tool', { runId: 'run-2' }, 'session');
    expect(getBackgroundTaskStatus('tool', 'session')).toBe('running');
    registerBackgroundTask('agent', 'old-tool', { runId: 'run-1' }, 'session');
    expect(getActiveBackgroundTasks('session')[0].toolUseId).toBe('tool');
    clearAllBackgroundTaskStatuses();
    setBackgroundTaskStatus('agent', 'failed', undefined, 'session', 'run-2');
    registerBackgroundTask('agent', 'tool', { runId: 'run-2' }, 'session');
    expect(getBackgroundTaskStatus('tool', 'session')).toBe('failed');
  });

  it('retains the run watermark when enriching the oldest orphan at capacity', () => {
    setBackgroundTaskStatus('agent', 'completed', undefined, 'session', 'run-2');
    for (let i = 0; i < 31; i++) setBackgroundTaskStatus(`orphan-${i}`, 'completed', undefined, 'session', 'run-1');
    setBackgroundTaskStatus('agent', 'completed', undefined, 'session', 'run-2');
    expect(registerBackgroundTask('agent', 'old-tool', { runId: 'run-1' }, 'session')).toBe(false);
    registerBackgroundTask('agent', 'tool', { runId: 'run-2' }, 'session');
    expect(getBackgroundTaskStatus('tool', 'session')).toBe('completed');
  });

  it('retains legacy history and isolates run comparisons by Session', () => {
    hydrateBackgroundTaskStatusesFromHistory(history(), 'legacy');
    expect(getBackgroundTaskStatus('tool', 'legacy')).toBe('completed');
    registerBackgroundTask('agent', 'tool', { runId: 'run-9' }, 'other');
    hydrateBackgroundTaskStatusesFromHistory(history('run-1'), 'session');
    expect(getActiveBackgroundTasks('other')).toHaveLength(1);
    expect(collectCompletedBackgroundToolIdsFromHistory(history(), 'legacy').has('tool')).toBe(true);
    clearAllBackgroundTaskStatuses('other');
    registerBackgroundTask('agent', 'tool', { runId: 'run-1' }, 'other');
    expect(getActiveBackgroundTasks('other')).toHaveLength(1);
  });
});
