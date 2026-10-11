import { describe, expect, it } from 'vitest';

import { buildPromptCacheKey, promptCacheTarget } from './prompt-cache';

const baseInput = {
  appNamespace: 'myagents' as const,
  providerId: 'fox',
  model: 'gpt-5.5',
  sessionId: 'session-raw-id-123',
  upstreamFormat: 'responses' as const,
};

describe('buildPromptCacheKey', () => {
  it('is stable, bounded, and does not expose raw session/model/provider material', () => {
    const first = buildPromptCacheKey(baseInput);
    const second = buildPromptCacheKey({ ...baseInput });

    expect(first).toBe(second);
    expect(first).toMatch(/^myagents:responses:[a-f0-9]{32}$/);
    expect(first).not.toContain(baseInput.sessionId);
    expect(first).not.toContain(baseInput.providerId);
    expect(first).not.toContain(baseInput.model);
  });

  it('separates Chat Completions and Responses cache namespaces', () => {
    const responsesKey = buildPromptCacheKey(baseInput);
    const chatKey = buildPromptCacheKey({ ...baseInput, upstreamFormat: 'chat_completions' });

    expect(chatKey).toMatch(/^myagents:chat_completions:[a-f0-9]{32}$/);
    expect(chatKey).not.toBe(responsesKey);
  });

  it('separates provider, model, and session affinity', () => {
    const original = buildPromptCacheKey(baseInput);

    expect(buildPromptCacheKey({ ...baseInput, providerId: 'other-provider' })).not.toBe(original);
    expect(buildPromptCacheKey({ ...baseInput, model: 'gpt-other' })).not.toBe(original);
    expect(buildPromptCacheKey({ ...baseInput, sessionId: 'other-session' })).not.toBe(original);
  });

  it('omits the key when there is no active session identity', () => {
    expect(buildPromptCacheKey({ ...baseInput, sessionId: undefined })).toBeUndefined();
    expect(buildPromptCacheKey({ ...baseInput, sessionId: '   ' })).toBeUndefined();
  });
});


describe('prompt-cache observation target (#654)', () => {
  it('isolates every transport dimension and normalizes endpoint trailing slashes', () => {
    const target = promptCacheTarget('p', 'https://example/v1', 'model-a', 'responses');
    expect(promptCacheTarget('p', 'https://example/v1/', 'model-a', 'responses')).toBe(target);
    expect(new Set([target,
      promptCacheTarget('other', 'https://example/v1', 'model-a', 'responses'),
      promptCacheTarget('p', 'https://other/v1', 'model-a', 'responses'),
      promptCacheTarget('p', 'https://example/v1', 'model-b', 'responses'),
      promptCacheTarget('p', 'https://example/v1', 'model-a', 'chat_completions'),
    ]).size).toBe(5);
  });
});
