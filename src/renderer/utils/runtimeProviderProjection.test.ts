import { describe, expect, it } from 'vitest';

import type { Provider } from '@/config/types';
import {
  isProviderModelCompatibleWithRuntime,
  projectProvidersForRuntime,
} from './runtimeProviderProjection';

function provider(id: string, primaryModel: string, models: string[]): Provider {
  return {
    id,
    name: id,
    vendor: id,
    cloudProvider: 'test',
    type: 'api',
    isBuiltin: false,
    authType: 'api_key',
    apiProtocol: 'openai',
    upstreamFormat: 'chat_completions',
    enabled: true,
    primaryModel,
    models: models.map((model) => ({ model, modelName: model, modelSeries: id })),
    config: { baseUrl: 'https://example.test' },
  };
}

describe('runtime Provider projection', () => {
  it('keeps only exact DSH provider/model cells and repairs the visible primary model', () => {
    const projected = projectProvidersForRuntime([
      provider('deepseek', 'unsupported', ['unsupported', 'deepseek-v4-flash']),
      provider('openrouter', 'anthropic/claude', ['anthropic/claude']),
    ], 'dsh');

    expect(projected).toHaveLength(1);
    expect(projected[0].id).toBe('deepseek');
    expect(projected[0].primaryModel).toBe('deepseek-v4-flash');
    expect(projected[0].models?.map((model) => model.model)).toEqual(['deepseek-v4-flash']);
  });

  it('fails closed for an unsupported DSH pair without restricting Builtin', () => {
    expect(isProviderModelCompatibleWithRuntime('dsh', 'openrouter', 'claude')).toBe(false);
    expect(isProviderModelCompatibleWithRuntime('dsh', 'deepseek', 'deepseek-v4-flash')).toBe(true);
    expect(isProviderModelCompatibleWithRuntime('builtin', 'openrouter', 'claude')).toBe(true);
  });
});
