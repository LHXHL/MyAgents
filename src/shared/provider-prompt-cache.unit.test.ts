import { describe, expect, it } from 'vitest';
import { resolveProviderPromptCacheCapabilities } from './provider-prompt-cache';

describe('target-scoped prompt cache capabilities (#654)', () => {
  it.each(['https://proxy.example/v1', 'http://api.openai.com/v1', 'https://api.openai.com.evil/v1',
    'https://api.openai.com/custom', 'https://api.openai.com/v1?proxy=true', 'invalid'])('keeps unknown endpoint %s unmodified', url => {
    expect(resolveProviderPromptCacheCapabilities(url, 'gpt-5.6')).toEqual({ key: false, breakpoints: false });
  });
  it.each(['gpt-5.5', 'gpt-4.1', 'proxy/gpt-5.6', 'gpt-7', 'unknown'])('does not infer breakpoints for %s', model => {
    expect(resolveProviderPromptCacheCapabilities('https://api.openai.com/v1', model)).toEqual({ key: true, breakpoints: false });
  });
  it.each(['gpt-5.6', 'gpt-5.6-pro', 'gpt-5.6-2026-08-01', 'gpt-6-astra', 'gpt-6.1-sol'])('enables documented breakpoint family %s', model => {
    expect(resolveProviderPromptCacheCapabilities('https://api.openai.com/v1/', model)).toEqual({ key: true, breakpoints: true });
  });
});
