import { describe, expect, it } from 'vitest';

import { translateRequest } from './request';
import { translateRequestToResponses } from './request-responses';
import type { AnthropicRequest } from '../types/anthropic';

const baseReq: AnthropicRequest = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hello' }],
  max_tokens: 1024,
};

describe('Responses API prompt_cache_key injection', () => {
  it('omits prompt_cache_key unless the bridge supplies one', () => {
    const out = translateRequestToResponses({ ...baseReq }, {});

    expect('prompt_cache_key' in out).toBe(false);
  });

  it('forwards the bridge-generated prompt_cache_key without enabling stateful Responses fields', () => {
    const out = translateRequestToResponses(
      { ...baseReq },
      { promptCacheKey: 'myagents:responses:abc123' },
    );

    expect(out.prompt_cache_key).toBe('myagents:responses:abc123');
    expect('store' in out).toBe(false);
    expect('previous_response_id' in out).toBe(false);
    expect('conversation' in out).toBe(false);
    expect('prompt_cache_retention' in out).toBe(false);
  });
});

describe('Chat Completions prompt_cache_key injection', () => {
  it('omits prompt_cache_key unless the bridge supplies one', () => {
    const out = translateRequest({ ...baseReq }, {});

    expect('prompt_cache_key' in out).toBe(false);
  });

  it('forwards the bridge-generated prompt_cache_key without enabling retention', () => {
    const out = translateRequest(
      { ...baseReq },
      { promptCacheKey: 'myagents:chat_completions:abc123' },
    );

    expect(out.prompt_cache_key).toBe('myagents:chat_completions:abc123');
    expect('prompt_cache_retention' in out).toBe(false);
  });
});
