import type { NetworkReturnReference } from '../../shared/agentNetworkReturn';

export interface PendingSessionWatch {
  watchId: string;
  watcherSessionId: string;
  watcherResumeWorkspacePath?: string;
  targetSessionId: string;
  targetLabel: string;
  targetStateAtRegistration: string;
  registeredAt: string;
  turnId?: string;
  /** Host-verified remote device scope, or the local caller identity. */
  observerScope?: string;
  networkReturn?: NetworkReturnReference;
}

const pendingWatches = new Map<string, PendingSessionWatch>();

export function registerPendingSessionWatch(watch: PendingSessionWatch): PendingSessionWatch {
  if (watch.turnId) {
    const existing = [...pendingWatches.values()].find(item =>
      item.turnId === watch.turnId && item.targetSessionId === watch.targetSessionId &&
      item.watcherSessionId === watch.watcherSessionId && item.observerScope === watch.observerScope);
    if (existing) return existing;
  }
  pendingWatches.set(watch.watchId, watch);
  return watch;
}

export function listPendingSessionWatches(): PendingSessionWatch[] {
  return [...pendingWatches.values()];
}

export function ackPendingSessionWatch(watchId: string): void {
  pendingWatches.delete(watchId);
}

/** Network cleanup cannot delete a local or replacement watch with the same
 * watch ID. No turn is cancelled and no ordinary inbox queue is touched. */
export function removeNetworkSessionWatch(watchId: string, reference: NetworkReturnReference): boolean {
  const watch = pendingWatches.get(watchId);
  if (watch?.networkReturn?.opId !== reference.opId
    || watch.networkReturn.returnRouteId !== reference.returnRouteId) return false;
  return pendingWatches.delete(watchId);
}

export function clearPendingSessionWatchesForTest(): void {
  pendingWatches.clear();
}

export function pendingSessionWatchCount(): number {
  return pendingWatches.size;
}

export function manageLocalSessionWatches(watcherSessionId: string, cancel?: string, all = false) {
  return listPendingSessionWatches().filter(watch => !watch.networkReturn && watch.watcherSessionId === watcherSessionId)
    .map(watch => {
      const cancelled = all || cancel === watch.watchId;
      if (cancelled) ackPendingSessionWatch(watch.watchId);
      return { watchId: watch.watchId, targetSessionId: watch.targetSessionId, turnId: watch.turnId, source: 'local', cancelled };
    });
}
