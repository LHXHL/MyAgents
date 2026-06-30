import type { RuntimeBackedProviderIdentity } from '../../shared/providerExecution';
import { normalizeRuntime, type RuntimeSource, type RuntimeType } from '../../shared/types/runtime';

// Single source of truth lives in shared/ (consumed by sidecar too). Re-exported
// here so existing renderer callers (`@/utils/sessionOpenPlan`) keep working.
export { normalizeRuntime, resolveEffectiveRuntime } from '../../shared/types/runtime';

export interface SessionOpenTabState {
  id: string;
  sessionId: string | null;
}

export interface SessionOpenActivationState {
  tab_id: string | null;
  task_id: string | null;
}

export interface SessionRuntimeIdentity {
  runtime: RuntimeType;
  /**
   * Missing source is legacy-compatible. For non-builtin runtimes it means the
   * user-managed/system CLI source; Managed Codex writes `managed-provider`.
   */
  runtimeSource?: RuntimeSource;
  /**
   * False means runtime identity came from a fallback after metadata lookup
   * failed. Such sessions must not use Rust key-rename hot swap; a target-owned
   * sidecar is safer than assuming builtin.
   */
  runtimeKnown?: boolean;
}

export interface SessionRuntimeMetadataForOpen {
  runtime?: string | null;
  runtimeSource?: RuntimeSource | null;
  providerExecutionIdentity?: RuntimeBackedProviderIdentity | null;
}

export type SessionOpenPlan =
  | { type: 'jump-to-tab'; tabId: string }
  | {
    type: 'open-new-tab';
    reason: 'runtime-mismatch' | 'current-cron-running';
    targetRuntime?: RuntimeType;
    currentRuntime?: RuntimeType;
    targetRuntimeSource?: RuntimeSource;
    currentRuntimeSource?: RuntimeSource;
  }
  | { type: 'attach-existing-sidecar'; taskId: string }
  | { type: 'switch-current-tab' };

export interface SessionOpenPlanInput {
  tabs: readonly SessionOpenTabState[];
  targetSessionId: string;
  multiAgentRuntime: boolean;
  currentRuntime?: RuntimeType;
  targetRuntime?: RuntimeType;
  currentRuntimeIdentity?: SessionRuntimeIdentity;
  targetRuntimeIdentity?: SessionRuntimeIdentity;
  targetActivation?: SessionOpenActivationState | null;
  currentTabCronRunning: boolean;
}

function normalizeIdentity(
  runtime: RuntimeType | undefined,
  runtimeSource: RuntimeSource | undefined,
): SessionRuntimeIdentity | undefined {
  if (!runtime) return undefined;
  if (runtime === 'builtin') return { runtime };
  return { runtime, runtimeSource: runtimeSource ?? 'system-cli' };
}

function normalizeRuntimeSourceForIdentity(
  runtime: RuntimeType,
  runtimeSource: RuntimeSource | null | undefined,
): RuntimeSource | undefined {
  if (runtime === 'builtin') return undefined;
  return runtimeSource ?? 'system-cli';
}

export function sessionRuntimeIdentityFromMetadataForOpen(
  metadata: SessionRuntimeMetadataForOpen | null | undefined,
  fallbackRuntime: RuntimeType,
): SessionRuntimeIdentity {
  const runtimeBackedIdentity = metadata?.providerExecutionIdentity;
  if (runtimeBackedIdentity?.kind === 'runtime-backed-provider') {
    return {
      runtime: runtimeBackedIdentity.runtime,
      runtimeSource: runtimeBackedIdentity.runtimeSource,
      runtimeKnown: true,
    };
  }

  const runtime = metadata?.runtime ? normalizeRuntime(metadata.runtime) : fallbackRuntime;
  return {
    runtime,
    runtimeSource: normalizeRuntimeSourceForIdentity(runtime, metadata?.runtimeSource),
    runtimeKnown: true,
  };
}

function resolveIdentity(
  identity: SessionRuntimeIdentity | undefined,
  runtime: RuntimeType | undefined,
): SessionRuntimeIdentity | undefined {
  return identity ?? normalizeIdentity(runtime, undefined);
}

function sameIdentity(a: SessionRuntimeIdentity, b: SessionRuntimeIdentity): boolean {
  return a.runtime === b.runtime
    && (a.runtimeSource ?? (a.runtime === 'builtin' ? undefined : 'system-cli'))
      === (b.runtimeSource ?? (b.runtime === 'builtin' ? undefined : 'system-cli'));
}

function hasManagedProviderSource(identity: SessionRuntimeIdentity | undefined): boolean {
  return identity?.runtimeSource === 'managed-provider';
}

export function planSessionOpen(input: SessionOpenPlanInput): SessionOpenPlan {
  const existingTab = input.tabs.find(tab => tab.sessionId === input.targetSessionId);
  if (existingTab) {
    return { type: 'jump-to-tab', tabId: existingTab.id };
  }

  // Attach to a sidecar already owned by a cron task BEFORE checking runtime mismatch.
  // The cron sidecar is keyed by sessionId; its runtime is fixed at spawn time. We're
  // not hot-swapping the current Tab's sidecar — we're switching this Tab to point at
  // the already-running cron sidecar (current Tab's old sidecar gets owner-released).
  // Routing through `open-new-tab(runtime-mismatch)` here calls
  // `activateSession(..., taskId: null)` and overwrites the cron's activation record,
  // breaking ownership. Attach preserves task_id via the dedicated cron path.
  if (input.targetActivation?.task_id) {
    return { type: 'attach-existing-sidecar', taskId: input.targetActivation.task_id };
  }

  const currentIdentity = resolveIdentity(input.currentRuntimeIdentity, input.currentRuntime);
  const targetIdentity = resolveIdentity(input.targetRuntimeIdentity, input.targetRuntime);
  const crossesRuntimeIdentity = !!currentIdentity
    && !!targetIdentity
    && !sameIdentity(currentIdentity, targetIdentity);
  const managedProviderBoundary = hasManagedProviderSource(currentIdentity)
    || hasManagedProviderSource(targetIdentity);

  if (
    crossesRuntimeIdentity
    && (input.multiAgentRuntime || managedProviderBoundary)
  ) {
    return {
      type: 'open-new-tab',
      reason: 'runtime-mismatch',
      currentRuntime: currentIdentity.runtime,
      targetRuntime: targetIdentity.runtime,
      ...(currentIdentity.runtimeSource ? { currentRuntimeSource: currentIdentity.runtimeSource } : {}),
      ...(targetIdentity.runtimeSource ? { targetRuntimeSource: targetIdentity.runtimeSource } : {}),
    };
  }

  if (input.currentTabCronRunning) {
    return { type: 'open-new-tab', reason: 'current-cron-running' };
  }

  return { type: 'switch-current-tab' };
}

export function canHotSwapSessionSidecar(input: {
  currentRuntime?: RuntimeType;
  targetRuntime?: RuntimeType;
  currentRuntimeIdentity?: SessionRuntimeIdentity;
  targetRuntimeIdentity?: SessionRuntimeIdentity;
}): boolean {
  if (input.currentRuntimeIdentity?.runtimeKnown === false || input.targetRuntimeIdentity?.runtimeKnown === false) {
    return false;
  }
  const currentIdentity = resolveIdentity(input.currentRuntimeIdentity, input.currentRuntime)
    ?? { runtime: 'builtin' as RuntimeType };
  const targetIdentity = resolveIdentity(input.targetRuntimeIdentity, input.targetRuntime)
    ?? { runtime: 'builtin' as RuntimeType };

  return currentIdentity.runtime === 'builtin' && targetIdentity.runtime === 'builtin';
}
