import type { NetworkReturnReference } from '../../shared/agentNetworkReturn';

export interface PendingSessionWatch {
  watchId: string;
  watcherSessionId: string;
  watcherResumeWorkspacePath?: string;
  targetSessionId: string;
  targetLabel: string;
  targetStateAtRegistration: string;
  registeredAt: string;
  networkReturn?: NetworkReturnReference;
}

const pendingWatches = new Map<string, PendingSessionWatch>();

export function registerPendingSessionWatch(watch: PendingSessionWatch): void {
  pendingWatches.set(watch.watchId, watch);
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
