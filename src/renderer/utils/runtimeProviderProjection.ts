import type { Provider } from '@/config/types';
import {
  isDshModelSelectable,
  isDshProviderEligible,
} from '../../shared/integrated-runtimes/provider-constraints';
import { isRuntimeBackedProvider, isRuntimeBackedProviderId } from '../../shared/providerExecution';
import type { RuntimeType } from '../../shared/types/runtime';

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
