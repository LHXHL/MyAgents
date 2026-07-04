import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProxySettings } from '../shared/config-types';

const socksBridgeMocks = vi.hoisted(() => ({
  isSocksBridgeRunning: vi.fn(),
  startSocksBridge: vi.fn(),
  stopSocksBridge: vi.fn(),
}));

vi.mock('./utils/socks-bridge', () => ({
  isSocksBridgeRunning: socksBridgeMocks.isSocksBridgeRunning,
  startSocksBridge: socksBridgeMocks.startSocksBridge,
  stopSocksBridge: socksBridgeMocks.stopSocksBridge,
}));

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'MYAGENTS_PROXY_INJECTED',
  'MYAGENTS_PROXY_INHERITED_ENV_JSON',
] as const;

const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function clearProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loadProxyState() {
  vi.resetModules();
  return await import('./proxy-state');
}

const scopedProxySettings: ProxySettings = {
  enabled: true,
  protocol: 'http',
  host: '127.0.0.1',
  port: 7890,
  scope: { mode: 'custom', providerIds: ['included-provider'] },
};

describe('proxy-state provider scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearProxyEnv();
    socksBridgeMocks.isSocksBridgeRunning.mockReturnValue(false);
    socksBridgeMocks.startSocksBridge.mockResolvedValue(41234);
    socksBridgeMocks.stopSocksBridge.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreEnv();
  });

  it('restores the Rust pre-injection proxy baseline for providers excluded by custom scope', async () => {
    process.env.MYAGENTS_PROXY_INJECTED = '1';
    process.env.MYAGENTS_PROXY_INHERITED_ENV_JSON = JSON.stringify({
      HTTPS_PROXY: 'http://system.proxy:8080',
      NO_PROXY: '.corp.local',
    });
    process.env.HTTP_PROXY = 'http://myagents.proxy:7890';
    process.env.HTTPS_PROXY = 'http://myagents.proxy:7890';
    process.env.http_proxy = 'http://myagents.proxy:7890';
    process.env.https_proxy = 'http://myagents.proxy:7890';
    process.env.NO_PROXY = 'localhost,127.0.0.1';
    process.env.no_proxy = 'localhost,127.0.0.1';

    const proxyState = await loadProxyState();
    proxyState._resetProxyStateForTests(scopedProxySettings);

    const excludedEnv: Record<string, string | undefined> = {};
    proxyState.applyProviderProxyPolicyToEnv(excludedEnv, 'excluded-provider');

    expect(excludedEnv.HTTPS_PROXY).toBe('http://system.proxy:8080');
    expect(excludedEnv.HTTP_PROXY).toBeUndefined();
    expect(excludedEnv.NO_PROXY).toBe('.corp.local');
    expect(excludedEnv.MYAGENTS_PROXY_INJECTED).toBeUndefined();
    expect(excludedEnv.MYAGENTS_PROXY_INHERITED_ENV_JSON).toBeUndefined();
    expect(proxyState.getProxyForProviderUrl('excluded-provider', 'https://api.example.com/v1')).toBe(
      'http://system.proxy:8080',
    );

    const includedEnv: Record<string, string | undefined> = {};
    proxyState.applyProviderProxyPolicyToEnv(includedEnv, 'included-provider');
    expect(includedEnv.HTTP_PROXY).toBe('http://myagents.proxy:7890');
    expect(includedEnv.HTTPS_PROXY).toBe('http://myagents.proxy:7890');
  });

  it('stops a SOCKS bridge started by a superseded proxy transition', async () => {
    const socksStart = deferred<number>();
    socksBridgeMocks.startSocksBridge.mockReturnValueOnce(socksStart.promise);

    const proxyState = await loadProxyState();

    const first = proxyState.setProcessProxyConfig({
      enabled: true,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
    });
    await vi.waitFor(() => {
      expect(socksBridgeMocks.startSocksBridge).toHaveBeenCalledTimes(1);
    });
    const second = proxyState.setProcessProxyConfig({
      enabled: false,
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
    });

    socksStart.resolve(45678);
    await Promise.all([first, second]);

    expect(socksBridgeMocks.stopSocksBridge).toHaveBeenCalledTimes(1);
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
  });
});
