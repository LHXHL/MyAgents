import { describe, expect, it } from 'vitest';

import {
  ackPendingSessionWatch,
  clearPendingSessionWatchesForTest,
  listPendingSessionWatches,
  pendingSessionWatchCount,
  registerPendingSessionWatch,
  removeNetworkSessionWatch,
} from './watch-registry';

describe('session watch registry', () => {
  it('only cleans up the original remote registration, preserving local and replacement watches', () => {
    clearPendingSessionWatchesForTest();
    const reference = { opId: 'op-1', returnRouteId: 'route-1' };
    const watch = { watchId: 'watch-1', watcherSessionId: 'source', targetSessionId: 'target',
      targetLabel: 'Target', targetStateAtRegistration: 'running', registeredAt: 'now' };
    registerPendingSessionWatch(watch);
    expect(removeNetworkSessionWatch(watch.watchId, reference)).toBe(false);
    registerPendingSessionWatch({ ...watch, networkReturn: reference });
    expect(removeNetworkSessionWatch(watch.watchId, { ...reference, opId: 'other' })).toBe(false);
    expect(removeNetworkSessionWatch(watch.watchId, { ...reference, returnRouteId: 'replacement' })).toBe(false);
    expect(pendingSessionWatchCount()).toBe(1);
    expect(removeNetworkSessionWatch(watch.watchId, reference)).toBe(true);
    expect(pendingSessionWatchCount()).toBe(0);
  });
  it('lists watches without dropping them and removes them on ack', () => {
    clearPendingSessionWatchesForTest();
    registerPendingSessionWatch({
      watchId: 'watch-1',
      watcherSessionId: 'session-a',
      targetSessionId: 'session-b',
      targetLabel: 'B',
      targetStateAtRegistration: 'running',
      registeredAt: '2026-06-20T12:00:00.000Z',
    });

    expect(pendingSessionWatchCount()).toBe(1);
    expect(listPendingSessionWatches()).toHaveLength(1);
    expect(pendingSessionWatchCount()).toBe(1);
    ackPendingSessionWatch('watch-1');
    expect(pendingSessionWatchCount()).toBe(0);
  });
});
