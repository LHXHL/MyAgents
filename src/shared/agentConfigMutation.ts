import { resolveAgentRuntimePreference, runtimeTypeForAgentRuntimePreference } from './integrated-runtimes/identity';
import type { AgentConfig } from './types/agent';
import { buildRuntimeChangePatch, type RuntimeConfig } from './types/runtime';
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from './config-types';
import { agentDefaultsForRuntimeBackedProvider, createRuntimeBackedProviderIdentity, type RuntimeBackedProviderIdentity } from './providerExecution';

/** Field intent, resolved only by the config writer against its locked latest record. */
export type AgentConfigMutation = Partial<Omit<AgentConfig, 'id'>> & {
  runtimeConfigPatch?: Partial<RuntimeConfig>;
  runtimeBackedProviderSelection?: RuntimeBackedProviderIdentity;
};

export function resolveAgentConfigMutation(current: AgentConfig, mutation: AgentConfigMutation): Partial<Omit<AgentConfig, 'id'>> {
  const { runtimeConfigPatch, runtimeBackedProviderSelection, ...patch } = mutation;
  if (runtimeBackedProviderSelection) {
    Object.assign(patch, agentDefaultsForRuntimeBackedProvider(runtimeBackedProviderSelection, current.runtimeConfig, {
      permissionMode: mutation.permissionMode,
      reasoningEffort: mutation.reasoningEffort,
    }));
    delete patch.reasoningEffort;
  } else if (patch.runtime !== undefined && !Object.hasOwn(patch, 'runtimeConfig')) {
    Object.assign(patch, buildRuntimeChangePatch(current.runtimeConfig, patch.runtime));
  } else if (patch.providerId !== undefined && patch.providerId !== CODEX_SUBSCRIPTION_PROVIDER_ID
    && (current.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID || current.runtimeConfig?.source === 'managed-provider')) {
    Object.assign(patch, buildRuntimeChangePatch(current.runtimeConfig, 'builtin'));
  }
  if (runtimeConfigPatch) {
    patch.runtimeConfig = { ...(Object.hasOwn(patch, 'runtimeConfig') ? patch.runtimeConfig : current.runtimeConfig), ...runtimeConfigPatch };
  }
  return patch;
}

export type AgentModelSelection =
  | { kind: 'product-provider'; providerId: string; model: string }
  | { kind: 'external-cli'; runtime: string; runtimeSource: string; model: string };

/** Resolve IM model intent against the writer's latest Agent, matching desktop dual-write. */
export function mutationForAgentModelSelection(current: AgentConfig, selection: AgentModelSelection, effort?: string): AgentConfigMutation {
  if (selection.kind === 'external-cli') {
    const preference = resolveAgentRuntimePreference(current);
    const runtime = preference ? runtimeTypeForAgentRuntimePreference(preference) : current.runtime ?? 'builtin';
    const source = preference?.family === 'external' ? 'system-cli' : current.runtimeConfig?.source ?? 'system-cli';
    if (runtime !== selection.runtime || source !== selection.runtimeSource) {
      throw new Error('当前会话已修改；Agent 默认 Runtime 不同，无法写回此 CLI 模型');
    }
    return { runtimeConfigPatch: { model: selection.model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) } };
  }
  if (selection.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
    return { runtimeBackedProviderSelection: createRuntimeBackedProviderIdentity({ providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, model: selection.model }), ...(effort !== undefined ? { reasoningEffort: effort } : {}) };
  }
  return { providerId: selection.providerId, model: selection.model, providerEnvJson: undefined,
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    ...((current.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID || current.runtimeConfig?.source === 'managed-provider')
      && current.runtimePreference?.family === 'integrated' && current.runtimePreference.id === 'dsh' ? { runtime: 'dsh' } : {}) };
}
