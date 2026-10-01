import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => ({
  cancellableFetch: vi.fn(),
  networkReturn: vi.fn(),
}));

vi.mock('../utils/cancellation', () => ({
  cancellableFetch: fetchMock.cancellableFetch,
}));
vi.mock('../agent-network/return', () => ({ deliverNetworkReturn: fetchMock.networkReturn }));

import { deliverSessionWatchEvents } from './watch-deliver';
import {
  clearPendingSessionWatchesForTest,
  pendingSessionWatchCount,
  registerPendingSessionWatch,
} from './watch-registry';

function registerWatch(): void {
  registerPendingSessionWatch({
    watchId: 'watch-1',
    watcherSessionId: 'watcher-session',
    targetSessionId: 'target-session',
    targetLabel: 'Target',
    targetStateAtRegistration: 'running',
    registeredAt: '2026-06-20T12:00:00.000Z',
  });
}

describe('deliverSessionWatchEvents', () => {
  afterEach(() => {
    clearPendingSessionWatchesForTest();
    fetchMock.cancellableFetch.mockReset();
    fetchMock.networkReturn.mockReset();
    delete process.env.MYAGENTS_MANAGEMENT_PORT;
  });

  it('acks a watch only after confirmed delivery', async () => {
    process.env.MYAGENTS_MANAGEMENT_PORT = '8123';
    registerWatch();
    fetchMock.cancellableFetch.mockResolvedValue(new Response(
      JSON.stringify({ ok: true, outcome: { status: 'delivered', message_id: 'msg-1' } }),
      { status: 200 },
    ));

    await deliverSessionWatchEvents('target-session', { text: 'done' });

    expect(pendingSessionWatchCount()).toBe(0);
  });

  it('keeps a watch pending when delivery fails', async () => {
    process.env.MYAGENTS_MANAGEMENT_PORT = '8123';
    registerWatch();
    fetchMock.cancellableFetch.mockResolvedValue(new Response(
      JSON.stringify({ ok: false, outcome: { status: 'delivery_failed', reason: 'starting' } }),
      { status: 200 },
    ));

    await deliverSessionWatchEvents('target-session', { text: 'done' });

    expect(pendingSessionWatchCount()).toBe(1);
  });
  it('settles a remote watch once without treating the remote source as a local Session', async () => {
    process.env.MYAGENTS_MANAGEMENT_PORT = '8123';
    const reference = { opId: 'op', returnRouteId: 'route' };
    registerPendingSessionWatch({ watchId: 'remote-watch', watcherSessionId: 'remote-source',
      targetSessionId: 'target-session', targetLabel: 'Target', targetStateAtRegistration: 'running',
      registeredAt: 'now', networkReturn: reference });
    fetchMock.networkReturn.mockResolvedValue('unconfirmed');
    await deliverSessionWatchEvents('target-session', { text: 'done' });
    expect(fetchMock.networkReturn).toHaveBeenCalledWith(reference, expect.objectContaining({
      type: 'watch.completed', watchId: 'remote-watch', sourceSessionId: 'target-session',
      targetSessionId: 'remote-source', latestResult: 'done',
    }));
    expect(fetchMock.cancellableFetch).not.toHaveBeenCalled();
    expect(pendingSessionWatchCount()).toBe(0);
    await deliverSessionWatchEvents('target-session', { text: 'later' });
    expect(fetchMock.networkReturn).toHaveBeenCalledTimes(1);
  });
});
