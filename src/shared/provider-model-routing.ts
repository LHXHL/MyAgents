import type { ModelEntity, Provider } from './config-types';
import { getOpenCodeGoOfficialProtocol, OPENCODE_GO_PROVIDER_ID } from './opencode-go';
import {
  MODEL_PROTOCOL_PRIORITY, parseSupportedProtocols, TOKENDANCE_PROVIDER_ID,
  type ModelProtocol,
} from './tokendance';

type ModelRoutingProvider = Pick<Provider, 'id' | 'config' | 'models' | 'apiProtocol' | 'upstreamFormat' | 'maxOutputTokens' | 'maxOutputTokensParamName' | 'authType' | 'modelRouting' | 'modelProtocolBaseUrls'> & Partial<Pick<Provider, 'name' | 'isBuiltin'>>;

export function isPerModelProtocolProvider(provider: ModelRoutingProvider): boolean {
  return provider.isBuiltin === true && provider.modelRouting === 'per-model';
}

/** A unique route is required unless this provider explicitly defines a preference. */
export function resolveModelProtocol(provider: ModelRoutingProvider, model: ModelEntity): ModelProtocol | undefined {
  if (!isPerModelProtocolProvider(provider)) return undefined;
  if (provider.id === TOKENDANCE_PROVIDER_ID) {
    const available = parseSupportedProtocols(model.supportedProtocols);
    return MODEL_PROTOCOL_PRIORITY.find(protocol => available?.includes(protocol));
  }
  const selected = model.executionProtocol;
  if (selected && MODEL_PROTOCOL_PRIORITY.includes(selected)) return selected;
  const official = provider.id === OPENCODE_GO_PROVIDER_ID
    ? getOpenCodeGoOfficialProtocol(model.model) : undefined;
  if (official) return official;
  const available = parseSupportedProtocols(model.supportedProtocols);
  return available?.length === 1 ? available[0] : undefined;
}

/** Resolve an immutable execution projection for the concrete route model. */
export function resolveProviderForModel<T extends ModelRoutingProvider>(provider: T, modelId: string): T {
  if (!isPerModelProtocolProvider(provider)) return provider;
  const model = provider.models.find(item => item.model === modelId);
  const protocol = model && resolveModelProtocol(provider, model);
  if (!protocol) {
    if (provider.id === TOKENDANCE_PROVIDER_ID) {
      throw new Error(`TokenDance model '${modelId}' has no known supported conversation protocol. Refresh the model catalog.`);
    }
    throw new Error(`Model '${modelId}' has no known execution protocol for ${provider.name ?? provider.id}. Set its protocol in model settings or refresh the catalog.`);
  }
  const isAnthropic = protocol === 'anthropic:messages';
  const baseUrl = provider.modelProtocolBaseUrls?.[protocol];
  if (!baseUrl) throw new Error(`Provider '${provider.id}' does not define an endpoint for ${protocol}.`);
  return {
    ...provider,
    config: { ...provider.config, baseUrl },
    authType: provider.authType,
    apiProtocol: isAnthropic ? 'anthropic' : 'openai',
    upstreamFormat: isAnthropic ? undefined
      : protocol === 'openai:responses' ? 'responses' : 'chat_completions',
    maxOutputTokens: isAnthropic ? undefined : provider.maxOutputTokens,
    maxOutputTokensParamName: isAnthropic ? undefined
      : protocol === 'openai:responses' ? 'max_output_tokens' : 'max_tokens',
  };
}

/** The SDK Query has one upstream transport; known sub-agent routes must match it. */
export function assertQueryModelRoutesCompatible(
  provider: Provider,
  activeRoute: Pick<Provider, 'apiProtocol' | 'upstreamFormat'>,
  modelIds: Iterable<string>,
): void {
  for (const modelId of new Set(modelIds)) {
    const route = resolveProviderForModel(provider, modelId);
    if (route.apiProtocol !== activeRoute.apiProtocol || route.upstreamFormat !== activeRoute.upstreamFormat) {
      throw new Error(`Model '${modelId}' uses a different API protocol than this ${provider.name} session. Choose a model using the same protocol for sub-agents.`);
    }
  }
}
