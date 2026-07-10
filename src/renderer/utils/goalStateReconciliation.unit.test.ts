import { describe, expect, it } from 'vitest';

import type { CronTask } from '@/types/cronTask';
import {
  isTerminalGoalFromListenerGap,
  shouldAcceptGoalState,
} from './goalStateReconciliation';

function goal(overrides: Partial<CronTask>): CronTask {
  return {
    id: 'goal-1',
    workspacePath: '/tmp/workspace',
    sessionId: 'session-1',
    prompt: 'ship it',
    intervalMinutes: 5,
    endConditions: { aiCanExit: true },
    runMode: 'single_session',
    status: 'running',
    executionCount: 1,
    createdAt: '2026-07-10T10:00:00.000Z',
    notifyEnabled: true,
    permissionMode: '',
    goalStatus: 'active',
    goalObjective: 'ship it',
    goalRevision: 1,
    ...overrides,
  };
}

describe('Goal state reconciliation', () => {
  it('rejects stale hydrate after a terminal event', () => {
    const terminal = goal({
      status: 'stopped',
      goalStatus: 'complete',
      goalRevision: 3,
    });
    expect(shouldAcceptGoalState(goal({ goalRevision: 2 }), terminal)).toBe(false);
  });

  it('accepts a newer revision and a newer Goal after a prior terminal Goal', () => {
    expect(shouldAcceptGoalState(goal({ goalRevision: 4 }), goal({ goalRevision: 3 }))).toBe(true);
    expect(shouldAcceptGoalState(goal({
      id: 'goal-2',
      createdAt: '2026-07-10T11:00:00.000Z',
      goalUpdatedAt: '2026-07-10T11:00:00.000Z',
    }), goal({
      status: 'stopped',
      goalStatus: 'canceled',
      goalUpdatedAt: '2026-07-10T10:30:00.000Z',
    }))).toBe(true);
  });

  it('recovers terminal state only from the listener registration gap', () => {
    const terminal = goal({
      status: 'stopped',
      goalStatus: 'complete',
      goalUpdatedAt: '2026-07-10T10:00:05.000Z',
    });
    expect(isTerminalGoalFromListenerGap(
      terminal,
      Date.parse('2026-07-10T10:00:00.000Z'),
      Date.parse('2026-07-10T10:00:10.000Z'),
    )).toBe(true);
    expect(isTerminalGoalFromListenerGap(
      terminal,
      Date.parse('2026-07-10T10:00:06.000Z'),
      Date.parse('2026-07-10T10:00:10.000Z'),
    )).toBe(false);
    expect(isTerminalGoalFromListenerGap(goal({ goalUpdatedAt: '2026-07-10T10:00:05.000Z' }), 0, Infinity))
      .toBe(false);
  });
});
