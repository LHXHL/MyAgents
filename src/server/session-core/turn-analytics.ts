import type { ProviderEnv } from '../provider-types';
import {
  RUNTIME_DISPLAY_NAMES,
  type RuntimeType,
} from '../../shared/types/runtime';

export type ProviderApiFamily =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-completions';

/** Non-secret attribution frozen by the execution configuration owner. */
export type TurnProviderAnalytics = {
  provider_id?: string | null;
  provider_name: string | null;
  api_protocol: 'anthropic' | 'openai' | null;
  provider_api_protocol: 'anthropic' | 'openai' | null;
  provider_api_family?: ProviderApiFamily | null;
  provider_base_url: string | null;
};

function analyticsBaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Preserve existing endpoint grouping when there are no secret components.
    if (!url.username && !url.password && !url.search && !url.hash) return value.trim();
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function buildTurnProviderAnalytics(
  providerEnv?: Pick<
    ProviderEnv,
    'providerId' | 'providerName' | 'baseUrl' | 'apiProtocol' | 'upstreamFormat'
  >,
  effectiveFamily?: ProviderApiFamily,
): TurnProviderAnalytics {
  const defaultFamily = providerEnv?.apiProtocol === 'openai'
    ? providerEnv.upstreamFormat === 'responses'
      ? 'openai-responses'
      : 'openai-completions'
    : 'anthropic-messages';
  const family = effectiveFamily ?? defaultFamily;
  const protocol = family === 'anthropic-messages' ? 'anthropic' : 'openai';
  return Object.freeze({
    provider_id: providerEnv ? providerEnv.providerId ?? null : 'anthropic-sub',
    provider_name: providerEnv ? providerEnv.providerName ?? providerEnv.providerId ?? null : 'Anthropic (订阅)',
    api_protocol: protocol,
    provider_api_protocol: protocol,
    provider_api_family: family,
    provider_base_url: analyticsBaseUrl(
      providerEnv?.baseUrl ?? (protocol === 'anthropic' ? 'https://api.anthropic.com' : undefined),
    ),
  });
}

/** CLI-owned credentials do not reveal a configured API endpoint to the Host. */
export function runtimeProviderAnalytics(runtime: RuntimeType): TurnProviderAnalytics {
  return {
    provider_id: null,
    provider_name: runtime === 'dsh' ? null : RUNTIME_DISPLAY_NAMES[runtime],
    api_protocol: null,
    provider_api_protocol: null,
    provider_api_family: null,
    provider_base_url: null,
  };
}
