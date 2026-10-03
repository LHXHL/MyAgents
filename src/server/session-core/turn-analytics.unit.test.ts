import { describe, expect, it } from 'vitest';
import { buildTurnProviderAnalytics, runtimeProviderAnalytics } from './turn-analytics';

describe('turn Provider attribution', () => {
  it('keeps subscription attribution and distinguishes OpenAI request families', () => {
    expect(buildTurnProviderAnalytics()).toMatchObject({ provider_id: 'anthropic-sub', api_protocol: 'anthropic', provider_api_family: 'anthropic-messages' });
    for (const upstreamFormat of ['responses', 'chat_completions'] as const) {
      expect(buildTurnProviderAnalytics({ providerId: 'api-a', apiProtocol: 'openai', upstreamFormat })).toMatchObject({
        provider_id: 'api-a', api_protocol: 'openai', provider_api_family: upstreamFormat === 'responses' ? 'openai-responses' : 'openai-completions',
      });
    }
  });

  it('uses the compiled DSH route rather than the Provider default protocol', () => {
    const analytics = buildTurnProviderAnalytics({ providerId: 'api-a', providerName: 'API A', apiProtocol: 'openai', baseUrl: 'https://user:secret@api.example.test/anthropic?token=secret#private' }, 'anthropic-messages');
    expect(analytics).toMatchObject({ provider_id: 'api-a', provider_name: 'API A', api_protocol: 'anthropic', provider_api_protocol: 'anthropic', provider_api_family: 'anthropic-messages', provider_base_url: 'https://api.example.test/anthropic' });
    expect(JSON.stringify(analytics)).not.toContain('secret');
    expect(Object.isFrozen(analytics)).toBe(true);
    expect(buildTurnProviderAnalytics({ baseUrl: 'https://api.example.test/' }).provider_base_url).toBe('https://api.example.test/');
    expect(buildTurnProviderAnalytics({ baseUrl: 'https://api.example.test' }).provider_base_url).toBe('https://api.example.test');
  });

  it('never labels an unknown DSH Provider as the DSH Runtime itself', () => {
    expect(runtimeProviderAnalytics('dsh')).toMatchObject({ provider_id: null, provider_name: null, api_protocol: null });
    expect(runtimeProviderAnalytics('codex').provider_name).toBe('OpenAI Codex CLI');
    expect(buildTurnProviderAnalytics({ baseUrl: 'invalid' }).provider_base_url).toBeNull();
    expect(buildTurnProviderAnalytics({ apiProtocol: 'openai' }).provider_base_url).toBeNull();
  });
});
