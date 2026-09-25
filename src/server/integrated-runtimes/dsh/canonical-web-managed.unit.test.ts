import { describe, expect, it, vi } from 'vitest';
import { DshCanonicalWebHost } from './canonical-web';
import { resolveDshProviderApiKey } from './provider-credential';
import type { DshModelExecutionProfile } from './profile-compiler';

vi.mock('./provider-credential', () => ({ resolveDshProviderApiKey: vi.fn() }));

describe('DSH Host Web with managed Provider credentials', () => {
  it('resolves the primary Grok binding at the Web tool request boundary', async () => {
    const profile = {
      revision: 'grok-profile', providerRouteId: 'myagents-xai-sub-openai-responses',
      provider: 'xai-sub', api: 'openai-responses', modelId: 'grok-4.5',
    } as DshModelExecutionProfile;
    const binding = { profile, apiKey: '', authType: 'api_key' as const, managedOauth: true as const };
    const signal = new AbortController().signal;
    vi.mocked(resolveDshProviderApiKey).mockResolvedValue('current-bearer');
    const runSearch = vi.fn(async () => ({ query: 'test', results: [], citations: [],
      truncated: false, searchCount: 0, durationMs: 1 }));
    const host = new DshCanonicalWebHost({
      activeConfiguration: () => ({ ...binding, bindings: [binding], revision: 'config-v1' }),
      runtimeSessionId: () => 'runtime-session-1',
      provider: { runSearch, runUtility: vi.fn() },
    });
    try {
      const result = await host.execute({
        tool: 'WebSearch', input: { query: 'test' },
        authority: {
          runtimeGeneration: 'generation-1', runtimeSessionId: 'runtime-session-1',
          clientOperationId: 'operation-1', turnId: 'turn-1', dshTurn: 1,
          rootCallId: 'root-1', callId: 'call-1',
          componentGenerationId: 'myagents-host-canonical-web-v1',
          componentId: 'canonical-web-search', expectedConfigRevision: 'config-v1',
        },
      }, { requestId: 'request-1', signal, commit: vi.fn(), afterResponse: vi.fn() });
      expect(result.state).toBe('succeeded');
      expect(resolveDshProviderApiKey).toHaveBeenCalledWith(
        expect.objectContaining({ profile, apiKey: '', managedOauth: true }), signal,
      );
      expect(runSearch).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'current-bearer' }));
    } finally {
      await host.close();
    }
  });

  it('reports an unavailable managed credential as a Provider failure', async () => {
    const profile = { revision: 'grok-profile', providerRouteId: 'myagents-xai-sub-openai-responses',
      provider: 'xai-sub', api: 'openai-responses', modelId: 'grok-4.5' } as DshModelExecutionProfile;
    vi.mocked(resolveDshProviderApiKey).mockRejectedValue(new Error('secret-bearing upstream error'));
    const host = new DshCanonicalWebHost({
      activeConfiguration: () => ({ profile, apiKey: '', authType: 'api_key', managedOauth: true,
        revision: 'config-v1' }),
      runtimeSessionId: () => 'runtime-session-1',
      provider: { runSearch: vi.fn(), runUtility: vi.fn() },
    });
    try {
      const result = await host.execute({
        tool: 'WebSearch', input: { query: 'test' },
        authority: {
          runtimeGeneration: 'generation-1', runtimeSessionId: 'runtime-session-1',
          clientOperationId: 'operation-1', turnId: 'turn-1', dshTurn: 1,
          rootCallId: 'root-1', callId: 'call-1',
          componentGenerationId: 'myagents-host-canonical-web-v1',
          componentId: 'canonical-web-search', expectedConfigRevision: 'config-v1',
        },
      }, { requestId: 'request-1', signal: new AbortController().signal,
        commit: vi.fn(), afterResponse: vi.fn() });
      expect(result).toMatchObject({ state: 'failed', code: 'provider_search_failed' });
      expect(JSON.stringify(result)).not.toContain('secret-bearing');
    } finally {
      await host.close();
    }
  });
});
