import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configRaw: null as string | null,
  fetch: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/tmp/myagents-analytics-test',
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => {
    if (mocks.configRaw === null) throw new Error('missing config');
    return mocks.configRaw;
  }),
}));

function enabledConfig(): string {
  return JSON.stringify({
    enabled: true,
    apiKey: 'api-key',
    endpoint: 'https://analytics.example.test/events',
    deviceId: 'device-1',
    platform: 'darwin-aarch64',
    appVersion: '0.2.36-test',
  });
}

describe('server analytics', () => {
  let restoreProxyState: (() => void) | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    mocks.configRaw = null;
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async (_url, init) => Response.json({
      success: true, received: JSON.parse(init.body).events.length,
    }));
    vi.stubGlobal('fetch', mocks.fetch);
    const cancellation = await import('../utils/cancellation');
    cancellation._setGeneralFetchTransportForTests(
      async (url, init) => globalThis.fetch(url, init as RequestInit),
    );
    const proxyState = await import('../proxy-state');
    const settings = proxyState.getCurrentProxySettings();
    const inherited = proxyState._getInheritedProxySnapshotForTests();
    proxyState._resetProxyStateForTests(null, {});
    restoreProxyState = () => proxyState._resetProxyStateForTests(settings, inherited);
  });

  afterEach(async () => {
    const cancellation = await import('../utils/cancellation');
    cancellation._setGeneralFetchTransportForTests();
    restoreProxyState?.();
    restoreProxyState = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('keeps early events until the renderer-written config appears', async () => {
    const { trackServer } = await import('../analytics');

    trackServer('ai_turn_complete', { source: 'desktop', runtime: 'builtin' });
    expect(mocks.fetch).not.toHaveBeenCalled();

    mocks.configRaw = enabledConfig();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const request = mocks.fetch.mock.calls[0];
    expect(request[0]).toBe('https://analytics.example.test/events');
    expect(request[1]?.headers).toEqual(expect.objectContaining({ 'X-API-Key': 'api-key' }));
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      events: [
        expect.objectContaining({
          event: 'ai_turn_complete',
          device_id: 'device-1',
          platform: 'darwin-aarch64',
          app_version: '0.2.36-test',
          params: { source: 'desktop', runtime: 'builtin' },
        }),
      ],
    });
  });

  it('does not queue events when analytics is explicitly disabled', async () => {
    mocks.configRaw = JSON.stringify({
      enabled: false,
      apiKey: '',
      endpoint: '',
      deviceId: 'device-1',
      platform: 'darwin-aarch64',
      appVersion: '0.2.36-test',
    });
    const { trackServer } = await import('../analytics');

    trackServer('ai_turn_complete', { source: 'desktop' });
    mocks.configRaw = enabledConfig();
    await vi.advanceTimersByTimeAsync(2000);

    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not overlap flushes while a send is still in flight', async () => {
    mocks.configRaw = enabledConfig();
    let resolveFetch: ((value: Response) => void) | undefined;
    mocks.fetch.mockImplementation(() => new Promise(resolve => {
      resolveFetch = resolve;
    }));
    const { trackServer } = await import('../analytics');

    for (let i = 0; i < 30; i += 1) {
      trackServer('ai_turn_complete', { index: i });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    for (let i = 30; i < 60; i += 1) {
      trackServer('ai_turn_complete', { index: i });
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    resolveFetch?.(Response.json({ success: true, received: 30 }));
    await Promise.resolve();
  });

  it.each([500, 429, 408, 'network', 'receipt'] as const)(
    'retains a failed batch (%s), preserves order and waits through backoff', async failure => {
      mocks.configRaw = enabledConfig();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mocks.fetch.mockImplementationOnce(async () => {
        if (failure === 'network') throw new Error('secret endpoint or event details');
        return failure === 'receipt'
          ? Response.json({ success: false, received: 0 })
          : new Response('', { status: failure });
      });
      const { trackServer } = await import('../analytics');
      trackServer('first');
      await vi.advanceTimersByTimeAsync(3000);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 30; i++) trackServer('new-event');
      await vi.advanceTimersByTimeAsync(999);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      const first = JSON.parse(mocks.fetch.mock.calls[0][1].body).events[0];
      expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).events[0]).toEqual(first);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret endpoint');
      warn.mockRestore();
    },
  );

  it('keeps retrying a long outage without retiring the batch', async () => {
    mocks.configRaw = enabledConfig();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.fetch.mockImplementation(async () => new Response('', { status: 503 }));
    const { trackServer } = await import('../analytics');
    trackServer('outage');
    await vi.advanceTimersByTimeAsync(130_000);
    expect(mocks.fetch.mock.calls.length).toBeGreaterThan(6);
    expect(mocks.fetch.mock.calls.every(call =>
      JSON.parse(call[1].body).events[0].event === 'outage')).toBe(true);
    vi.restoreAllMocks();
  });

  it('bounds the queue including the in-flight batch and retires permanent 4xx', async () => {
    mocks.configRaw = enabledConfig();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.fetch.mockImplementationOnce(async () => new Response('', { status: 401 }));
    const { trackServer } = await import('../analytics');
    for (let i = 0; i < 700; i++) trackServer('bounded', { index: i });
    await vi.advanceTimersByTimeAsync(60_000);
    const sent = mocks.fetch.mock.calls.flatMap(call => JSON.parse(call[1].body).events);
    expect(sent).toHaveLength(500);
    expect(sent.at(-1).params.index).toBe(499);
    expect(JSON.stringify(warn.mock.calls)).toContain('401');
    expect(JSON.stringify(warn.mock.calls)).toContain('capacity');
  });

  it('times out a stalled receipt body and retries the retained batch', async () => {
    mocks.configRaw = enabledConfig();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.fetch.mockImplementationOnce(async (_url, init) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    }));
    const { trackServer } = await import('../analytics');
    trackServer('slow-receipt');
    await vi.advanceTimersByTimeAsync(13_000);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls[0][1].body).toEqual(mocks.fetch.mock.calls[1][1].body);
  });

  it('cancels stalled non-success response bodies before retrying', async () => {
    mocks.configRaw = enabledConfig();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cancel = vi.fn();
    mocks.fetch.mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial error')); },
      cancel,
    }), { status: 503 }));
    const { trackServer } = await import('../analytics');
    trackServer('retry');
    await vi.advanceTimersByTimeAsync(3000);
    expect(cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});
