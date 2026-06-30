import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS,
  DEFAULT_CONFIG,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  MANAGED_CODEX_PROVIDER,
  MANAGED_CODEX_REQUIRED_RUNTIME,
  PRESET_PROVIDERS,
  SUBSCRIPTION_PROVIDER_ID,
  applyManagedCodexProviderReadiness,
  getManagedCodexProviderReadiness,
  isManagedCodexRequiredRuntimeInstalled,
  isManagedCodexProviderGateEnabled,
  isManagedCodexSubscriptionAuthValid,
  mergePresetModelWithCustomEntry,
  normalizeChatQueueResponseMode,
  normalizeClaudeTranscriptCleanupPeriodDays,
  normalizeProviderOrder,
  splitProviderModelInput,
  withManagedCodexRuntimeModels,
  withManagedCodexProviderCatalog,
} from './config-types';

// normalizeProviderOrder reconciles a persisted provider order against the set
// of providers that actually exist now: honor the saved order, drop stale/
// unknown ids, dedupe, then append any known providers the order didn't mention
// (newly added). Drift here scrambles or drops providers from the picker.
describe('normalizeProviderOrder', () => {
  it('honors the saved order, then appends known providers missing from it', () => {
    expect(normalizeProviderOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'a', 'b']);
  });

  it('places newly introduced Codex subscription after Anthropic subscription when the saved order is missing it', () => {
    expect(normalizeProviderOrder(
      [SUBSCRIPTION_PROVIDER_ID, CODEX_SUBSCRIPTION_PROVIDER_ID, 'anthropic-api', 'deepseek'],
      [SUBSCRIPTION_PROVIDER_ID, 'anthropic-api', 'deepseek'],
    )).toEqual([
      SUBSCRIPTION_PROVIDER_ID,
      CODEX_SUBSCRIPTION_PROVIDER_ID,
      'anthropic-api',
      'deepseek',
    ]);
  });

  it('honors an explicit saved Codex subscription position', () => {
    expect(normalizeProviderOrder(
      [SUBSCRIPTION_PROVIDER_ID, CODEX_SUBSCRIPTION_PROVIDER_ID, 'anthropic-api', 'deepseek'],
      ['deepseek', CODEX_SUBSCRIPTION_PROVIDER_ID, SUBSCRIPTION_PROVIDER_ID],
    )).toEqual([
      'deepseek',
      CODEX_SUBSCRIPTION_PROVIDER_ID,
      SUBSCRIPTION_PROVIDER_ID,
      'anthropic-api',
    ]);
  });

  it('drops ids in the order that are no longer known', () => {
    expect(normalizeProviderOrder(['a', 'b'], ['stale', 'a'])).toEqual(['a', 'b']);
  });

  it('dedupes repeated ids in the saved order', () => {
    expect(normalizeProviderOrder(['a', 'b'], ['a', 'a', 'b', 'b'])).toEqual(['a', 'b']);
  });

  it('falls back to the known order when no saved order is given', () => {
    expect(normalizeProviderOrder(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(normalizeProviderOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('returns empty for no known providers', () => {
    expect(normalizeProviderOrder([], ['a', 'b'])).toEqual([]);
  });
});

describe('mergePresetModelWithCustomEntry', () => {
  const preset = {
    model: 'claude-fable-5',
    modelName: 'Claude Fable 5',
    modelSeries: 'claude',
    contextLength: 200_000,
    inputModalities: ['text'],
    source: 'preset' as const,
  };

  it('lets manual custom entries override bundled preset fields', () => {
    expect(mergePresetModelWithCustomEntry(preset, {
      model: 'claude-fable-5',
      modelName: 'Fable via proxy',
      modelSeries: 'claude',
      contextLength: 1_000_000,
      inputModalities: ['text', 'image'],
      source: 'manual',
    })).toMatchObject({
      modelName: 'Fable via proxy',
      contextLength: 1_000_000,
      inputModalities: ['text', 'image'],
    });
  });

  it('treats legacy source-less custom entries as user-authored overrides', () => {
    expect(mergePresetModelWithCustomEntry(preset, {
      model: 'claude-fable-5',
      modelName: 'Legacy override',
      modelSeries: 'claude',
      contextLength: 512_000,
    })).toMatchObject({
      modelName: 'Legacy override',
      contextLength: 512_000,
    });
  });

  it('uses discovered entries only to fill fields missing from the preset', () => {
    expect(mergePresetModelWithCustomEntry(preset, {
      model: 'claude-fable-5',
      modelName: 'Discovered name',
      modelSeries: 'claude',
      contextLength: 1_000_000,
      inputModalities: ['text', 'image'],
      source: 'discovered',
    })).toMatchObject({
      modelName: 'Claude Fable 5',
      contextLength: 200_000,
      inputModalities: ['text'],
    });
  });

  it('fills discovered metadata when the bundled preset leaves a field empty', () => {
    expect(mergePresetModelWithCustomEntry(
      { ...preset, contextLength: undefined, inputModalities: undefined },
      {
        model: 'claude-fable-5',
        modelName: 'Discovered name',
        modelSeries: 'claude',
        contextLength: 1_000_000,
        inputModalities: ['text', 'image'],
        source: 'discovered',
      },
    )).toMatchObject({
      modelName: 'Claude Fable 5',
      contextLength: 1_000_000,
      inputModalities: ['text', 'image'],
    });
  });
});

describe('splitProviderModelInput', () => {
  it('preserves a single model id when no comma separator is present', () => {
    expect(splitProviderModelInput(' sensenova-6.7-flash-lite ')).toEqual(['sensenova-6.7-flash-lite']);
  });

  it('splits ASCII and Chinese comma-separated model ids and trims whitespace', () => {
    expect(splitProviderModelInput('m1, m2， m3')).toEqual(['m1', 'm2', 'm3']);
  });

  it('drops empty segments created by extra separators', () => {
    expect(splitProviderModelInput(' m1, ,，m2，')).toEqual(['m1', 'm2']);
  });
});

describe('normalizeClaudeTranscriptCleanupPeriodDays', () => {
  it('uses a one-year default for missing or invalid values', () => {
    expect(DEFAULT_CONFIG.claudeTranscriptCleanupPeriodDays).toBe(DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS);
    expect(DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS).toBe(365);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(undefined)).toBe(365);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(Number.NaN)).toBe(365);
    expect(normalizeClaudeTranscriptCleanupPeriodDays('bad')).toBe(365);
  });

  it('passes a positive integer day count to the SDK settings layer', () => {
    expect(normalizeClaudeTranscriptCleanupPeriodDays(30)).toBe(30);
    expect(normalizeClaudeTranscriptCleanupPeriodDays('180')).toBe(180);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(30.9)).toBe(30);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(0)).toBe(1);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(-12)).toBe(1);
  });
});

