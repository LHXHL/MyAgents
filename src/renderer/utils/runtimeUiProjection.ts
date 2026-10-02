import type { RuntimeExtensionDiagnostics, RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import { supportsCodexConversationBranch } from '../../shared/codex-conversation-capability';

/** DSH ships native product mutations; user-managed Codex depends on its CLI version. */
export function supportsRuntimeConversationBranches(
  runtime: RuntimeType,
  source: RuntimeSource | undefined,
  codexVersion: string | undefined,
): boolean {
  return runtime === 'builtin' || runtime === 'dsh'
    || (runtime === 'codex' && supportsCodexConversationBranch(source, codexVersion));
}

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
  return args.currentRuntime !== 'builtin'
    && args.currentRuntime !== 'dsh'
    && !args.managedProviderRuntimeActive;
}

/**
 * The static `/compact`, `/context`, etc. catalog describes Claude Agent SDK
 * commands, not the visual chrome used by the composer. Managed Codex keeps
 * builtin chrome, but must still project the capabilities of its real runtime.
 */
export function shouldShowBuiltinSdkSlashCommands(currentRuntime: RuntimeType): boolean {
  return currentRuntime === 'builtin';
}

export type RuntimeExtensionUpdateNotice = 'deferred' | 'unsupported' | null;

/** One-shot feedback for a user-initiated extension configuration change. */
export function requiresExtensionUserAction(
  status: RuntimeExtensionDiagnostics | undefined,
): boolean {
  return status?.components.some(component => (
    component.state === 'unsupported' && component.requiresUserAction === true
  )) ?? false;
}

export function projectRuntimeExtensionUpdateNotice(
  status: RuntimeExtensionDiagnostics | undefined,
): RuntimeExtensionUpdateNotice {
  if (status?.state === 'deferred_until_idle') return 'deferred';
  if (requiresExtensionUserAction(status)) return 'unsupported';
  return null;
}
