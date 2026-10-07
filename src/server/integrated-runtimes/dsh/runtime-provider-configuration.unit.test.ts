import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESET_PROVIDERS, type Provider } from '../../../shared/config-types';
import type { SessionStartOptions } from '../../runtimes/types';
import { getSessionMetadata } from '../../SessionStore';
import { findEffectiveProvider, findProjectAgentByWorkspacePath, loadConfig, resolveProviderEnv, resolveWorkspaceConfig } from '../../utils/admin-config';
import { prepareProviderBinding } from '../../utils/managed-proxy-binding';
import { compileConfiguration } from './runtime';

vi.mock('../../SessionStore', () => ({ getSessionMetadata: vi.fn() }));
vi.mock('../../utils/admin-config', () => ({
  findEffectiveProvider: vi.fn(),
  findProjectAgentByWorkspacePath: vi.fn(),
  loadConfig: vi.fn(),
  resolveProviderEnv: vi.fn(),
  resolveWorkspaceConfig: vi.fn(),
}));
vi.mock('../../utils/managed-proxy-binding', () => ({
  prepareProviderBinding: vi.fn(),
  getPreparedModelPolicy: vi.fn(),
}));

const options = {
  sessionId: 'session-1',
  workspacePath: '/workspace',
  permissionMode: 'workspace-autonomous',
} as SessionStartOptions;

function preset(id: string): Provider {
  const provider = PRESET_PROVIDERS.find(candidate => candidate.id === id);
  if (!provider) throw new Error(`Missing ${id} preset`);
  return structuredClone(provider);
}

