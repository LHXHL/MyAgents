import { interruptCurrentResponse } from '../agent-session';
import {
  getActiveRuntimeType,
  hasPendingExternalAskUserQuestion,
  isExternalSessionActive,
  shouldUseExternalRuntime,
} from '../runtimes/external-session';
import { createBuiltinSessionEngine } from './builtin-adapter';
import { createExternalSessionEngine } from './external-adapter';
import { cancelPendingGoalDispatches } from './goal-turn-authority';
import type { SessionEngine, SessionEngineKind } from './types';

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
  // A queue item may already be removed from the visible queue while its
  // pre-dispatch Goal claim is still round-tripping through Rust. Cancel the
  // guard before checking runtime liveness so a late successful claim cannot
  // dispatch after Pause/Cancel has already revoked it.
  cancelPendingGoalDispatches();
  if (shouldUseExternalRuntime()) {
    if (isExternalSessionActive()) {
      return externalEngine.stopTurn();
    }
    const stopped = await interruptCurrentResponse();
    return stopped ? { success: true } : { success: true, alreadyStopped: true };
  }
  return builtinEngine.stopTurn();
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
