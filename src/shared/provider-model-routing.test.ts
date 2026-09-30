import { describe, expect, it } from 'vitest';
import { mergePresetCustomModels, PRESET_PROVIDERS } from './config-types';
import { OPENCODE_GO_MODELS, OPENCODE_GO_PROVIDER_ID } from './opencode-go';
import { assertQueryModelRoutesCompatible, resolveProviderForModel } from './provider-model-routing';

const go = PRESET_PROVIDERS.find(provider => provider.id === OPENCODE_GO_PROVIDER_ID)!;

describe('OpenCode Go model routing', () => {
  it('maps each official endpoint to exactly one executable protocol', () => {
    expect(go.primaryModel).toBe('minimax-m3');
    expect(go.models).toHaveLength(30);
    expect(new Set(go.models.map(model => model.model)).size).toBe(30);
    expect(OPENCODE_GO_MODELS.map(model => model.model)).toEqual(go.models.map(model => model.model));
    for (const model of go.models) {
      expect(model.supportedProtocols).toHaveLength(1);
      const route = resolveProviderForModel(go, model.model);
      const protocol = model.supportedProtocols![0];
      expect(route.config.baseUrl).toBe(protocol === 'anthropic:messages'
        ? 'https://opencode.ai/zen/go' : 'https://opencode.ai/zen/go/v1');
      expect(route.apiProtocol).toBe(protocol === 'anthropic:messages' ? 'anthropic' : 'openai');
      expect(route.upstreamFormat).toBe(protocol === 'openai:responses' ? 'responses'
        : protocol === 'openai:chat-completions' ? 'chat_completions' : undefined);
      expect(route.authType).toBe('api_key');
    }
  });

  it('requires an unknown model route and preserves explicit choice through preset merge', () => {
    const unknown = { model: 'future', modelName: 'Future', modelSeries: 'other', source: 'manual' as const };
    expect(() => resolveProviderForModel({ ...go, models: [...go.models, unknown] }, 'future'))
      .toThrow('Set its protocol in model settings');
    const restored = mergePresetCustomModels([go], {
      [go.id]: [{ ...unknown, executionProtocol: 'openai:responses' }],
    })[0];
    expect(resolveProviderForModel(restored, 'future').upstreamFormat).toBe('responses');
    const conflicted = mergePresetCustomModels([go], {
      [go.id]: [{ ...go.models[0], source: 'manual', executionProtocol: 'anthropic:messages' }],
    })[0];
    expect(resolveProviderForModel(conflicted, go.models[0].model).apiProtocol).toBe('anthropic');
    expect(() => resolveProviderForModel(go, 'future')).toThrow('Set its protocol in model settings');
  });

  it('leaves fixed providers unchanged', () => {
    const fixed = PRESET_PROVIDERS.find(provider => provider.id === 'anthropic-api')!;
    expect(resolveProviderForModel(fixed, 'unknown')).toBe(fixed);
  });

  it('rejects known sub-agent protocols that cannot share the active SDK Query', () => {
    const active = resolveProviderForModel(go, 'minimax-m3');
    expect(() => assertQueryModelRoutesCompatible(go, active, ['qwen3.8-max'])).not.toThrow();
    expect(() => assertQueryModelRoutesCompatible(go, active, ['grok-4.7']))
      .toThrow('different API protocol');
    expect(() => assertQueryModelRoutesCompatible(go, active, ['future-go']))
      .toThrow('no known execution protocol');
  });
});
