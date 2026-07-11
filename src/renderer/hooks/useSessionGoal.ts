import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createGoalTask,
  getSessionGoalTask,
  markGoalTerminal,
  pauseGoalTask,
  resumeGoalTask,
} from '@/api/cronTaskClient';
import { track } from '@/analytics';
import type {
  CronTask,
  CronTaskConfig,
  GoalChangedPayload,
} from '@/types/cronTask';
import { isTauriEnvironment } from '@/utils/browserMock';
import {
  isTerminalGoalFromListenerGap,
  projectGoalExecutionState,
  shouldAcceptGoalState,
} from '@/utils/goalStateReconciliation';
import { createSyncStateRef } from '@/utils/syncStateRef';
import { listenWithCleanup } from '@/utils/tauriListen';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import { coerceRuntimeBirthPermissionMode } from '@/../shared/runtimeBirthFields';

export type SessionGoalDraftConfig = Omit<CronTaskConfig, 'workspacePath' | 'sessionId' | 'tabId'> & {
  taskKind: 'goal';
};

export interface SessionGoalState {
  task: CronTask | null;
  isStarting: boolean;
  isExecuting: boolean;
  executionNumber?: number;
  error: string | null;
}

export interface SessionGoalStopResult {
  task: CronTask;
  prompt: string | null;
}

export interface SessionGoalOwner {
  sessionId: string;
  workspacePath: string;
}

interface UseSessionGoalOptions {
  workspacePath: string;
  sessionId: string;
  materializeOwner?: () => Promise<SessionGoalOwner>;
  onExecutionComplete?: (task: CronTask, success: boolean) => void | Promise<void>;
}

interface PendingGoalStart {
  canceled: boolean;
  phase: 'materializing' | 'creating';
  initialOwner: SessionGoalOwner;
  owner?: SessionGoalOwner;
}

const initialState: SessionGoalState = {
  task: null,
  isStarting: false,
  isExecuting: false,
  executionNumber: undefined,
  error: null,
};

function isGoalTask(task: CronTask | null | undefined): task is CronTask & { goalStatus: NonNullable<CronTask['goalStatus']> } {
  return Boolean(task?.goalStatus);
}

function isTerminalGoal(task: CronTask | null | undefined): boolean {
  return task?.goalStatus === 'complete'
    || task?.goalStatus === 'blocked'
    || task?.goalStatus === 'canceled';
}

function taskDurationMinutes(task: CronTask): number {
  const createdAt = Date.parse(task.createdAt);
  return Number.isFinite(createdAt) ? Math.round((Date.now() - createdAt) / 60_000) : 0;
}

function isSameGoalOwner(
  previous: { sessionId: string; workspacePath: string },
  next: { sessionId: string; workspacePath: string },
): boolean {
  if (!workspacePathsEqual(previous.workspacePath, next.workspacePath)) return false;
  return previous.sessionId === next.sessionId;
}