describe('normalizeChatQueueResponseMode', () => {
  it('defaults to realtime and accepts only the turn override', () => {
    expect(DEFAULT_CONFIG.chatQueueResponseMode).toBe('realtime');
    expect(normalizeChatQueueResponseMode(undefined)).toBe('realtime');
    expect(normalizeChatQueueResponseMode('realtime')).toBe('realtime');
    expect(normalizeChatQueueResponseMode('turn')).toBe('turn');
    expect(normalizeChatQueueResponseMode('invalid')).toBe('realtime');
  });
});

describe('Zhipu preset models', () => {
  it('ships GLM-5.2 in both Coding Plan and API presets with official 1M window metadata', () => {
    for (const providerId of ['zhipu', 'zhipu-ai']) {
      const provider = PRESET_PROVIDERS.find(p => p.id === providerId);
      const model = provider?.models.find(m => m.model === 'glm-5.2');

      expect(model).toMatchObject({
        modelName: 'GLM 5.2',
        modelSeries: 'zhipu',
        contextLength: 1_000_000,
        maxOutputTokens: 131_072,
        inputModalities: ['text'],
      });
      expect(provider?.modelAliases).toEqual({
        opus: 'glm-5.2',
        sonnet: 'glm-5.1',
        haiku: 'glm-5.1',
      });
    }
  });
});

describe('desktop pet defaults', () => {
  it('keeps hover peek enabled for existing desktop pet behavior', () => {
    expect(DEFAULT_CONFIG.floatingBallHoverPeekEnabled).toBe(true);
  });
});

describe('CLI tool registry defaults', () => {
  it('keeps the experimental registry off by default', () => {
    expect(DEFAULT_CONFIG.cliToolRegistryEnabled).toBe(false);
  });
});

