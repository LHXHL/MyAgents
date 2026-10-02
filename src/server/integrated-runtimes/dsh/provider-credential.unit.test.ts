import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveManagedOAuthCredential } from '../../utils/management-api-client';
import type { DshHostModelBinding } from './collaboration-compiler';
import { resolveDshProviderApiKey } from './provider-credential';

vi.mock('../../utils/management-api-client', () => ({
  resolveManagedOAuthCredential: vi.fn(),
}));

function binding(provider: string, apiKey: string, managedOauth = false): DshHostModelBinding {
  return {
    profile: { provider } as DshHostModelBinding['profile'],
    apiKey,
    authType: 'api_key',
    ...(managedOauth ? { managedOauth: true } : {}),
  };
}

describe('DSH Host Provider credential resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the configured key only for a static binding', async () => {
    const signal = new AbortController().signal;
    await expect(resolveDshProviderApiKey(binding('deepseek', 'static-key'), signal)).resolves.toBe('static-key');
    expect(resolveManagedOAuthCredential).not.toHaveBeenCalled();
  });

  it('asks the existing Rust owner for Grok bearer on each model request', async () => {
    const signal = new AbortController().signal;
    vi.mocked(resolveManagedOAuthCredential)
      .mockResolvedValueOnce({ accessToken: 'current-token', credentialVersion: 1 })
      .mockResolvedValueOnce({ accessToken: 'refreshed-token', credentialVersion: 2 });
    const selected = binding('xai-sub', '', true);
    await expect(resolveDshProviderApiKey(selected, signal)).resolves.toBe('current-token');
    await expect(resolveDshProviderApiKey(selected, signal)).resolves.toBe('refreshed-token');
    expect(resolveManagedOAuthCredential).toHaveBeenCalledTimes(2);
    expect(resolveManagedOAuthCredential).toHaveBeenCalledWith('xai-sub', { reason: 'request' }, signal);
  });

  it('rejects a forged managed binding and absent credential', async () => {
    const signal = new AbortController().signal;
    await expect(resolveDshProviderApiKey(binding('other', '', true), signal))
      .rejects.toThrow(/invalid owner/);
    await expect(resolveDshProviderApiKey(binding('xai-sub', 'unexpected-key', true), signal))
      .rejects.toThrow(/invalid owner/);
    await expect(resolveDshProviderApiKey(binding('deepseek', ''), signal))
      .rejects.toThrow(/unavailable/);
    expect(resolveManagedOAuthCredential).not.toHaveBeenCalled();
  });
});
