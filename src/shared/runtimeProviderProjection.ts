import { ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID, CODEX_SUBSCRIPTION_PROVIDER_ID, type Provider } from './config-types';
import {
  getProviderExecutionConstraint,
  isDshModelSelectable,
  isDshProviderEligible,
} from './integrated-runtimes/provider-constraints';
import { isRuntimeBackedProvider, isRuntimeBackedProviderId } from './providerExecution';
import type { RuntimeType, RuntimeSource } from './types/runtime';
import { resolveAgentRuntimePreference } from './integrated-runtimes/identity';

const LINUX_HIDDEN_PROVIDER_IDS = [CODEX_SUBSCRIPTION_PROVIDER_ID, ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID];
export function platformHiddenProviderIds(platform: string): readonly string[] {
  return platform === 'linux' || platform.startsWith('linux-') ? LINUX_HIDDEN_PROVIDER_IDS : [];
}

/** Project Product Provider choices through the selected Runtime's execution owners. */
export function projectProvidersForRuntime(
  providers: readonly Provider[],
  runtime: RuntimeType,
): Provider[] {
  if (runtime !== 'dsh') return [...providers];
  return providers.flatMap((provider) => {
    // Managed Provider Runtimes remain first-class choices in the Product
    // picker. Selecting one crosses a Session boundary and never asks DSH to
    // execute the provider/model pair itself.
    if (isRuntimeBackedProvider(provider)) {
      return [provider];
    }
    return isDshProviderEligible(provider) ? [provider] : [];
  });
}

export function isProviderModelCompatibleWithRuntime(
  runtime: RuntimeType,
  provider: Provider | undefined,
  model: string | undefined,
): boolean {
  if (runtime !== 'dsh') return true;
  if (isRuntimeBackedProviderId(provider?.id)) return !!model;
  return !!provider && isDshModelSelectable(provider, model);
}

/**
 * Resolve the Integrated Runtime to return to when the current Session is a
 * runtime-backed Provider. A live Integrated Session wins; otherwise the
 * Agent's authoritative preference preserves the base Runtime selected before
 * entering Managed Codex. Official Claude routes still go to their declared
 * Integrated owner.
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
