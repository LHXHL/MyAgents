import type { SessionEngine } from '../session-engine';
import type { SessionGoal } from '../session-engine/goal-orchestrator';
import { goalOrchestrator } from '../session-engine/goal-orchestrator';
import {
  taskTurnOrchestrator,
  type TaskExecutePayload,
} from '../session-engine/task-turn-orchestrator';

export type GoalExecutePayload = {
  goalId: string;
  objective: string;
  sessionId: string;
  turnNumber: number;
  aiCanExit: boolean;
  permissionMode: string;
  queueId: string;
  expectedControlRevision: number;
};

type ScheduledTurnRouteDependencies = {
  getEngine(): SessionEngine;
  getWorkspacePath(): string;
  taskOrchestrator?: Pick<typeof taskTurnOrchestrator, 'runScheduledTurn'>;
  goalOrchestrator?: Pick<typeof goalOrchestrator, 'runScheduledTurn'>;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleGoalExecuteSyncRoute(
  request: Request,
  dependencies: ScheduledTurnRouteDependencies,
): Promise<Response> {
  let payload: GoalExecutePayload;
  try {
    payload = (await request.json()) as GoalExecutePayload;
  } catch (error) {
    console.error('[goal] execute-sync: JSON parse error', error);
    return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
  }
  if (!payload.goalId?.trim()
    || !payload.objective?.trim()
    || !payload.sessionId?.trim()
    || !payload.queueId?.trim()
    || !Number.isInteger(payload.turnNumber)
    || payload.turnNumber < 1
    || !Number.isInteger(payload.expectedControlRevision)
    || payload.expectedControlRevision < 1) {
    return jsonResponse({ success: false, error: 'Invalid Goal execution payload.' }, 400);
  }

  const engine = dependencies.getEngine();
  const workspacePath = dependencies.getWorkspacePath();
  const goal: SessionGoal = {
    id: payload.goalId,
    objective: payload.objective,
    status: 'active',
    turnCount: payload.turnNumber - 1,
    revision: 0,
    controlRevision: payload.expectedControlRevision,
    sessionId: payload.sessionId,
    workspacePath,
    endConditions: { aiCanExit: payload.aiCanExit },
  };
  let result: Awaited<ReturnType<typeof goalOrchestrator.runScheduledTurn>>;
  try {
    result = await (dependencies.goalOrchestrator ?? goalOrchestrator).runScheduledTurn(engine, {
      goal,
      queueId: payload.queueId,
      expectedControlRevision: payload.expectedControlRevision,
      turnNumber: payload.turnNumber,
      permissionMode: payload.permissionMode,
    });
  } catch (error) {
    const activeSessionId = engine.getCurrentSessionContext().sessionId ?? undefined;
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
    }, 500);
  }
  const activeSessionId = result.sessionId ?? engine.getCurrentSessionContext().sessionId ?? undefined;
  if (!result.success) {
    if (result.terminationUnconfirmed) {
      return jsonResponse({
        success: false,
        error: result.error ?? 'Goal execution termination was not confirmed',
        terminationUnconfirmed: true,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      }, result.status ?? 503);
    }
    return jsonResponse({
      success: false,
      error: result.error ?? 'Goal execution failed',
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
    }, result.status ?? 503);
  }
  return jsonResponse({
    success: true,
    aiRequestedExit: false,
    outputText: result.text || undefined,
    sessionId: activeSessionId,
    goalChannelDeliveryExpected: result.channelDeliveryExpected === true,
  });
}

export async function handleTaskExecuteSyncRoute(
  request: Request,
  dependencies: ScheduledTurnRouteDependencies,
): Promise<Response> {
  let payload: TaskExecutePayload;
  try {
    payload = (await request.json()) as TaskExecutePayload;
  } catch (error) {
    console.error('[cron] execute-sync: JSON parse error', error);
    return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
  }
  if (!payload.taskId || !payload.queueId || !payload.prompt || !payload.sessionId) {
    return jsonResponse({
      success: false,
      error: 'Task id, queue id, session id, and prompt are required.',
    }, 400);
  }

  let result: Awaited<ReturnType<typeof taskTurnOrchestrator.runScheduledTurn>>;
  try {
    result = await (dependencies.taskOrchestrator ?? taskTurnOrchestrator).runScheduledTurn(
      dependencies.getEngine(),
      payload,
      dependencies.getWorkspacePath(),
    );
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
  if (!result.success) {
    return jsonResponse({
      success: false,
      error: result.error ?? 'Execution failed',
      ...(result.code ? { code: result.code } : {}),
      ...(result.terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
    }, result.status ?? 500);
  }
  return jsonResponse({
    success: true,
    aiRequestedExit: result.aiRequestedExit ?? false,
    exitReason: result.exitReason,
    outputText: result.outputText,
    sessionId: result.sessionId,
  });
}