describe('Managed Codex provider readiness', () => {
  function readManagedCodexRustConst(name: string): string {
    const source = readFileSync('src-tauri/src/managed_codex.rs', 'utf8');
    const match = source.match(new RegExp(`^const ${name}:.*= "([^"]+)";`, 'm'));
    if (!match) throw new Error(`Missing Rust Managed Codex constant: ${name}`);
    return match[1];
  }

  it('keeps the shared runtime lock aligned with the Rust downloader lock', () => {
    expect(MANAGED_CODEX_REQUIRED_RUNTIME.version).toBe(readManagedCodexRustConst('REQUIRED_VERSION'));
    expect(MANAGED_CODEX_REQUIRED_RUNTIME.runtimeSet).toBe(readManagedCodexRustConst('REQUIRED_RUNTIME_SET'));
    expect(MANAGED_CODEX_REQUIRED_RUNTIME.manifestBaseUrl).toBe(
      `${readManagedCodexRustConst('RUNTIME_SETS_BASE_URL')}/${readManagedCodexRustConst('REQUIRED_RUNTIME_SET')}`,
    );
  });

  it('defaults the developer gate on but still honors explicit disablement', () => {
    expect(DEFAULT_CONFIG.managedCodexProviderDevGate).toBe(true);
    expect(isManagedCodexProviderGateEnabled({})).toBe(false);
    expect(isManagedCodexProviderGateEnabled({ managedCodexProviderDevGate: true })).toBe(true);
    expect(isManagedCodexProviderGateEnabled({ managedCodexProviderDevGate: false })).toBe(false);
  });

  it('keeps the provider out of the catalogue while the developer gate is explicitly off', () => {
    expect(withManagedCodexProviderCatalog([MANAGED_CODEX_PROVIDER], {
      managedCodexProviderDevGate: false,
    }).some(provider => provider.id === CODEX_SUBSCRIPTION_PROVIDER_ID)).toBe(false);
  });

  it('inserts the provider after Anthropic subscription in the default catalogue', () => {
    const catalog = withManagedCodexProviderCatalog(PRESET_PROVIDERS, DEFAULT_CONFIG);

    expect(catalog.slice(0, 3).map(provider => provider.id)).toEqual([
      SUBSCRIPTION_PROVIDER_ID,
      CODEX_SUBSCRIPTION_PROVIDER_ID,
      'anthropic-api',
    ]);
  });

  it('shows the provider card by default but keeps it unselectable until ready', () => {
    const catalog = withManagedCodexProviderCatalog([], DEFAULT_CONFIG);
    const providers = applyManagedCodexProviderReadiness(catalog, DEFAULT_CONFIG);

    expect(catalog.map(provider => provider.id)).toEqual([CODEX_SUBSCRIPTION_PROVIDER_ID]);
    expect(providers[0].enabled).toBeUndefined();
    expect(providers[0].runtimeReady).toBe(false);
    expect(getManagedCodexProviderReadiness(DEFAULT_CONFIG).reason).toBe('runtime-not-installed');
  });

  it('derives Codex subscription models from the managed runtime model list', () => {
    const provider = withManagedCodexRuntimeModels(MANAGED_CODEX_PROVIDER, [
      { value: 'gpt-5.1', displayName: 'GPT-5.1' },
      { value: 'gpt-5', displayName: 'GPT-5', isDefault: true },
      { value: '', displayName: '默认', isDefault: true },
      { value: 'gpt-5', displayName: 'duplicate' },
    ]);

    expect(MANAGED_CODEX_PROVIDER.models).toEqual([]);
    expect(provider.primaryModel).toBe('gpt-5');
    expect(provider.models.map(model => model.model)).toEqual(['gpt-5.1', 'gpt-5']);
    expect(provider.models[0]).toMatchObject({
      modelName: 'GPT-5.1',
      modelSeries: 'codex',
      source: 'discovered',
    });
  });

  it('requires exact runtime version, subscription auth, and no explicit disablement', () => {
    const runtime = {
      status: 'installed' as const,
      installedVersion: MANAGED_CODEX_REQUIRED_RUNTIME.version,
      requiredVersion: MANAGED_CODEX_REQUIRED_RUNTIME.version,
    };
    const auth = {
      status: 'valid' as const,
      authMethod: 'chatgpt' as const,
    };

    expect(isManagedCodexRequiredRuntimeInstalled(runtime)).toBe(true);
    expect(isManagedCodexSubscriptionAuthValid(auth)).toBe(true);
    expect(getManagedCodexProviderReadiness({
      managedCodexProviderDevGate: true,
      managedCodexRuntimeInstall: runtime,
      managedCodexAuth: auth,
    })).toMatchObject({
      visible: true,
      selectable: true,
      reason: 'ready',
    });
  });

  it('does not treat Codex API-key auth as subscription readiness', () => {
    expect(isManagedCodexSubscriptionAuthValid({
      status: 'valid',
      authMethod: 'api-key',
    })).toBe(false);
  });

  it('preserves explicit provider disablement even after readiness succeeds', () => {
    const providers = applyManagedCodexProviderReadiness([
      { ...MANAGED_CODEX_PROVIDER, enabled: false },
    ], {
      managedCodexProviderDevGate: true,
      disabledProviderIds: [CODEX_SUBSCRIPTION_PROVIDER_ID],
      managedCodexRuntimeInstall: {
        status: 'installed',
        installedVersion: MANAGED_CODEX_REQUIRED_RUNTIME.version,
      },
      managedCodexAuth: {
        status: 'valid',
        authMethod: 'chatgpt',
      },
    });

    expect(providers[0].enabled).toBe(false);
    expect(providers[0].runtimeReady).toBe(true);
  });
});
