import type { Provider } from '../../shared/config-types';
import {
  resolveAgentRuntimePreference,
} from '../../shared/integrated-runtimes/identity';
import { getProviderExecutionConstraint } from '../../shared/integrated-runtimes/provider-constraints';
import type { ProviderExecutionIntent } from '../../shared/providerExecution';
import { runtimeBackedProviderPermissionMode } from '../../shared/providerExecution';
import {
  coerceRuntimeBirthReasoningEffort,
} from '../../shared/runtimeBirthFields';
import {
  type RuntimeSource,
  type RuntimeType,
} from '../../shared/types/runtime';
import type { OfficialToolId } from '../../shared/official-tools';

export type ProviderSwitchSessionBirth = {
  runtime: RuntimeType;
  opts: {
    runtimeSource?: RuntimeSource;
    providerExecutionIdentity?: Extract<ProviderExecutionIntent, { kind: 'runtime-backed-provider' }>;
    providerId?: string;
    model?: string;
    permissionMode?: string;
    reasoningEffort?: string;
    mcpEnabledServers?: string[];
    enabledPluginIds?: string[];
    enabledOfficialToolIds?: OfficialToolId[];
  };
};

/**
 * Resolve the Integrated Runtime to return to when the current Session is a
 * runtime-backed Provider. A live Integrated Session wins; otherwise the
 * Agent's authoritative preference preserves the base Runtime selected before
 * entering Managed Codex. Runtime-constrained subscription Providers still
 * route to their declared Integrated owner.
 */
export function resolveProviderSwitchIntegratedRuntime(args: {
  targetProvider: Provider;
  currentSessionRuntime: RuntimeType;
  agentRuntimePreference?: unknown;
  legacyAgentRuntime?: RuntimeType;
  legacyAgentRuntimeSource?: RuntimeSource;
  legacyAgentProviderId?: string;
}): 'builtin' | 'dsh' {
  const constraint = getProviderExecutionConstraint(args.targetProvider);
  if (constraint.kind === 'requires-integrated-runtime') return 'builtin';

  if (args.currentSessionRuntime === 'builtin' || args.currentSessionRuntime === 'dsh') {
    return args.currentSessionRuntime;
  }

  const preference = resolveAgentRuntimePreference({
    runtimePreference: args.agentRuntimePreference,
    runtime: args.legacyAgentRuntime,
    runtimeSource: args.legacyAgentRuntimeSource,
    providerId: args.legacyAgentProviderId,
  });
  if (preference?.family !== 'integrated') return 'builtin';
  return preference.id === 'dsh' ? 'dsh' : 'builtin';
}

export function buildProviderSwitchSessionBirth(args: {
  targetIntent: ProviderExecutionIntent;
  providerId: string;
  model: string;
  permissionMode: string;
  reasoningEffort: string;
  mcpEnabledServers: string[];
  enabledPluginIds: string[];
  enabledOfficialToolIds?: OfficialToolId[];
  targetIntegratedRuntime: 'builtin' | 'dsh';
}): ProviderSwitchSessionBirth {
  const common = {
    permissionMode: args.permissionMode,
    reasoningEffort: args.reasoningEffort,
    mcpEnabledServers: args.mcpEnabledServers,
    enabledPluginIds: args.enabledPluginIds,
    ...(args.enabledOfficialToolIds !== undefined ? { enabledOfficialToolIds: args.enabledOfficialToolIds } : {}),
  };

  if (args.targetIntent.kind === 'runtime-backed-provider') {
    const permissionMode =
      runtimeBackedProviderPermissionMode(args.targetIntent, args.permissionMode);
    const reasoningEffort =
      coerceRuntimeBirthReasoningEffort(args.reasoningEffort, args.targetIntent.runtime);
    return {
      runtime: args.targetIntent.runtime,
      opts: {
        ...common,
        permissionMode,
        reasoningEffort,
        runtimeSource: args.targetIntent.runtimeSource,
        providerExecutionIdentity: args.targetIntent,
        providerId: args.targetIntent.providerId,
        model: args.targetIntent.model,
      },
    };
  }

  return {
    runtime: args.targetIntegratedRuntime,
    opts: {
      ...common,
      providerId: args.providerId,
      model: args.model,
    },
  };
}

export function buildRuntimeBackedInitialSessionBirth(args: {
  identity: Extract<ProviderExecutionIntent, { kind: 'runtime-backed-provider' }>;
  permissionMode?: string;
  reasoningEffort?: string;
  mcpEnabledServers?: string[];
  enabledPluginIds?: string[];
  enabledOfficialToolIds?: OfficialToolId[];
}): ProviderSwitchSessionBirth {
  const permissionMode =
    args.permissionMode !== undefined
      ? runtimeBackedProviderPermissionMode(args.identity, args.permissionMode)
      : undefined;
  const reasoningEffort =
    args.reasoningEffort !== undefined
      ? coerceRuntimeBirthReasoningEffort(args.reasoningEffort, args.identity.runtime)
      : undefined;
  return {
    runtime: args.identity.runtime,
    opts: {
      runtimeSource: args.identity.runtimeSource,
      providerExecutionIdentity: args.identity,
      providerId: args.identity.providerId,
      model: args.identity.model,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(args.mcpEnabledServers !== undefined ? { mcpEnabledServers: args.mcpEnabledServers } : {}),
      ...(args.enabledPluginIds !== undefined ? { enabledPluginIds: args.enabledPluginIds } : {}),
      ...(args.enabledOfficialToolIds !== undefined ? { enabledOfficialToolIds: args.enabledOfficialToolIds } : {}),
    },
  };
}
