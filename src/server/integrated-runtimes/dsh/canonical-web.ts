import type { DshModelExecutionProfile } from './profile-compiler';
import type { ProviderAuthType } from '../../../shared/config-types';
import { getProxyForProviderUrl, getProxyForUrl } from '../../proxy-state';
import type { DshRequestContext, DshRpcObject } from './protocol-types';
import { convertDshWebContent } from './canonical-web-content';
import { DshCanonicalWebError } from './canonical-web-errors';
import {
  DshCanonicalWebProvider,
  type DshCanonicalWebProviderPort,
  type DshCanonicalTokenUsage,
} from './canonical-web-provider';
import { DshSafeHttpClient, type DshSafeHttpConfig } from './safe-http';

const COMPONENT_GENERATION_ID = 'myagents-host-canonical-web-v1';
const WEB_FETCH_COMPONENT_ID = 'canonical-web-fetch';
const WEB_SEARCH_COMPONENT_ID = 'canonical-web-search';
const MAX_FETCH_BYTES = 8 * 1_024 * 1_024;

type ActiveWebConfiguration = Readonly<{
  profile: DshModelExecutionProfile;
  apiKey: string;
  authType: ProviderAuthType;
  revision: string;
}>;

type CanonicalTool = 'WebFetch' | 'WebSearch';

function record(value: unknown): DshRpcObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as DshRpcObject
    : undefined;
}

function inputString(
  value: unknown,
  description: string,
  maximum: number,
  code: 'unsupported_content' | 'provider_search_failed' = 'unsupported_content',
): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new DshCanonicalWebError(code, `${description} is invalid`);
  }
  return value;
}

function domainArray(value: unknown, name: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64
    || value.some(item => typeof item !== 'string' || item.length < 1 || item.length > 253)
    || new Set(value).size !== value.length) {
    throw new DshCanonicalWebError('domain_policy_invalid', `${name} is invalid`);
  }
  return Object.freeze([...value] as string[]);
}

function contentPolicy(): ConstructorParameters<typeof DshSafeHttpClient>[0] {
  return Object.freeze({
    allowedHosts: Object.freeze([]),
    allowedPorts: Object.freeze([80, 443]),
    deniedHosts: Object.freeze(['metadata.google.internal']),
    maxCompressedBytes: MAX_FETCH_BYTES,
    maxCompressionRatio: 20,
    maxConcurrent: 4,
    maxDecompressedBytes: MAX_FETCH_BYTES,
    maxQueued: 32,
    maxRedirects: 5,
    timeoutMs: 120_000,
  });
}

function authorityMatches(input: {
  tool: CanonicalTool;
  params: DshRpcObject;
  configuration: ActiveWebConfiguration;
  runtimeSessionId: string | undefined;
}): boolean {
  const authority = record(input.params.authority);
  const componentId = input.tool === 'WebFetch' ? WEB_FETCH_COMPONENT_ID : WEB_SEARCH_COMPONENT_ID;
  return !!authority
    && authority.componentGenerationId === COMPONENT_GENERATION_ID
    && authority.componentId === componentId
    && authority.expectedConfigRevision === input.configuration.revision
    && authority.runtimeSessionId === input.runtimeSessionId
    && typeof authority.runtimeGeneration === 'string'
    && typeof authority.clientOperationId === 'string'
    && typeof authority.turnId === 'string'
    && typeof authority.rootCallId === 'string'
    && typeof authority.callId === 'string'
    && Number.isSafeInteger(authority.dshTurn)
    && authority.dshTurn as number >= 1;
}

function failure(error: unknown, signal: AbortSignal): DshRpcObject {
  if (signal.aborted) return { state: 'aborted', code: 'host_web_aborted' };
  if (error instanceof DshCanonicalWebError) {
    return {
      state: 'failed',
      code: error.code,
      content: [{ type: 'text', text: error.message.slice(0, 4_096) }],
    };
  }
  return {
    state: 'failed',
    code: 'network_policy_denied',
    content: [{ type: 'text', text: 'Host Web request failed' }],
  };
}

export class DshCanonicalWebHost {
  private readonly contentClient: DshSafeHttpClient;
  private readonly provider: DshCanonicalWebProviderPort;

  constructor(private readonly options: Readonly<{
    activeConfiguration: () => ActiveWebConfiguration;
    runtimeSessionId: () => string | undefined;
    contentHttp?: DshSafeHttpConfig;
    provider?: DshCanonicalWebProviderPort;
  }>) {
    this.contentClient = new DshSafeHttpClient(
      contentPolicy(),
      options.contentHttp ?? { proxyForUrl: getProxyForUrl },
    );
    this.provider = options.provider ?? new DshCanonicalWebProvider({
      proxyForUrl: url => getProxyForProviderUrl(
        this.options.activeConfiguration().profile.provider,
        url,
      ),
    });
  }

