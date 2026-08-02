import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import type { ProviderEnv } from '../provider-types';
import {
  findProvider,
  isProviderDisabled,
  resolveProviderEnv,
} from './admin-config';

/** Materialize a Task's durable provider identity against current config. */
export function resolveTaskProviderRouting(
  providerId: string,
): ProviderEnv | 'subscription' {
  const provider = findProvider(providerId);
  if (!provider) {
    throw new Error(
      `Provider '${providerId}' not found in config — task references a provider that has been deleted. Re-select a provider in 任务编辑 → 高级配置.`,
    );
  }
  if (isProviderDisabled(providerId)) {
    throw new Error(
      `Provider '${providerId}' is disabled — re-enable it in 设置 → 模型供应商 → 启用和排序, or re-select a provider in 任务编辑 → 高级配置.`,
    );
  }
  if (providerId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
    throw new Error(
      `Provider '${providerId}' is runtime-backed — re-select it so the task can run through its managed runtime identity.`,
    );
  }
  if (provider.type === 'subscription') {
    return (resolveProviderEnv(providerId) as ProviderEnv | undefined) ?? 'subscription';
  }
  const env = resolveProviderEnv(providerId);
  if (!env) {
    throw new Error(
      `Provider '${providerId}' has no API Key — open 设置 → 模型供应商 to configure it, or re-select a provider in 任务编辑 → 高级配置.`,
    );
  }
  return env;
}
