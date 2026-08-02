import { describe, expect, it, vi } from 'vitest';

import type { SessionEngine } from '../session-engine';
import {
  handleGoalExecuteSyncRoute,
  handleTaskExecuteSyncRoute,
} from './scheduled-turns';

function request(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function engine(sessionId = 'session-1'): SessionEngine {
  return {
    getCurrentSessionContext: () => ({
      runtime: 'builtin',
      sessionId,
      workspacePath: '/workspace',
    }),
  } as SessionEngine;
}

describe('scheduled turn HTTP handlers', () => {
  it('keeps Task parse and required-field failures at HTTP 400', async () => {
    const dependencies = {
      getEngine: () => engine(),
      getWorkspacePath: () => '/workspace',
    };
    const invalidJson = await handleTaskExecuteSyncRoute(
      request('/cron/execute-sync', '{'),
      dependencies,
    );
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ success: false, error: 'Invalid JSON payload.' });

    const missing = await handleTaskExecuteSyncRoute(
      request('/cron/execute-sync', { taskId: 'task-1' }),
      dependencies,
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      success: false,
      error: 'Task id, queue id, session id, and prompt are required.',
    });
  });

  it('maps Task orchestrator terminal results without changing the wire shape', async () => {
    const runScheduledTurn = vi.fn(async () => ({
      success: true,
      aiRequestedExit: true,
      exitReason: 'done',
      outputText: 'TASK_COMPLETE: done',
      sessionId: 'session-task',
    }));
    const response = await handleTaskExecuteSyncRoute(
      request('/cron/execute-sync', {
        taskId: 'task-1',
        queueId: 'queue-1',
        sessionId: 'session-task',
        prompt: 'work',
      }),
      {
        getEngine: () => engine('session-task'),
        getWorkspacePath: () => '/workspace',
        taskOrchestrator: { runScheduledTurn },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      aiRequestedExit: true,
      exitReason: 'done',
      outputText: 'TASK_COMPLETE: done',
      sessionId: 'session-task',
    });
    expect(runScheduledTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: 'task-1', queueId: 'queue-1' }),
      '/workspace',
    );
  });

  it('preserves Task conflict codes and unconfirmed termination', async () => {
    const response = await handleTaskExecuteSyncRoute(
      request('/cron/execute-sync', {
        taskId: 'task-1',
        queueId: 'queue-1',
        sessionId: 'session-task',
        prompt: 'work',
      }),
      {
        getEngine: () => engine('session-task'),
        getWorkspacePath: () => '/workspace',
        taskOrchestrator: {
          runScheduledTurn: vi.fn(async () => ({
            success: false,
            error: 'Task execution was canceled before dispatch',
            code: 'task_dispatch_canceled',
            terminationUnconfirmed: true,
            status: 409,
          })),
        },
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Task execution was canceled before dispatch',
      code: 'task_dispatch_canceled',
      terminationUnconfirmed: true,
    });
  });

  it('keeps Goal validation and success response fields stable', async () => {
    const invalid = await handleGoalExecuteSyncRoute(
      request('/goal/execute-sync', { goalId: 'goal-1' }),
      { getEngine: () => engine(), getWorkspacePath: () => '/workspace' },
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ success: false, error: 'Invalid Goal execution payload.' });

    const runScheduledTurn = vi.fn(async () => ({
      success: true,
      text: 'progress',
      sessionId: 'session-1',
      channelDeliveryExpected: true,
    }));
    const response = await handleGoalExecuteSyncRoute(
      request('/goal/execute-sync', {
        goalId: 'goal-1',
        objective: 'ship',
        sessionId: 'session-1',
        queueId: 'queue-1',
        turnNumber: 2,
        expectedControlRevision: 3,
        aiCanExit: true,
        permissionMode: 'fullAgency',
      }),
      {
        getEngine: () => engine(),
        getWorkspacePath: () => '/workspace',
        goalOrchestrator: { runScheduledTurn },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      aiRequestedExit: false,
      outputText: 'progress',
      sessionId: 'session-1',
      goalChannelDeliveryExpected: true,
    });
  });

  it('keeps Goal termination uncertainty visible with the active Session id', async () => {
    const response = await handleGoalExecuteSyncRoute(
      request('/goal/execute-sync', {
        goalId: 'goal-1',
        objective: 'ship',
        sessionId: 'session-1',
        queueId: 'queue-1',
        turnNumber: 2,
        expectedControlRevision: 3,
        aiCanExit: false,
        permissionMode: '',
      }),
      {
        getEngine: () => engine('active-session'),
        getWorkspacePath: () => '/workspace',
        goalOrchestrator: {
          runScheduledTurn: vi.fn(async () => ({
            success: false,
            error: 'runtime process did not stop',
            terminationUnconfirmed: true,
            status: 408,
          })),
        },
      },
    );
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({
      success: false,
      error: 'runtime process did not stop',
      terminationUnconfirmed: true,
      sessionId: 'active-session',
    });
  });
});
