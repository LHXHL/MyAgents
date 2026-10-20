import { describe, expect, it } from 'vitest';
import { buildCustomProvider, EMPTY_CUSTOM_FORM } from './providerForms';

describe('custom provider form projection', () => {
  it('preserves model metadata and chosen primary when committing a draft', () => {
    const models = [{ model: 'first', modelName: 'First', modelSeries: 'custom', source: 'discovered' as const, contextLength: 64000 },
      { model: 'second', modelName: 'Second', modelSeries: 'custom', inputModalities: ['text', 'image'] as ('text' | 'image')[] }];
    const provider = buildCustomProvider({ ...EMPTY_CUSTOM_FORM, name: 'Draft', baseUrl: 'https://example.invalid/v1', apiKey: 'not-provider-data',
      apiProtocol: 'openai', upstreamFormat: 'responses', maxOutputTokens: '4096', maxOutputTokensParamName: 'max_output_tokens', models, primaryModel: 'second' }, 'created');
    expect(provider).toMatchObject({ id: 'created', models, primaryModel: 'second', apiProtocol: 'openai', upstreamFormat: 'responses', maxOutputTokens: 4096, maxOutputTokensParamName: 'max_output_tokens' });
    expect(provider).not.toHaveProperty('apiKey');
  });
  it('uses the first remaining model if the previous primary was removed', () => {
    expect(buildCustomProvider({ ...EMPTY_CUSTOM_FORM, primaryModel: 'removed', models: [{ model: 'kept', modelName: 'Kept', modelSeries: 'custom' }] }, 'created').primaryModel).toBe('kept');
  });
});
