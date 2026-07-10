import type { CronTask } from '@/types/cronTask';

function isTerminal(task: CronTask): boolean {
  return task.goalStatus === 'complete'
    || task.goalStatus === 'blocked'
    || task.goalStatus === 'canceled';
}

function stateTime(task: CronTask): number {
  const parsed = Date.parse(task.goalUpdatedAt ?? task.updatedAt ?? task.createdAt ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Accept only state that cannot move the visible Goal backwards. */
export function shouldAcceptGoalState(incoming: CronTask, current: CronTask | null): boolean {
  if (!current || !current.goalStatus) return true;
  if (incoming.id !== current.id) {
    if (isTerminal(incoming) && !isTerminal(current)) return false;
    return stateTime(incoming) >= stateTime(current);
  }
  if (isTerminal(current) && !isTerminal(incoming)) return false;

  const incomingRevision = incoming.goalRevision;
  const currentRevision = current.goalRevision;
  if (incomingRevision !== undefined && currentRevision !== undefined) {
    return incomingRevision >= currentRevision;
  }
  return stateTime(incoming) >= stateTime(current);
}

/** Recover only a terminal transition that could have landed before listeners attached. */
export function isTerminalGoalFromListenerGap(
  goal: CronTask,
  listenerStartedAt: number,
  listenersReadyAt: number | null,
): boolean {
  if (!isTerminal(goal) || listenersReadyAt === null) return false;
  const changedAt = stateTime(goal);
  return changedAt >= listenerStartedAt && changedAt <= listenersReadyAt;
}
