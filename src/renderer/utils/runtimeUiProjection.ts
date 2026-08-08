import type { RuntimeExtensionDiagnostics, RuntimeType } from '../../shared/types/runtime';

export function projectInputChromeRuntime(args: {
  currentRuntime: RuntimeType;
  managedProviderRuntimeActive: boolean;
}): RuntimeType {
  return args.managedProviderRuntimeActive ? 'builtin' : args.currentRuntime;
}

export function shouldUseExternalRuntimeInputControls(args: {
  currentRuntime: RuntimeType;
  managedProviderRuntimeActive: boolean;
}): boolean {
  return args.currentRuntime !== 'builtin' && !args.managedProviderRuntimeActive;
}

export type RuntimeExtensionUpdateNotice = 'deferred' | 'unsupported' | null;

export function projectRuntimeExtensionUpdateNotice(
  status: RuntimeExtensionDiagnostics | undefined,
): RuntimeExtensionUpdateNotice {
  if (status?.state === 'deferred_until_idle') return 'deferred';
  if (status?.components.some(component => component.state === 'unsupported')) return 'unsupported';
  return null;
}
