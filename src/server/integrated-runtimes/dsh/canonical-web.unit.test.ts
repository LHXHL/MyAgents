import { describe, expect, it, vi } from 'vitest';

import { DshCanonicalWebHost } from './canonical-web';
import { DshCanonicalWebError } from './canonical-web-errors';
import type { DshCanonicalWebProviderPort } from './canonical-web-provider';
import type { DshModelExecutionProfile } from './profile-compiler';
import type { DshRequestContext, DshRpcObject } from './protocol-types';

const profile: DshModelExecutionProfile = Object.freeze({
  revision: 'profile-v1',
  providerRouteId: 'myagents-anthropic-api-anthropic-messages',
  api: 'anthropic-messages',
  provider: 'anthropic-api',
  modelId: 'claude-sonnet-4-6',
  baseUrl: 'https://api.anthropic.com',
  credentialRef: 'MYAGENTS_PROVIDER_ANTHROPIC_API_API_KEY',
  contextWindow: 200_000,
  maxTokens: 64_000,
});

const usage = Object.freeze({
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 15,
});

function context(signal = new AbortController().signal): DshRequestContext {
  return {
    requestId: 'reverse-1',
    signal,
    commit: vi.fn(),
    afterResponse: vi.fn(),
  };
}

function authority(tool: 'WebFetch' | 'WebSearch'): DshRpcObject {
  return {
    runtimeGeneration: 'generation-1',
    runtimeSessionId: 'runtime-session-1',
    clientOperationId: 'operation-1',
    turnId: 'turn-1',
    dshTurn: 1,
    rootCallId: 'root-call-1',
    callId: 'call-1',
    componentGenerationId: 'myagents-host-canonical-web-v1',
    componentId: tool === 'WebFetch' ? 'canonical-web-fetch' : 'canonical-web-search',
    expectedConfigRevision: 'config-v1',
  };
}

function provider(): DshCanonicalWebProviderPort & Readonly<{
  runSearch: ReturnType<typeof vi.fn>;
  runUtility: ReturnType<typeof vi.fn>;
}> {
  return {
    runSearch: vi.fn(async ({ query }) => ({
      query,
      results: [{ title: 'Result', url: 'https://result.example/', snippet: 'Snippet' }],
      citations: [{ title: 'Result', url: 'https://result.example/' }],
      usage,
      truncated: false,
      searchCount: 1,
      durationMs: 2,
    })),
    runUtility: vi.fn(async () => ({
      answer: 'Canonical answer',
      citations: [{ title: 'example.com', url: 'https://example.com/final' }],
      usage,
      truncated: false,
    })),
  };
}

function host(webProvider = provider()): DshCanonicalWebHost {
  return new DshCanonicalWebHost({
    activeConfiguration: () => ({
      profile,
      apiKey: 'secret',
      authType: 'api_key',
      revision: 'config-v1',
    }),
    runtimeSessionId: () => 'runtime-session-1',
    provider: webProvider,
    contentHttp: {
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]),
      transport: {
        dispatch: vi.fn(async () => ({
          statusCode: 200,
          headers: { 'content-type': 'text/html' },
          bytes: Buffer.from('<html><body><h1>Hello</h1><script>ignore()</script><p>World</p></body></html>'),
        })),
      },
    },
  });
}

describe('DshCanonicalWebHost', () => {
  it('retains the retrieval query but returns query-free page provenance', async () => {
    const webProvider = provider();
    const result = await host(webProvider).execute({
      tool: 'WebFetch',
      input: { url: 'https://example.com/final?synthetic=value#section', prompt: 'Summarize it' },
      authority: authority('WebFetch'),
    }, context());
    expect(result).toMatchObject({ state: 'succeeded', structured: {
      url: 'https://example.com/final?synthetic=value#section',
      finalUrl: 'https://example.com/final', citations: [{ url: 'https://example.com/final' }],
    } });
    expect(webProvider.runUtility).toHaveBeenCalledWith(expect.objectContaining({ finalUrl: 'https://example.com/final' }));
  });

  it('converts fetched HTML and returns the exact structured WebFetch result', async () => {
    const webProvider = provider();
    const result = await host(webProvider).execute({
      tool: 'WebFetch',
      input: { url: 'https://example.com/final', prompt: 'Summarize it' },
      authority: authority('WebFetch'),
    }, context());

    expect(result).toEqual({
      state: 'succeeded',
      structured: {
        url: 'https://example.com/final',
        finalUrl: 'https://example.com/final',
        answer: 'Canonical answer',
        citations: [{ title: 'example.com', url: 'https://example.com/final' }],
        usage,
        truncated: false,
      },
    });
    expect(webProvider.runUtility).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'secret',
      authType: 'api_key',
      prompt: 'Summarize it',
      source: '# Hello\n\nWorld',
    }));
  });

  it('dispatches canonical WebSearch with the frozen Provider and operation identity', async () => {
    const webProvider = provider();
    const result = await host(webProvider).execute({
      tool: 'WebSearch',
      input: { query: 'DSH integration', allowed_domains: ['example.com'] },
      authority: authority('WebSearch'),
    }, context());

    expect(result).toMatchObject({
      state: 'succeeded',
      structured: { query: 'DSH integration', searchCount: 1 },
    });
    expect(webProvider.runSearch).toHaveBeenCalledWith(expect.objectContaining({
      profile,
      apiKey: 'secret',
      authType: 'api_key',
      allowedDomains: ['example.com'],
      operationId: 'operation-1:call-1',
    }));
  });

  it('fails closed before network execution when reverse authority is stale', async () => {
    const webProvider = provider();
    const result = await host(webProvider).execute({
      tool: 'WebSearch',
      input: { query: 'stale call' },
      authority: { ...authority('WebSearch'), expectedConfigRevision: 'old-config' },
    }, context());

    expect(result).toEqual({ state: 'failed', code: 'host_tool_authority_mismatch' });
    expect(webProvider.runSearch).not.toHaveBeenCalled();
  });

  it('returns an actionable bounded failure message to the Runtime', async () => {
    const webProvider = provider();
    webProvider.runSearch.mockRejectedValueOnce(new DshCanonicalWebError(
      'provider_search_failed',
      'Zhipu WebSearch has no available search resource package or balance',
    ));

    await expect(host(webProvider).execute({
      tool: 'WebSearch',
      input: { query: 'quota check' },
      authority: authority('WebSearch'),
    }, context())).resolves.toEqual({
      state: 'failed',
      code: 'provider_search_failed',
      content: [{
        type: 'text',
        text: 'Zhipu WebSearch has no available search resource package or balance',
      }],
    });
  });
});
