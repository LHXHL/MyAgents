import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ send: vi.fn(), tauri: true }));
vi.mock('@/api/tauriClient', () => ({ proxyAnalyticsFetch: mocks.send }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => mocks.tauri }));
vi.mock('./config', () => ({
  isAnalyticsEnabled: () => true, getApiKey: () => 'test-key',
  getEndpoint: () => 'https://analytics.example.test/api/track',
}));

const event = (index: number) => ({
  event: `event-${index}`, device_id: 'device', platform: 'test',
  app_version: 'test', params: {}, client_timestamp: '2026-10-25T00:00:00Z',
});

describe('analytics delivery queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.tauri = true;
    mocks.send.mockReset().mockImplementation(async (_url, init) => Response.json({
      success: true, received: JSON.parse(init.body).events.length,
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  });

  it.each([500, 429, 408, 'network', 'receipt', 'partial'] as const)(
    'retains %s failures and does not bypass the retry deadline', async failure => {
      mocks.send.mockImplementationOnce(async () => {
        if (failure === 'network') throw new Error('private data');
        if (failure === 'receipt' || failure === 'partial') {
          return Response.json({ success: failure === 'partial', received: 0 });
        }
        return new Response('', { status: failure });
      });
      const queue = await import('./queue');
      queue.enqueue(event(0)); await queue.flush();
      expect(queue.getQueueLength()).toBe(1);
      for (let i = 1; i < 60; i++) queue.enqueue(event(i));
      await queue.flush();
      await vi.advanceTimersByTimeAsync(999);
      expect(mocks.send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.send).toHaveBeenCalledTimes(2);
      expect(JSON.parse(mocks.send.mock.calls[1][1].body).events[0]).toEqual(event(0));
      expect(queue.getQueueLength()).toBe(0);
    },
  );

  it('retains a batch across more than five failures, then retires on a complete receipt', async () => {
    mocks.send.mockImplementation(async () => new Response('', { status: 503 }));
    const queue = await import('./queue');
    queue.enqueue(event(0)); await queue.flush();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(mocks.send.mock.calls.length).toBeGreaterThan(6);
    expect(queue.getQueueLength()).toBe(1);
    mocks.send.mockImplementation(async () => Response.json({ success: true, received: 1 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue.getQueueLength()).toBe(0);
  });

  it('retires permanent rejection and logs no event, endpoint or key', async () => {
    mocks.send.mockResolvedValue(new Response('', { status: 401 }));
    const queue = await import('./queue');
    queue.enqueue(event(0)); await queue.flush();
    expect(queue.getQueueLength()).toBe(0);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toContain('401');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/event-0|test-key|example.test/);
  });

  it('bounds retained events at 500 during a prolonged outage', async () => {
    mocks.send.mockImplementation(async () => new Response('', { status: 503 }));
    const queue = await import('./queue');
    for (let wave = 0; wave < 3; wave++) {
      for (let i = 0; i < 200; i++) queue.enqueue(event(wave * 200 + i));
      await vi.advanceTimersByTimeAsync(60_001);
    }
    expect(queue.getQueueLength()).toBe(500);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toContain('capacity');
  });

  it('does not overlap sends or let an old receipt remove events after clearQueue', async () => {
    let complete!: (response: Response) => void;
    mocks.send.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const queue = await import('./queue');
    queue.enqueue(event(0));
    const pending = queue.flush();
    queue.flushSync();
    queue.clearQueue();
    queue.enqueue(event(1));
    await queue.flush();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    complete(Response.json({ success: true, received: 1 })); await pending;
    expect(queue.getQueueLength()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.send.mock.calls[1][1].body).events).toEqual([event(1)]);
  });

  it('sends browser batches larger than the keepalive quota using normal fetch', async () => {
    mocks.tauri = false;
    const fetch = vi.fn(async (_url, init) => {
      // Browser keepalive rejects bodies >64 KiB before dispatch.
      if (init.keepalive && new TextEncoder().encode(init.body).length > 65_536) {
        throw new TypeError('Failed to fetch');
      }
      return Response.json({ success: true, received: 1 });
    });
    vi.stubGlobal('fetch', fetch);
    const queue = await import('./queue');
    queue.enqueue({ ...event(0), params: { text: 'x'.repeat(70_000) } });
    await queue.flush();
    expect(queue.getQueueLength()).toBe(0);
    queue.enqueue(event(1)); queue.flushSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(call => call[1].keepalive)).toEqual([false, true]);
  });
});
