import { describe, expect, it } from 'vitest';

import type { ProxySettings } from './config-types';
import {
  effectiveProxyScopeKey,
  normalizeProxyScope,
  removeProviderFromProxySettingsScope,
  shouldUseMyAgentsProxyForProvider,
} from './proxyScope';

function proxy(scope?: ProxySettings['scope'], enabled = true): ProxySettings {
  return {
    enabled,
    protocol: 'http',
    host: '127.0.0.1',
    port: 7897,
    ...(scope ? { scope } : {}),
  };
}

describe('proxy scope normalization', () => {
  it('defaults missing or non-custom scope to all', () => {
    expect(normalizeProxyScope(undefined)).toEqual({ mode: 'all' });
    expect(normalizeProxyScope({ mode: 'all', providerIds: ['deepseek'] })).toEqual({ mode: 'all' });
  });

  it('dedupes custom provider ids and drops blanks', () => {
    expect(normalizeProxyScope({ mode: 'custom', providerIds: ['deepseek', '', 'deepseek', ' openrouter '] }))
      .toEqual({ mode: 'custom', providerIds: ['deepseek', 'openrouter'] });
  });

  it('cleans stale ids against visible providers and falls back to all when empty', () => {
    expect(normalizeProxyScope({ mode: 'custom', providerIds: ['stale', 'deepseek'] }, ['deepseek']))
      .toEqual({ mode: 'custom', providerIds: ['deepseek'] });
    expect(normalizeProxyScope({ mode: 'custom', providerIds: ['stale'] }, ['deepseek']))
      .toEqual({ mode: 'all' });
  });
});

describe('provider-owned proxy decision', () => {
  it('does not use MyAgents proxy when disabled', () => {
    expect(shouldUseMyAgentsProxyForProvider(proxy(undefined, false), 'deepseek')).toBe(false);
  });

  it('uses MyAgents proxy for all providers by default', () => {
    expect(shouldUseMyAgentsProxyForProvider(proxy(), 'deepseek')).toBe(true);
  });

  it('uses MyAgents proxy only for selected custom providers', () => {
    const settings = proxy({ mode: 'custom', providerIds: ['anthropic-sub'] });
    expect(shouldUseMyAgentsProxyForProvider(settings, 'anthropic-sub')).toBe(true);
    expect(shouldUseMyAgentsProxyForProvider(settings, 'deepseek')).toBe(false);
  });

  it('includes provider and proxy url in the effective restart key', () => {
    expect(effectiveProxyScopeKey(proxy(), 'deepseek')).toBe('myagents-proxy:deepseek:http://127.0.0.1:7897');
    expect(effectiveProxyScopeKey(proxy({ mode: 'custom', providerIds: ['anthropic-sub'] }), 'deepseek'))
      .toBe('myagents-proxy:disabled-for-provider:deepseek');
  });

  it('removes deleted provider ids from custom scope and falls back to all when empty', () => {
    expect(removeProviderFromProxySettingsScope(
      proxy({ mode: 'custom', providerIds: ['deepseek', 'openrouter'] }),
      'deepseek',
    )?.scope).toEqual({ mode: 'custom', providerIds: ['openrouter'] });
    expect(removeProviderFromProxySettingsScope(
      proxy({ mode: 'custom', providerIds: ['deepseek'] }),
      'deepseek',
    )?.scope).toEqual({ mode: 'all' });
  });
});
