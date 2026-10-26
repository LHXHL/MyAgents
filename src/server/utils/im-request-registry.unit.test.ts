import { beforeEach, describe, expect, it } from 'vitest';

import { imEventBus } from './im-event-bus';
import { imRequestRegistry } from './im-request-registry';

describe('ImRequestRegistry cancellation ownership', () => {
  beforeEach(() => {
    imRequestRegistry.clear();
  });

  it('keeps cancellation with the enqueue route until runtime admission succeeds', () => {
    const entry = imRequestRegistry.register('request-1', 'session-1', 'feishu_group');

    expect(entry.cancellationOwner).toBe('admission-route');
    expect(imRequestRegistry.claimCancellation('request-1', 'user')).toEqual({
      outcome: 'claimed',
      owner: 'admission-route',
    });
    expect(entry.abortController.signal.aborted).toBe(true);
  });

  it('transfers cancellation ownership to the runtime after admission', () => {
    const entry = imRequestRegistry.register('request-1', 'session-1', 'feishu_group');

    imRequestRegistry.transferCancellationToRuntime('request-1');

    expect(entry.cancellationOwner).toBe('runtime');
    expect(entry.status).toBe('running');
  });

  it('gives overlapping runtime cancellation calls one atomic claim', () => {
    const entry = imRequestRegistry.register('request-1', 'session-1', 'feishu_group');
    imRequestRegistry.transferCancellationToRuntime('request-1');

    expect(imRequestRegistry.claimCancellation('request-1', 'user')).toEqual({
      outcome: 'claimed',
      owner: 'runtime',
    });
    expect(imRequestRegistry.claimCancellation('request-1', 'user')).toEqual({
      outcome: 'already-claimed',
      owner: 'runtime',
    });
    expect(imRequestRegistry.get('request-1')).toBe(entry);
    expect(entry.abortController.signal.aborted).toBe(true);
  });
});


describe('producer terminal receipts (#678)', () => {
  beforeEach(() => { imRequestRegistry.clear(); imEventBus.clear(); });

  it('recovers the exact terminal after unregister and 20,001 delta evictions', () => {
    imRequestRegistry.register('lost', 'session');
    const final = { finalPayloads: [{ text: 'canonical result' }] };
    imEventBus.emit('lost', 'complete', final);
    imRequestRegistry.unregister('lost');
    for (let i = 0; i < 20_001; i++) imEventBus.emit('other', 'delta', 'x');
    const replay: string[] = [];
    imEventBus.subscribe(0, event => replay.push(event.type), undefined, 'lost')();
    expect(replay).toContain('gap');
    expect(replay).not.toContain('complete');
    expect(imRequestRegistry.outcome('lost')).toMatchObject({ state: 'terminal', event: { type: 'complete', data: final } });
    imRequestRegistry.acknowledgeTerminal('lost');
    expect(imRequestRegistry.outcome('lost')).toEqual({ state: 'unknown' });
  });

  it('never prunes silent queued/running requests and distinguishes unknown from active', () => {
    const request = imRequestRegistry.register('silent', 'session');
    request.updatedAt = 0;
    expect(imRequestRegistry.pruneStale(1)).toBe(0);
    imRequestRegistry.transferCancellationToRuntime('silent');
    request.updatedAt = 0;
    expect(imRequestRegistry.pruneStale(1)).toBe(0);
    expect(imRequestRegistry.outcome('silent')).toEqual({ state: 'active' });
    expect(imRequestRegistry.outcome('absent')).toEqual({ state: 'unknown' });
  });

  it('bounds retained receipts and makes evicted outcomes explicitly unknown', () => {
    for (let i = 0; i < 201; i++) imEventBus.emit(`r${i}`, 'cancelled', { finalPayloads: [] });
    expect(imRequestRegistry.outcome('r0')).toEqual({ state: 'unknown' });
    expect(imRequestRegistry.outcome('r200')).toMatchObject({ state: 'terminal' });
  });
});
