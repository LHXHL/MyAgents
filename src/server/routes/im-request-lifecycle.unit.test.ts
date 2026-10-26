import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { imEventBus } from '../utils/im-event-bus';
import { imRequestRegistry } from '../utils/im-request-registry';
import { existingImRequestResponse, handleImRequestLifecycle } from './im-request-lifecycle';

const { cancel } = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock('../session-engine', () => ({ getSessionEngine: () => ({ cancelImRequest: cancel }) }));

const post = (path: string, body: unknown) => handleImRequestLifecycle(new Request(`http://localhost/api/im/${path}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
}));
beforeEach(() => { imRequestRegistry.clear(); imEventBus.clear(); cancel.mockReset(); });
afterEach(() => { imRequestRegistry.clear(); imEventBus.clear(); });

it('does not seal pre-admission unknown IDs until the consumer explicitly permits it', async () => {
  const inspect = await post('requests', { requestIds: ['r'] });
  expect(await inspect!.json()).toEqual({ outcomes: { r: { state: 'unknown' } } });
  expect(existingImRequestResponse('r', 'session')).toBeNull();
  const sealed = await post('requests', { requestIds: ['r'], settleUnknown: ['r'] });
  expect(await sealed!.json()).toMatchObject({ outcomes: { r: { state: 'terminal', event: { type: 'error' } } } });
  expect(existingImRequestResponse('r', 'session')?.status).toBe(200);
});

it('keeps active work through unknown ACK reconciliation and reuses its exact terminal', async () => {
  imRequestRegistry.register('r', 'session');
  const active = await post('requests', { requestIds: ['r'], settleUnknown: ['r'] });
  expect(await active!.json()).toEqual({ outcomes: { r: { state: 'active' } } });
  expect(existingImRequestResponse('r', 'session')?.status).toBe(200);
  imEventBus.emit('r', 'complete', { finalPayloads: [{ text: 'canonical result' }] });
  imRequestRegistry.unregister('r');
  const done = await post('requests', { requestIds: ['r'], settleUnknown: ['r'] });
  expect(await done!.json()).toMatchObject({ outcomes: { r: { event: { type: 'complete', data: { finalPayloads: [{ text: 'canonical result' }] } } } } });
  expect(cancel).not.toHaveBeenCalled();
});

it('fences a delayed enqueue when channel stop arrives before registration', async () => {
  const stopped = await post('cancel', { requestId: 'late', reason: 'channel-stopped' });
  expect(stopped?.status).toBe(200);
  // This is the production enqueue guard, before registration or Runtime work.
  expect(await existingImRequestResponse('late', 'session')!.json()).toMatchObject({ accepted: true, requestId: 'late' });
  expect(imRequestRegistry.get('late')).toBeUndefined();
  expect(imRequestRegistry.outcome('late')).toMatchObject({ state: 'terminal', event: { type: 'cancelled' } });
  expect(cancel).not.toHaveBeenCalled();
});

it('preserves a real terminal when cancellation arrives after execution', async () => {
  imEventBus.emit('r', 'complete', { finalPayloads: [{ text: 'done' }] });
  await post('cancel', { requestId: 'r' });
  expect(imRequestRegistry.outcome('r')).toMatchObject({ state: 'terminal', event: { type: 'complete' } });
  expect(cancel).not.toHaveBeenCalled();
});

it.each(['running', 'queued'] as const)('keeps the existing Session cancellation behavior for %s input', async mode => {
  imRequestRegistry.register('r', 'session');
  imRequestRegistry.transferCancellationToRuntime('r');
  cancel.mockResolvedValue({ mode });
  const response = await post('cancel', { requestId: 'r', reason: 'channel-stopped' });
  expect(await response!.json()).toMatchObject({ success: true, mode });
  expect(cancel).toHaveBeenCalledExactlyOnceWith('r', 'channel-stopped');
  expect(imRequestRegistry.outcome('r').state).toBe(mode === 'queued' ? 'terminal' : 'active');
});
