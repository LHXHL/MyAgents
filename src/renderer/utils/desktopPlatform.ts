import { getPlatform } from '@/identity/deviceIdentity';
import { platformHiddenProviderIds } from '../../shared/runtimeProviderProjection';

/** Use the existing Rust-backed device identity; no persisted feature switch. */
export function isLinuxDesktop(): boolean {
  return getPlatform().startsWith('linux-');
}

export function getPlatformHiddenProviderIds(): readonly string[] {
  return platformHiddenProviderIds(getPlatform());
}
