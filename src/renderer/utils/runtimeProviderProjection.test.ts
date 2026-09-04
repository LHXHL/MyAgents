import { describe, expect, it } from 'vitest';

import { MANAGED_CODEX_PROVIDER, type Provider } from '@/config/types';
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
  it('keeps every ordinary API Provider and all of its configured models', () => {
    const projected = projectProvidersForRuntime([
      provider('deepseek', 'deepseek-v4-pro', ['deepseek-v4-pro', 'deepseek-v4-flash']),
      provider('openrouter', 'anthropic/claude', ['anthropic/claude']),
    ], 'dsh');

    expect(projected).toHaveLength(2);
    expect(projected[0].models?.map((model) => model.model)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]);
    expect(projected[1].models?.map((model) => model.model)).toEqual(['anthropic/claude']);
  });

  it('uses Product Provider/model membership without restricting Builtin', () => {
    const openrouter = provider('openrouter', 'claude', ['claude', 'future-model']);
    expect(isProviderModelCompatibleWithRuntime('dsh', openrouter, 'claude')).toBe(true);
    expect(isProviderModelCompatibleWithRuntime('dsh', openrouter, 'missing')).toBe(false);
    expect(isProviderModelCompatibleWithRuntime('builtin', openrouter, 'missing')).toBe(true);
  });

  it('keeps Managed Codex as a runtime-backed choice without admitting it as a DSH cell', () => {
    const managedCodex = {
      ...MANAGED_CODEX_PROVIDER,
      primaryModel: 'gpt-5.4-codex',
      models: [{
        model: 'gpt-5.4-codex',
        modelName: 'GPT-5.4 Codex',
        modelSeries: 'codex',
      }],
    };

    expect(projectProvidersForRuntime([managedCodex], 'dsh')).toEqual([managedCodex]);
    expect(isProviderModelCompatibleWithRuntime('dsh', managedCodex, 'gpt-5.4-codex')).toBe(true);
  });
});
