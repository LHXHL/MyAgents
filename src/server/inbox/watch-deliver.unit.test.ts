import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => ({
  cancellableFetch: vi.fn(),
  networkReturn: vi.fn(),
}));

vi.mock('../SessionStore', () => ({ getSessionMetadata: () => null, getSessionData: async () => null }));

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
  it.each([true, false])('shares local automatic reply admission with its watch, delivered=%s', async delivered => {
    process.env.MYAGENTS_MANAGEMENT_PORT = '8123';
    registerPendingSessionWatch({ watchId: 'same-turn', watcherSessionId: 'caller', targetSessionId: 'target-session',
      targetLabel: 'Target', targetStateAtRegistration: 'running', registeredAt: 'now', turnId: 'turn' });
    registerPendingSessionWatch({ watchId: 'other-caller', watcherSessionId: 'other', targetSessionId: 'target-session',
      targetLabel: 'Target', targetStateAtRegistration: 'running', registeredAt: 'now', turnId: 'turn' });
    let finish!: (value: Response) => void;
    fetchMock.cancellableFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fetchMock.cancellableFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, outcome: { status: 'delivered' } })));
    const delivery = deliverSessionWatchEvents('target-session', { text: 'done', turnId: 'turn', requestEventIds: ['request'] },
      { fromSessionId: 'caller', fromLabel: 'Caller', originalMessageId: 'request', originalSnippet: 'query', replyBack: true });
    await vi.waitFor(() => expect(fetchMock.cancellableFetch).toHaveBeenCalledTimes(2));
    const messages = fetchMock.cancellableFetch.mock.calls.map(call => JSON.parse(call[1].body).message.sessionEvent);
    expect(messages.filter(event => event.targetSessionId === 'caller')).toEqual([expect.objectContaining({
      type: 'send.result', requestEventId: 'request', watchIds: ['same-turn'], turnId: 'turn',
    })]);
    finish(new Response(JSON.stringify({ ok: delivered, outcome: { status: delivered ? 'delivered' : 'unconfirmed' } })));
    await delivery;
    expect(pendingSessionWatchCount()).toBe(delivered ? 0 : 1);
    expect(fetchMock.cancellableFetch).toHaveBeenCalledTimes(2);
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
  it('never settles a watch from an unknown or different turn and does not serialize remote returns', async () => {
    process.env.MYAGENTS_MANAGEMENT_PORT = '8123';
    for (const id of ['one', 'two']) registerPendingSessionWatch({ watchId: id, watcherSessionId: id,
      targetSessionId: 'target-session', targetLabel: 'Target', targetStateAtRegistration: 'running',
      registeredAt: 'now', turnId: 'turn', networkReturn: { opId: id, returnRouteId: id } });
    await deliverSessionWatchEvents('target-session', { text: 'unrelated', turnId: 'next' });
    await deliverSessionWatchEvents('target-session', { text: 'unknown' });
    expect(fetchMock.networkReturn).not.toHaveBeenCalled();
    let settle!: () => void;
    fetchMock.networkReturn.mockImplementationOnce(() => new Promise<void>(resolve => { settle = resolve; }));
    fetchMock.networkReturn.mockResolvedValueOnce('delivered');
    const delivery = deliverSessionWatchEvents('target-session', { text: 'partial', turnId: 'turn', terminalStatus: 'stopped', requestEventIds: ['request'] });
    await Promise.resolve();
    expect(fetchMock.networkReturn).toHaveBeenCalledTimes(2);
    expect(fetchMock.networkReturn.mock.calls[1][1]).toMatchObject({ turnId: 'turn', terminalStatus: 'stopped', requestEventIds: ['request'] });
    settle();
    await delivery;
    expect(pendingSessionWatchCount()).toBe(0);
  });

});