export function useSessionGoal(options: UseSessionGoalOptions) {
  const { workspacePath, sessionId } = options;
  const [state, setStateRaw] = useState<SessionGoalState>(initialState);
  const stateRef = useRef(createSyncStateRef(state, setStateRaw)).current;
  const setState = stateRef.set;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mountedRef = useRef(true);
  const dismissedIdsRef = useRef<Set<string>>(new Set());
  const pendingStartRef = useRef<PendingGoalStart | null>(null);
  const listenerStartedAtRef = useRef(Date.now());
  const listenersReadyAtRef = useRef<number | null>(null);
  const [listenersReady, setListenersReady] = useState(false);
  const ownerIdentityRef = useRef({ sessionId, workspacePath });

  const acceptSnapshot = useCallback((task: CronTask, patch: Partial<SessionGoalState> = {}) => {
    if (!isGoalTask(task)) return;
    setState(prev => {
      if (!shouldAcceptGoalState(task, prev.task)) return prev;
      return { ...prev, ...projectGoalExecutionState(task), ...patch, task };
    });
  }, [setState]);

  const cancelPendingStart = useCallback(() => {
    if (pendingStartRef.current) pendingStartRef.current.canceled = true;
    setState(prev => prev.isStarting ? { ...prev, isStarting: false } : prev);
  }, [setState]);

  const start = useCallback(async (
    config: SessionGoalDraftConfig,
    promptOverride?: string,
  ): Promise<CronTask | null> => {
    if (stateRef.current.isStarting) {
      throw new Error('[useSessionGoal] Goal start is already in flight');
    }
    const objective = (promptOverride ?? config.prompt).trim();
    if (!objective) throw new Error('[useSessionGoal] Goal objective is required');

    const initialOwner = { sessionId, workspacePath };
    const pendingStart: PendingGoalStart = {
      canceled: false,
      phase: 'materializing',
      initialOwner,
    };
    pendingStartRef.current = pendingStart;
    setState(prev => ({ ...prev, isStarting: true, error: null }));
    let createdTaskId: string | null = null;
    try {
      const startOwner = optionsRef.current.materializeOwner
        ? await optionsRef.current.materializeOwner()
        : initialOwner;
      if (pendingStart.canceled || pendingStartRef.current !== pendingStart) return null;
      pendingStart.phase = 'creating';
      pendingStart.owner = startOwner;
      const currentOwner = optionsRef.current;
      const currentMatchesStart = isSameGoalOwner(startOwner, currentOwner);
      const currentStillAwaitingAdoption = initialOwner.sessionId.startsWith('pending-')
        && isSameGoalOwner(initialOwner, currentOwner);
      if (!currentMatchesStart && !currentStillAwaitingAdoption) {
        pendingStartRef.current = null;
        setState(initialState);
        return null;
      }
      const task = await createGoalTask({
        workspacePath: startOwner.workspacePath,
        sessionId: startOwner.sessionId,
        prompt: objective,
        intervalMinutes: config.intervalMinutes,
        endConditions: config.endConditions,
        runMode: 'single_session',
        notifyEnabled: config.notifyEnabled,
        permissionMode: coerceRuntimeBirthPermissionMode(
          config.permissionMode,
          config.runtime ?? 'builtin',
        ),
      });
      createdTaskId = task.id;

      if (pendingStart.canceled) {
        dismissedIdsRef.current.add(task.id);
        await markGoalTerminal(task.id, 'canceled', 'Canceled before Goal Mode started');
        return null;
      }
      const currentOwnerAfterCreate = optionsRef.current;
      if (!mountedRef.current
        || pendingStartRef.current !== pendingStart
        || (!isSameGoalOwner(startOwner, currentOwnerAfterCreate)
          && !(initialOwner.sessionId.startsWith('pending-')
            && isSameGoalOwner(initialOwner, currentOwnerAfterCreate)))) {
        // Goal is session-owned. Navigating away must not cancel a Goal that
        // Rust already accepted; the old session will hydrate it when reopened.
        return task;
      }
      acceptSnapshot(task, { isStarting: false });
      return task;
    } catch (error) {
      if (pendingStart.canceled && !createdTaskId) return null;
      if (mountedRef.current && pendingStartRef.current === pendingStart) {
        setState(prev => ({
          ...prev,
          isStarting: false,
          error: error instanceof Error ? error.message : 'Failed to start Goal',
        }));
      }
      throw error;
    } finally {
      if (pendingStartRef.current === pendingStart) pendingStartRef.current = null;
    }
  }, [acceptSnapshot, sessionId, setState, stateRef, workspacePath]);

  const pause = useCallback(async (): Promise<CronTask | null> => {
    const current = stateRef.current.task;
    if (!isGoalTask(current) || isTerminalGoal(current)) return null;
    try {
      const task = await pauseGoalTask(current.id);
      acceptSnapshot(task);
      return task;
    } catch (error) {
      console.error('[useSessionGoal] Failed to pause Goal:', error);
      return null;
    }
  }, [acceptSnapshot, stateRef]);

  const resume = useCallback(async (): Promise<CronTask | null> => {
    const current = stateRef.current.task;
    if (!isGoalTask(current) || current.goalStatus !== 'paused') return null;
    try {
      const task = await resumeGoalTask(current.id);
      acceptSnapshot(task);
      return task;
    } catch (error) {
      console.error('[useSessionGoal] Failed to resume Goal:', error);
      return null;
    }
  }, [acceptSnapshot, stateRef]);

  const cancel = useCallback(async (reason = 'Canceled by user'): Promise<SessionGoalStopResult | null> => {
    const current = stateRef.current.task;
    if (!isGoalTask(current)) return null;
    try {
      const task = await markGoalTerminal(current.id, 'canceled', reason);
      if (task.goalStatus === 'canceled') {
        dismissedIdsRef.current.add(task.id);
        track('cron_stop', {
          reason: 'manual',
          execution_count: task.executionCount ?? current.executionCount ?? 0,
          duration_minutes: taskDurationMinutes(current),
        });
        setState(initialState);
      } else {
        acceptSnapshot(task);
      }
      return { task, prompt: current.goalObjective || current.prompt || null };
    } catch (error) {
      console.error('[useSessionGoal] Failed to cancel Goal:', error);
      return null;
    }
  }, [acceptSnapshot, setState, stateRef]);

  const dismiss = useCallback(() => {
    const current = stateRef.current.task;
    if (current && isTerminalGoal(current)) dismissedIdsRef.current.add(current.id);
    setState(initialState);
  }, [setState, stateRef]);

  const handleGoalChangedRef = useRef<(payload: GoalChangedPayload) => void>(() => {});
  const handleExecutionCompleteRef = useRef<(payload: {
    taskId: string;
    success: boolean;
    executionCount: number;
    internalSessionId?: string;
  }) => void>(() => {});

  handleGoalChangedRef.current = (payload) => {
    const currentOptions = optionsRef.current;
    if (!isGoalTask(payload.goal)) return;
    if (payload.sessionId !== currentOptions.sessionId) return;
    if (!workspacePathsEqual(payload.workspacePath, currentOptions.workspacePath)) return;
    if (isTerminalGoal(payload.goal) && dismissedIdsRef.current.has(payload.goal.id)) return;
    acceptSnapshot(payload.goal);
  };

  handleExecutionCompleteRef.current = (payload) => {
    const current = stateRef.current.task;
    if (current?.id !== payload.taskId) return;
    void optionsRef.current.onExecutionComplete?.({
      ...current,
      executionCount: payload.executionCount,
      ...(payload.internalSessionId ? { internalSessionId: payload.internalSessionId } : {}),
    }, payload.success);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingStartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();
    Promise.all([
      listenWithCleanup<GoalChangedPayload>(
        'goal:changed',
        event => handleGoalChangedRef.current(event.payload),
        ac.signal,
      ),
      listenWithCleanup<{
        taskId: string;
        success: boolean;
        executionCount: number;
        internalSessionId?: string;
      }>(
        'cron:execution-complete',
        event => handleExecutionCompleteRef.current(event.payload),
        ac.signal,
      ),
    ]).then(() => {
      if (ac.signal.aborted) return;
      listenersReadyAtRef.current = Date.now();
      setListenersReady(true);
    });
    return () => {
      ac.abort();
    };
  }, []);

  useEffect(() => {
    const previous = ownerIdentityRef.current;
    const next = { sessionId, workspacePath };
    ownerIdentityRef.current = next;
    const pendingStart = pendingStartRef.current;
    if (pendingStart) {
      const workspaceChanged = !workspacePathsEqual(
        pendingStart.initialOwner.workspacePath,
        next.workspacePath,
      );
      const expectedCreatingOwner = pendingStart.owner;
      const expectedSession = pendingStart.phase === 'materializing'
        || next.sessionId === pendingStart.initialOwner.sessionId
        || (expectedCreatingOwner && next.sessionId === expectedCreatingOwner.sessionId);
      if (workspaceChanged || !expectedSession) {
        pendingStartRef.current = null;
        setState(initialState);
      }
      return;
    }
    const projected = stateRef.current.task;
    if (projected
      && projected.sessionId === next.sessionId
      && workspacePathsEqual(projected.workspacePath, next.workspacePath)) return;
    if (isSameGoalOwner(previous, next)) return;
    // Detach the new surface from an old in-flight request without canceling
    // the old session's Goal. Only cancelPendingStart marks a request canceled.
    pendingStartRef.current = null;
    setState(initialState);
  }, [sessionId, setState, stateRef, workspacePath]);

  useEffect(() => {
    if (!isTauriEnvironment() || !listenersReady) return;
    if (!sessionId || sessionId.startsWith('pending-')) return;

    let cancelled = false;
    void getSessionGoalTask(sessionId, workspacePath, true).then(goal => {
      if (cancelled || !mountedRef.current) return;
      if (!goal) return;
      if (!isGoalTask(goal)) return;
      if (isTerminalGoal(goal) && dismissedIdsRef.current.has(goal.id)) return;
      const current = stateRef.current.task;
      if (isTerminalGoal(goal) && !current && !isTerminalGoalFromListenerGap(
        goal,
        listenerStartedAtRef.current,
        listenersReadyAtRef.current,
      )) return;
      if (!shouldAcceptGoalState(goal, current)) return;
      acceptSnapshot(goal);
    }).catch(error => {
      if (!cancelled) console.warn('[useSessionGoal] Failed to hydrate Goal state:', error);
    });
    return () => { cancelled = true; };
  }, [acceptSnapshot, listenersReady, sessionId, setState, stateRef, workspacePath]);

  return {
    state,
    start,
    pause,
    resume,
    cancel,
    dismiss,
    cancelPendingStart,
  };
}
