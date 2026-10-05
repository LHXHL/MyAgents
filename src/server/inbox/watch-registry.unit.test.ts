import { describe, expect, it } from 'vitest';

import {
  ackPendingSessionWatch,
  clearPendingSessionWatchesForTest,
  listPendingSessionWatches,
  pendingSessionWatchCount,
  registerPendingSessionWatch,
  removeNetworkSessionWatch,
  manageLocalSessionWatches,
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
  it('coalesces only the same actual turn, caller and verified device scope', () => {
    clearPendingSessionWatchesForTest();
    const watch = { watchId: 'one', watcherSessionId: 'caller', targetSessionId: 'target', targetLabel: 'Target', targetStateAtRegistration: 'running', registeredAt: 'now', turnId: 'turn', observerScope: 'device-1' };
    expect(registerPendingSessionWatch(watch).watchId).toBe('one');
    expect(registerPendingSessionWatch({ ...watch, watchId: 'duplicate' }).watchId).toBe('one');
    registerPendingSessionWatch({ ...watch, watchId: 'another-device', observerScope: 'device-2' });
    registerPendingSessionWatch({ ...watch, watchId: 'another-caller', watcherSessionId: 'caller-2' });
    registerPendingSessionWatch({ ...watch, watchId: 'later-turn', turnId: 'turn-2' });
    expect(pendingSessionWatchCount()).toBe(4);
    expect(removeNetworkSessionWatch('duplicate', { opId: 'op', returnRouteId: 'route' })).toBe(false);
    clearPendingSessionWatchesForTest();
  });
  it('local cancel-all is scoped to caller and excludes network-owned observations', () => {
    clearPendingSessionWatchesForTest();
    const watch = { watchId: 'local', watcherSessionId: 'caller', targetSessionId: 'target', targetLabel: 'Target', targetStateAtRegistration: 'running', registeredAt: 'now' };
    registerPendingSessionWatch(watch);
    registerPendingSessionWatch({ ...watch, watchId: 'other', watcherSessionId: 'other' });
    registerPendingSessionWatch({ ...watch, watchId: 'remote', networkReturn: { opId: 'op', returnRouteId: 'route' } });
    expect(manageLocalSessionWatches('caller')).toHaveLength(1);
    expect(manageLocalSessionWatches('caller', undefined, true)).toMatchObject([{ watchId: 'local', cancelled: true }]);
    expect(listPendingSessionWatches().map(w => w.watchId)).toEqual(['other', 'remote']);
    clearPendingSessionWatchesForTest();
  });

});

it('exact cancellation cleans only its network, then allows rewatch of the same live turn',()=>{
 clearPendingSessionWatchesForTest();
 const base={watchId:'one',watcherSessionId:'caller',targetSessionId:'target',targetLabel:'Target',targetStateAtRegistration:'running',registeredAt:'now',turnId:'turn'};
 const a={connectionId:'network-a',opId:'op',returnRouteId:'route'},b={...a,connectionId:'network-b'};
 registerPendingSessionWatch({...base,observerScope:'service-a:network-a:device:1',networkReturn:a});
 registerPendingSessionWatch({...base,watchId:'other',observerScope:'service-b:network-b:device:1',networkReturn:b});
 expect(removeNetworkSessionWatch('one',b)).toBe(false);expect(removeNetworkSessionWatch('one',{opId:'op',returnRouteId:'route'})).toBe(false);
 expect(removeNetworkSessionWatch('one',a)).toBe(true);expect(listPendingSessionWatches().map(w=>w.watchId)).toEqual(['other']);
 expect(registerPendingSessionWatch({...base,watchId:'rewatch',observerScope:'service-a:network-a:device:1',networkReturn:{...a,returnRouteId:'new-route'}}).watchId).toBe('rewatch');
 clearPendingSessionWatchesForTest();
});
