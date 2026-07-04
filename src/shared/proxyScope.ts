import type { ProxySettings, ProxyScopeSettings } from './config-types';

export const DEFAULT_PROXY_SCOPE: ProxyScopeSettings = Object.freeze({ mode: 'all' });

function cleanProviderIds(ids: unknown, visibleProviderIds?: readonly string[]): string[] {
  if (!Array.isArray(ids)) return [];
  const visible = visibleProviderIds ? new Set(visibleProviderIds) : null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id) continue;
    if (visible && !visible.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function normalizeProxyScope(
  raw: unknown,
  visibleProviderIds?: readonly string[],
): ProxyScopeSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_PROXY_SCOPE;
  }
  const scope = raw as Partial<ProxyScopeSettings>;
  if (scope.mode !== 'custom') {
    return DEFAULT_PROXY_SCOPE;
  }
  const providerIds = cleanProviderIds(scope.providerIds, visibleProviderIds);
  if (providerIds.length === 0) {
    return DEFAULT_PROXY_SCOPE;
  }
  return { mode: 'custom', providerIds };
}

export function shouldUseMyAgentsProxyForProvider(
  proxySettings: ProxySettings | null | undefined,
  providerId: string | null | undefined,
): boolean {
  if (!proxySettings?.enabled) return false;
  const id = providerId?.trim();
  if (!id) return false;
  const scope = normalizeProxyScope(proxySettings.scope);
  if (scope.mode === 'all') return true;
  return (scope.providerIds ?? []).includes(id);
}

export function effectiveProxyScopeKey(
  proxySettings: ProxySettings | null | undefined,
  providerId: string | null | undefined,
): string {
  const id = providerId?.trim();
  if (!proxySettings?.enabled || !id) return 'myagents-proxy:none';
  if (!shouldUseMyAgentsProxyForProvider(proxySettings, id)) {
    return `myagents-proxy:disabled-for-provider:${id}`;
  }
  const protocol = proxySettings.protocol || 'http';
  const host = proxySettings.host || '127.0.0.1';
  const port = proxySettings.port || 7890;
  return `myagents-proxy:${id}:${protocol}://${host}:${port}`;
}

export function normalizeProxySettingsScope(
  proxySettings: ProxySettings,
  visibleProviderIds?: readonly string[],
): ProxySettings {
  const scope = normalizeProxyScope(proxySettings.scope, visibleProviderIds);
  return {
    ...proxySettings,
    scope,
  };
}

export function removeProviderFromProxySettingsScope(
  proxySettings: ProxySettings | null | undefined,
  providerId: string,
): ProxySettings | undefined {
  if (!proxySettings) return undefined;
  const id = providerId.trim();
  if (!id || proxySettings.scope?.mode !== 'custom') return proxySettings;

  const providerIds = cleanProviderIds(proxySettings.scope.providerIds)
    .filter(existingId => existingId !== id);
  return {
    ...proxySettings,
    scope: providerIds.length > 0
      ? { mode: 'custom', providerIds }
      : DEFAULT_PROXY_SCOPE,
  };
}
