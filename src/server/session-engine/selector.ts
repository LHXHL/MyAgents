import { interruptCurrentResponse } from '../agent-session';
import {
  getActiveRuntimeType,
  hasPendingExternalAskUserQuestion,
  isExternalSessionActive,
  shouldUseExternalRuntime,
} from '../runtimes/external-session';
import { createBuiltinSessionEngine } from './builtin-adapter';
import { createExternalSessionEngine } from './external-adapter';
import type { SessionEngine, SessionEngineKind } from './types';
import type { TurnOwner } from '../session-core/turn-queue';
import { managementApi } from '../utils/management-api-client';

const builtinEngine = createBuiltinSessionEngine();
const externalEngine = createExternalSessionEngine();

export function getSessionEngine(): SessionEngine {
  return shouldUseExternalRuntime() ? externalEngine : builtinEngine;
}

export function getSessionEngineKind(): SessionEngineKind {
  return shouldUseExternalRuntime() ? 'external' : 'builtin';
}

export function getSessionRuntimeType(): ReturnType<typeof getActiveRuntimeType> {
  return getActiveRuntimeType();
}

/**
 * Historical stop behavior: when the external-runtime flag is on but no
 * external session is active yet, /chat/stop falls back to the builtin
 * interrupt path. Keep that compatibility outside either adapter so the
 * external adapter does not become a mixed owner.
 */
export async function stopActiveTurn(): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }> {
  const engine = getSessionEngine();
  const turn = engine.getCurrentTurnIdentity();
  if (turn?.owner.kind === 'goal') {
    const context = engine.getCurrentSessionContext();
    if (!context.sessionId || !context.workspacePath) {
      return { success: false, error: 'Active Goal turn has no Session context' };
    }
    const paused = await managementApi('/api/goal/turn/pause', 'POST', {
      sessionId: context.sessionId,
      workspacePath: context.workspacePath,
      goalId: turn.owner.id,
      queueId: turn.queueId,
    });
    if (paused.ok !== true) {
      return { success: false, error: String(paused.error ?? 'Failed to pause active Goal') };
    }
    return stopOwnedTurn(turn.owner);
  }
  if (shouldUseExternalRuntime()) {
    const externalResult = await externalEngine.stopTurn();
    if (!externalResult.success || !externalResult.alreadyStopped) return externalResult;
    const stopped = await interruptCurrentResponse();
    return stopped ? { success: true } : { success: true, alreadyStopped: true };
  }
  return builtinEngine.stopTurn();
}

export async function stopOwnedTurn(owner: TurnOwner): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }> {
  if (shouldUseExternalRuntime()) {
    const externalResult = await externalEngine.stopOwnedTurn(owner);
    if (!externalResult.success || !externalResult.alreadyStopped) return externalResult;
  }
  return builtinEngine.stopOwnedTurn(owner);
}

export async function stopOwnedTurnByQueueId(
  owner: TurnOwner,
  queueId: string,
): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }> {
  const engine = getSessionEngine();
  const canceled = await engine.cancelQueuedMessage(queueId);
  const current = engine.getCurrentTurnIdentity();
  if (
    current?.queueId === queueId
    && current.owner.kind === owner.kind
    && current.owner.id === owner.id
  ) {
    return engine.stopTurn();
  }
  return { success: true, alreadyStopped: canceled.status !== 'cancelled' };
}

/**
 * Permission prompts historically route to the external runtime only while an
 * external session is active; otherwise they fall back to builtin pending
 * requests. Keep that compatibility at the selector seam.
 */
export function getPermissionResponseEngine(): SessionEngine {
  return shouldUseExternalRuntime() && isExternalSessionActive()
    ? externalEngine
    : builtinEngine;
}

/**
 * AskUserQuestion ownership is tracked per request id. If an external request
 * is still pending, route back to that owner even if the process has just gone
 * away; the external handler preserves the pending entry and returns false so
 * the UI can surface retry/failure instead of silently losing the answer.
 */
export function getAskUserQuestionResponseEngine(requestId: string): SessionEngine {
  return shouldUseExternalRuntime() && hasPendingExternalAskUserQuestion(requestId)
    ? externalEngine
    : builtinEngine;
}
