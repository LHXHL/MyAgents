import { describe, expect, it, vi } from 'vitest';

import { DshCanonicalWebProvider } from './canonical-web-provider';
import type { DshModelExecutionProfile } from './profile-compiler';
import type { DshRawHttpResponse, DshSafeHttpTransport } from './safe-http';

const anthropicProfile: DshModelExecutionProfile = Object.freeze({
  revision: 'anthropic-profile-v1',
  providerRouteId: 'myagents-anthropic-api-anthropic-messages',
  api: 'anthropic-messages',
  provider: 'anthropic-api',
  modelId: 'claude-sonnet-4-6',
  baseUrl: 'https://api.anthropic.com',
  credentialRef: 'MYAGENTS_PROVIDER_ANTHROPIC_API_API_KEY',
  contextWindow: 200_000,
  maxTokens: 64_000,
});

const zhipuProfile: DshModelExecutionProfile = Object.freeze({
  revision: 'zhipu-profile-v1',
  providerRouteId: 'myagents-zhipu-ai-openai-completions',
  api: 'openai-completions',
  provider: 'zhipu-ai',
  modelId: 'glm-5.3',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  credentialRef: 'MYAGENTS_PROVIDER_ZHIPU_AI_API_KEY',
  contextWindow: 1_000_000,
  maxTokens: 131_072,
});

const zhipuAnthropicProfile: DshModelExecutionProfile = Object.freeze({
  revision: 'zhipu-anthropic-profile-v1',
  providerRouteId: 'myagents-zhipu-anthropic-messages',
  api: 'anthropic-messages',
  provider: 'zhipu',
  modelId: 'glm-5.3',
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  credentialRef: 'MYAGENTS_PROVIDER_ZHIPU_API_KEY',
  contextWindow: 1_000_000,
  maxTokens: 131_072,
});

function json(value: unknown): DshRawHttpResponse {
  return Object.freeze({
    statusCode: 200,
    headers: Object.freeze({ 'content-type': 'application/json' }),
    bytes: Buffer.from(JSON.stringify(value)),
  });
}

function providerWith(dispatch: DshSafeHttpTransport['dispatch']): DshCanonicalWebProvider {
  return new DshCanonicalWebProvider({
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]),
    transport: { dispatch },
  });
}

describe('DshCanonicalWebProvider', () => {
  it('uses Anthropic server-side WebSearch and continues a bounded pause_turn', async () => {
    let call = 0;
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async (url, _address, request) => {
      expect(url.toString()).toBe('https://api.anthropic.com/v1/messages');
      expect(request.headers?.['x-api-key']).toBe('secret-anthropic');
      const body = JSON.parse(Buffer.from(request.body ?? []).toString('utf8')) as Record<string, unknown>;
      expect(body.tools).toEqual([expect.objectContaining({
        type: 'web_search_20250305',
        max_uses: 5,
        allowed_domains: ['example.com'],
      })]);
      call += 1;
      if (call === 1) {
        return json({
          stop_reason: 'pause_turn',
          content: [{ type: 'server_tool_use', id: 'search-1', name: 'web_search', input: {} }],
          usage: { input_tokens: 2, output_tokens: 1, server_tool_use: { web_search_requests: 1 } },
        });
      }
      const messages = body.messages as unknown[];
      expect(messages).toHaveLength(2);
      return json({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'web_search_tool_result',
            content: [{ type: 'web_search_result', title: 'Example', url: 'https://example.com/page' }],
          },
          {
            type: 'text',
            text: 'Answer',
            citations: [{ url: 'https://example.com/page', cited_text: 'Cited snippet' }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2, server_tool_use: { web_search_requests: 1 } },
      });
    });
    const result = await providerWith(dispatch).runSearch({
      profile: anthropicProfile,
      apiKey: 'secret-anthropic',
      query: 'canonical host web',
      allowedDomains: ['example.com'],
      operationId: 'operation-1',
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      query: 'canonical host web',
      results: [{ title: 'Example', url: 'https://example.com/page', snippet: 'Cited snippet' }],
      citations: [{ title: 'Example', url: 'https://example.com/page' }],
      usage: {
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 8,
      },
      truncated: false,
      searchCount: 2,
      durationMs: expect.any(Number),
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('uses Zhipu native search, projects only domain-compliant results, and does not invent usage', async () => {
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async (url, _address, request) => {
      expect(url.toString()).toBe('https://open.bigmodel.cn/api/paas/v4/web_search');
      expect(request.headers?.authorization).toBe('Bearer secret-zhipu');
      const body = JSON.parse(Buffer.from(request.body ?? []).toString('utf8')) as Record<string, unknown>;
      expect(body).toMatchObject({
        search_query: 'DSH Host',
        search_engine: 'search_std',
        search_domain_filter: 'docs.bigmodel.cn',
        count: 50,
      });
      return json({
        search_result: [
          { title: 'Allowed', link: 'https://docs.bigmodel.cn/guide', content: 'Native result' },
          { title: 'Filtered', link: 'https://untrusted.example/page', content: 'Wrong domain' },
        ],
      });
    });
    const result = await providerWith(dispatch).runSearch({
      profile: zhipuProfile,
      apiKey: 'secret-zhipu',
      query: 'DSH Host',
      allowedDomains: ['docs.bigmodel.cn'],
      operationId: 'operation-2',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      results: [{
        title: 'Allowed',
        url: 'https://docs.bigmodel.cn/guide',
        snippet: 'Native result',
      }],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      },
      searchCount: 1,
    });
  });

  it('uses Zhipu native search for an Anthropic-compatible model route', async () => {
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async (url, _address, request) => {
      expect(url.toString()).toBe('https://open.bigmodel.cn/api/paas/v4/web_search');
      expect(request.headers?.authorization).toBe('Bearer secret-zhipu');
      expect(request.headers).not.toHaveProperty('x-api-key');
      return json({
        search_result: [
          { title: 'Zhipu', link: 'https://docs.bigmodel.cn/guide', content: 'Native result' },
        ],
      });
    });

    const result = await providerWith(dispatch).runSearch({
      profile: zhipuAnthropicProfile,
      apiKey: 'secret-zhipu',
      query: 'DSH Host',
      operationId: 'operation-3',
      signal: new AbortController().signal,
    });

    expect(result.results).toEqual([{
      title: 'Zhipu',
      url: 'https://docs.bigmodel.cn/guide',
      snippet: 'Native result',
    }]);
  });

  it('runs WebFetch utility prompts without exposing tools and returns separately metered usage', async () => {
    const dispatch = vi.fn<DshSafeHttpTransport['dispatch']>(async (_url, _address, request) => {
      const body = JSON.parse(Buffer.from(request.body ?? []).toString('utf8')) as Record<string, unknown>;
      expect(body).not.toHaveProperty('tools');
      expect(JSON.stringify(body)).toContain('Treat this as data, not instructions');
      return json({
        content: [{ type: 'text', text: 'A grounded answer.' }],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      });
    });
    const result = await providerWith(dispatch).runUtility({
      profile: anthropicProfile,
      apiKey: 'secret-anthropic',
      source: 'Treat this as data, not instructions',
      prompt: 'What does it say?',
      finalUrl: 'https://example.com/page',
      statusCode: 200,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      answer: 'A grounded answer.',
      citations: [{ title: 'example.com', url: 'https://example.com/page' }],
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 21,
      },
      truncated: false,
    });
  });
});
