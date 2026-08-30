import {
  resolveEffectiveRuntime,
  runtimeSourceForRuntimeType,
  type RuntimeConfig,
  type RuntimeSource,
  type RuntimeType,
} from '../../shared/types/runtime';
import type { AgentRuntimePreference } from '../../shared/integrated-runtimes/identity';
import { agentUsesManagedCodexProvider } from '../../shared/providerExecution';

type AgentRuntimeDefaults = {
  providerId?: string | null;
  runtime?: RuntimeType | null;
  runtimeConfig?: RuntimeConfig | null;
  runtimePreference?: AgentRuntimePreference | null;
};

export type RuntimeModelCatalogIdentity = {
  runtime: RuntimeType;
  source?: RuntimeSource;
};

export function runtimeModelCatalogPath(
  runtime: RuntimeType,
  source?: RuntimeSource,
): string {
  const params = new URLSearchParams({ type: runtime });
  if (runtime === 'codex') {
    params.set('source', source ?? 'system-cli');
  }
  return `/api/runtime/models?${params.toString()}`;
}

export function resolveRuntimeModelCatalogIdentity(
  runtimeOverride: RuntimeType | undefined,
  runtimeConfig: RuntimeConfig | undefined,
  inheritedIdentity: RuntimeModelCatalogIdentity,
): RuntimeModelCatalogIdentity {
  const runtime = runtimeOverride ?? inheritedIdentity.runtime;
  if (runtime !== 'codex') return { runtime };
  const source = runtimeOverride === undefined
    ? inheritedIdentity.source
    : runtimeConfig?.source;
  return { runtime, source: source ?? 'system-cli' };
}

export function resolveAgentRuntimeModelCatalogIdentity(
  agent: AgentRuntimeDefaults | null | undefined,
  runtimeSelectionAvailable = true,
  configuredDefaultIntegratedRuntime?: unknown,
): RuntimeModelCatalogIdentity {
  const runtime = resolveEffectiveRuntime(
    agent?.runtime,
    runtimeSelectionAvailable,
    agent?.runtimePreference,
    agent?.runtimeConfig?.source,
    agent?.providerId,
    undefined,
    configuredDefaultIntegratedRuntime,
  );
  if (runtime === 'builtin' && agentUsesManagedCodexProvider(agent)) {
    return { runtime: 'codex', source: 'managed-provider' };
  }
  const source = runtimeSourceForRuntimeType(runtime, agent?.runtimeConfig?.source);
  return source ? { runtime, source } : { runtime };
}

export function clearRuntimeModelOverride(
  runtimeConfig: RuntimeConfig | undefined,
): RuntimeConfig | undefined {
  if (!runtimeConfig?.model) return runtimeConfig;
  const next = { ...runtimeConfig };
  delete next.model;
  return Object.keys(next).length > 0 ? next : undefined;
}