  handles(params: DshRpcObject): boolean {
    return params.tool === 'WebFetch' || params.tool === 'WebSearch';
  }

  async close(): Promise<void> {
    await Promise.all([
      this.contentClient.close(),
      this.provider.close?.(),
    ]);
  }

  async execute(params: DshRpcObject, context: DshRequestContext): Promise<DshRpcObject> {
    const tool = params.tool as CanonicalTool;
    const configuration = this.options.activeConfiguration();
    if (!this.handles(params) || !authorityMatches({
      tool,
      params,
      configuration,
      runtimeSessionId: this.options.runtimeSessionId(),
    })) {
      return { state: 'failed', code: 'host_tool_authority_mismatch' };
    }
    try {
      const structured = tool === 'WebFetch'
        ? await this.webFetch(params, configuration, context.signal)
        : await this.webSearch(params, configuration, context.signal);
      context.signal.throwIfAborted();
      return { state: 'succeeded', structured };
    } catch (error) {
      const result = failure(error, context.signal);
      const authority = record(params.authority);
      console.warn(
        `[dsh-web] tool=${tool} code=${String(result.code)} phase=${error instanceof DshCanonicalWebError ? error.phase ?? 'unknown' : 'unknown'} system=${error instanceof DshCanonicalWebError ? error.systemErrorClass ?? 'unknown' : 'unknown'} backend=${configuration.profile.api} route=${configuration.profile.providerRouteId} operation=${String(authority?.clientOperationId ?? 'unknown')} call=${String(authority?.callId ?? 'unknown')}`,
      );
      return result;
    }
  }

  private async webFetch(
    params: DshRpcObject,
    configuration: ActiveWebConfiguration,
    signal: AbortSignal,
  ): Promise<DshRpcObject> {
    const input = record(params.input);
    if (!input || Object.keys(input).some(key => key !== 'url' && key !== 'prompt')) {
      throw new DshCanonicalWebError('unsupported_content', 'WebFetch input is invalid');
    }
    const url = inputString(input.url, 'WebFetch URL', 2048);
    const prompt = inputString(input.prompt, 'WebFetch prompt', 65_536);
    const fetched = await this.contentClient.request(url, {
      method: 'GET',
      headers: Object.freeze({
        accept: 'text/html,text/plain,text/markdown,application/xhtml+xml,application/pdf,application/json',
        'accept-encoding': 'gzip, deflate, br',
        'user-agent': 'MyAgents/DSH-Host-Web-v1',
      }),
      signal,
    });
    if (fetched.statusCode < 200 || fetched.statusCode > 299) {
      throw new DshCanonicalWebError('unsupported_content', 'WebFetch response status is unsupported');
    }
    const converted = await convertDshWebContent({
      bytes: fetched.bytes,
      contentType: fetched.contentType,
      signal,
    });
    const utility = await this.provider.runUtility({
      profile: configuration.profile,
      apiKey: configuration.apiKey,
      authType: configuration.authType,
      source: converted.text,
      prompt,
      finalUrl: fetched.finalUrl,
      statusCode: fetched.statusCode,
      signal,
    });
    return {
      url,
      finalUrl: fetched.finalUrl,
      answer: utility.answer,
      citations: utility.citations,
      usage: utility.usage satisfies DshCanonicalTokenUsage,
      truncated: converted.truncated || utility.truncated,
    };
  }

  private async webSearch(
    params: DshRpcObject,
    configuration: ActiveWebConfiguration,
    signal: AbortSignal,
  ): Promise<DshRpcObject> {
    const input = record(params.input);
    if (!input || Object.keys(input).some(key => (
      key !== 'query' && key !== 'allowed_domains' && key !== 'blocked_domains'
    ))) {
      throw new DshCanonicalWebError('domain_policy_invalid', 'WebSearch input is invalid');
    }
    const query = inputString(input.query, 'WebSearch query', 8192, 'provider_search_failed');
    const authority = record(params.authority) as DshRpcObject;
    return await this.provider.runSearch({
      profile: configuration.profile,
      apiKey: configuration.apiKey,
      authType: configuration.authType,
      query,
      allowedDomains: domainArray(input.allowed_domains, 'WebSearch allowed domains'),
      blockedDomains: domainArray(input.blocked_domains, 'WebSearch blocked domains'),
      operationId: `${String(authority.clientOperationId)}:${String(authority.callId)}`,
      signal,
    });
  }
}
