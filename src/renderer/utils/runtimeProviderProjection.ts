import type { Provider } from '@/config/types';
import { isDshProviderModelCompatible } from '../../shared/integrated-runtimes/dsh-provider-cells';
import type { RuntimeType } from '../../shared/types/runtime';

/** Project Product Provider choices through the selected Runtime's exact contract. */
export function projectProvidersForRuntime(
  providers: readonly Provider[],
  runtime: RuntimeType,
): Provider[] {
  if (runtime !== 'dsh') return [...providers];
  return providers.flatMap((provider) => {
    const models = (provider.models ?? []).filter((model) => (
      isDshProviderModelCompatible(provider.id, model.model)
    ));
    if (models.length === 0) return [];
    const primaryModel = models.some((model) => model.model === provider.primaryModel)
      ? provider.primaryModel
      : models[0].model;
    return [{ ...provider, models, primaryModel }];
  });
}

export function isProviderModelCompatibleWithRuntime(
  runtime: RuntimeType,
  providerId: string | undefined,
  model: string | undefined,
): boolean {
  if (runtime !== 'dsh') return true;
  return !!providerId && !!model && isDshProviderModelCompatible(providerId, model);
}
