import { describe, expect, it } from 'vitest';

import {
  applyProviderEnablementAndOrder,
  isProviderEnabled,
  normalizeDisabledProviderIds,
  normalizeProviderOrder,
  PRESET_PROVIDERS,
  type Provider,
} from './types';

const makeProvider = (id: string): Provider => ({
  id,
  name: id,
  vendor: 'Test',
  cloudProvider: 'Test',
  type: 'api',
  primaryModel: `${id}-model`,
  isBuiltin: false,
  authType: 'api_key',
  config: { baseUrl: `https://${id}.example/v1` },
  models: [{ model: `${id}-model`, modelName: `${id} Model`, modelSeries: 'test' }],
});

describe('provider enablement and ordering helpers', () => {
  it('normalizes order by removing unknowns and appending new providers', () => {
    expect(normalizeProviderOrder(['alpha', 'beta', 'gamma'], [
      'missing',
      'gamma',
      'alpha',
      'gamma',
    ])).toEqual(['gamma', 'alpha', 'beta']);
  });

  it('places a newly added OpenCode Go card immediately before Claude API', () => {
    const ids = PRESET_PROVIDERS.map(provider => provider.id);
    const assertGoBeforeClaudeApi = (ordered: string[]) => {
      expect(ordered.indexOf('opencode-go')).toBe(ordered.indexOf('anthropic-api') - 1);
    };
    assertGoBeforeClaudeApi(normalizeProviderOrder(ids));
    assertGoBeforeClaudeApi(normalizeProviderOrder(ids, ids.filter(id => id !== 'opencode-go')));
    // A saved user order is an explicit choice and still takes precedence.
    const custom = normalizeProviderOrder(ids, ['anthropic-api', 'opencode-go']);
    expect(custom.indexOf('anthropic-api')).toBeLessThan(custom.indexOf('opencode-go'));
  });

  it('normalizes disabled ids by keeping only known unique providers', () => {
    expect(normalizeDisabledProviderIds(['alpha', 'beta'], [
      'missing',
      'alpha',
      'alpha',
    ])).toEqual(['alpha']);
  });

  it('applies enabled flags and configured order without mutating defaults', () => {
    const providers = ['alpha', 'beta', 'gamma'].map(makeProvider);
    const ordered = applyProviderEnablementAndOrder(providers, {
      providerOrder: ['gamma', 'alpha'],
      disabledProviderIds: ['alpha'],
    });

    expect(ordered.map(provider => provider.id)).toEqual(['gamma', 'alpha', 'beta']);
    expect(ordered.find(provider => provider.id === 'alpha')?.enabled).toBe(false);
    expect(isProviderEnabled(ordered.find(provider => provider.id === 'gamma'))).toBe(true);
    expect(providers.find(provider => provider.id === 'alpha')?.enabled).toBeUndefined();
  });
});