describe('DSH Provider configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadConfig).mockReturnValue({} as ReturnType<typeof loadConfig>);
    vi.mocked(resolveWorkspaceConfig).mockReturnValue({} as ReturnType<typeof resolveWorkspaceConfig>);
  });

  it('uses the carried desktop Provider route before first metadata admission', async () => {
    const provider = preset('zhipu-ai');
    vi.mocked(getSessionMetadata).mockReturnValue(null);
    vi.mocked(findEffectiveProvider).mockReturnValue(provider as unknown as NonNullable<ReturnType<typeof findEffectiveProvider>>);
    vi.mocked(resolveProviderEnv).mockReturnValue({ providerId: provider.id, providerName: provider.name,
      apiProtocol: 'anthropic', authType: 'api_key', apiKey: 'synthetic-key', baseUrl: provider.config.baseUrl });
    const result = await compileConfiguration({ ...options,
      providerRoute: { kind: 'provider', providerId: provider.id, model: 'glm-5.3' },
    } as SessionStartOptions);
    expect(result.profile.modelId).toBe('glm-5.3');
    expect(resolveProviderEnv).toHaveBeenCalledWith(provider.id, expect.anything(), 'glm-5.3');
  });

  it('uses the common owned snapshot resolver for a historical model-only Session', async () => {
    const provider = preset('zhipu-ai');
    const metadata = { model: 'glm-5.3', configSnapshotAt: '2026-10-06T00:00:00Z' } as NonNullable<ReturnType<typeof getSessionMetadata>>;
    vi.mocked(getSessionMetadata).mockReturnValue(metadata);
    vi.mocked(resolveWorkspaceConfig).mockReturnValue({ providerRoute: {
      kind: 'provider', providerId: provider.id, model: 'glm-5.3',
    } } as ReturnType<typeof resolveWorkspaceConfig>);
    vi.mocked(findEffectiveProvider).mockReturnValue(provider as unknown as NonNullable<ReturnType<typeof findEffectiveProvider>>);
    vi.mocked(resolveProviderEnv).mockReturnValue({ providerId: provider.id, providerName: provider.name,
      apiProtocol: 'anthropic', authType: 'api_key', apiKey: 'synthetic-key', baseUrl: provider.config.baseUrl });
    await compileConfiguration(options);
    expect(resolveWorkspaceConfig).toHaveBeenCalledWith('/workspace', metadata, { includeMcp: false });
    expect(resolveProviderEnv).toHaveBeenCalledWith(provider.id, expect.anything(), 'glm-5.3');
  });

  it('does not borrow a changed Agent Provider or a birth option for an unresolved owned Session', async () => {
    vi.mocked(getSessionMetadata).mockReturnValue({ model: 'removed-model', configSnapshotAt: '2026-10-06T00:00:00Z' } as NonNullable<ReturnType<typeof getSessionMetadata>>);
    vi.mocked(findProjectAgentByWorkspacePath).mockReturnValue({ providerId: 'zhipu-ai', model: 'glm-5.3' } as NonNullable<ReturnType<typeof findProjectAgentByWorkspacePath>>);
    await expect(compileConfiguration({ ...options,
      providerRoute: { kind: 'provider', providerId: 'zhipu-ai', model: 'glm-5.3' },
    })).rejects.toThrow('DSH Session has no concrete Provider authority');
    expect(resolveProviderEnv).not.toHaveBeenCalled();
  });

  it.each(['high', 'future-effort'])(
    'uses and reports the model default for an unsupported optional effort: %s', async reasoningEffort => {
      const provider = preset('zhipu-ai');
      vi.mocked(getSessionMetadata).mockReturnValue({
        providerRoute: { kind: 'provider', providerId: provider.id, model: 'glm-5.3' },
      } as ReturnType<typeof getSessionMetadata>);
      vi.mocked(findEffectiveProvider).mockReturnValue(provider as unknown as NonNullable<ReturnType<typeof findEffectiveProvider>>);
      vi.mocked(resolveProviderEnv).mockReturnValue({
        providerId: provider.id, providerName: provider.name, apiProtocol: 'anthropic',
        authType: 'api_key', apiKey: 'synthetic-key', baseUrl: provider.config.baseUrl,
      });
      const result = await compileConfiguration({ ...options, reasoningEffort });
      const baseline = await compileConfiguration(options);
      expect(result.profile).toEqual(baseline.profile);
      expect(result.reasoningEffort).toBe('default');
      expect(result.revision).toBe(baseline.revision);
    },
  );

  it('attributes the official DeepSeek native route using its compiled endpoint', async () => {
    const provider = preset('deepseek');
    vi.mocked(getSessionMetadata).mockReturnValue({
      providerRoute: { kind: 'provider', providerId: provider.id, model: 'deepseek-flash' },
    } as ReturnType<typeof getSessionMetadata>);
    vi.mocked(findEffectiveProvider).mockReturnValue(provider as unknown as NonNullable<ReturnType<typeof findEffectiveProvider>>);
    vi.mocked(resolveProviderEnv).mockReturnValue({
      providerId: provider.id, providerName: provider.name, apiProtocol: 'anthropic',
      authType: 'api_key', apiKey: 'synthetic-key', baseUrl: provider.config.baseUrl,
    });
    const result = await compileConfiguration(options);
    expect(result.profile.providerRouteId).toBe('deepseek-official');
    expect(result.providerAnalytics).toMatchObject({
      provider_id: 'deepseek', provider_name: provider.name,
      api_protocol: 'anthropic', provider_api_family: 'anthropic-messages',
      provider_base_url: result.profile.baseUrl,
    });
    expect(JSON.stringify(result.providerAnalytics)).not.toContain('synthetic-key');
  });

  it('keeps Grok bearer out of the configuration and marks only its exact binding dynamic', async () => {
    const provider = preset('xai-sub');
    vi.mocked(getSessionMetadata).mockReturnValue({
      providerRoute: { kind: 'subscription', providerId: 'xai-sub', model: 'grok-4.5' },
    } as ReturnType<typeof getSessionMetadata>);
    vi.mocked(findEffectiveProvider).mockReturnValue(provider as unknown as NonNullable<ReturnType<typeof findEffectiveProvider>>);
    vi.mocked(resolveProviderEnv).mockReturnValue({
      providerId: 'xai-sub', providerName: 'Grok', apiProtocol: 'openai', authType: 'api_key',
      baseUrl: provider.config.baseUrl,
      credentialSource: { kind: 'managed-oauth', providerId: 'xai-sub' },
    });
    const result = await compileConfiguration(options);
    expect(result.profile).toMatchObject({ provider: 'xai-sub', api: 'openai-responses' });
    expect(result.providerAnalytics).toMatchObject({ provider_id: 'xai-sub', provider_name: provider.name, api_protocol: 'openai', provider_api_family: 'openai-responses', provider_base_url: result.profile.baseUrl });
    expect(result.bindings[0]).toMatchObject({ apiKey: '', managedOauth: true });
    expect(JSON.stringify(result)).not.toContain('bearer');
    expect(prepareProviderBinding).not.toHaveBeenCalled();
  });

  it('uses one Host-owned Antigravity lease for repeated configuration and releases a rejected new lease', async () => {
    const provider = preset('antigravity-sub');
    provider.models = [
      { model: 'model-a', modelName: 'A', modelSeries: 'gemini' },
      { model: 'model-b', modelName: 'B', modelSeries: 'gemini' },
    ];
    vi.mocked(getSessionMetadata).mockReturnValue({
      providerRoute: { kind: 'subscription', providerId: 'antigravity-sub', model: 'model-a' },
    } as ReturnType<typeof getSessionMetadata>);
    vi.mocked(findEffectiveProvider).mockReturnValue(provider as unknown as NonNullable<ReturnType<typeof findEffectiveProvider>>);
    vi.mocked(resolveProviderEnv).mockReturnValue({
      providerId: 'antigravity-sub', providerName: 'Antigravity', apiProtocol: 'anthropic',
      authType: 'api_key', endpointSource: { kind: 'cliproxy', providerId: 'antigravity-sub' },
    });
    const released = vi.fn().mockResolvedValue(undefined);
    vi.mocked(prepareProviderBinding).mockImplementation(async ({ model }) => ({
      providerEnv: { providerId: 'antigravity-sub', providerName: 'Antigravity',
        apiProtocol: 'anthropic', authType: 'api_key', apiKey: `key-${model}`,
        baseUrl: `http://127.0.0.1:${model === 'model-a' ? 40123 : 40124}` },
      beforeTurn: async () => {}, reportTerminal: async () => {}, release: released,
    }));
    const first = await compileConfiguration(options);
    expect(first.profile.baseUrl).toBe('http://127.0.0.1:40123');
    expect(first.providerAnalytics).toMatchObject({ provider_id: 'antigravity-sub', provider_name: provider.name, api_protocol: 'anthropic', provider_base_url: first.profile.baseUrl });
    expect(JSON.stringify(first.providerAnalytics)).not.toContain('key-model-a');
    expect(first.bindings[0].apiKey).toBe('key-model-a');
    const unchanged = await compileConfiguration(options, undefined, first);
    expect(unchanged.preparedProvider).toBe(first.preparedProvider);
    expect(prepareProviderBinding).toHaveBeenCalledTimes(1);
    const changed = await compileConfiguration(options, { model: 'model-b' }, first);
    expect(changed.profile.baseUrl).toBe('http://127.0.0.1:40124');
    expect(prepareProviderBinding).toHaveBeenCalledTimes(2);

    vi.mocked(loadConfig).mockReturnValue({ dshCollaboration: { modelPolicy: 'invalid' } } as ReturnType<typeof loadConfig>);
    await expect(compileConfiguration(options, { model: 'model-b' }, first)).rejects.toThrow(/model strategy/);
    expect(released).toHaveBeenCalledTimes(1);
  });
});
