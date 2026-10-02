import type { SessionMetadata } from '@/api/sessionClient';
import { isPendingSessionId } from '../../shared/constants';
import { isManagedProviderSessionSnapshot } from './sessionSnapshotProviderProjection';
import { normalizeRuntime } from '../../shared/types/runtime';
import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';

/** Prefer the Product snapshot, then same-Session Runtime, then pending launch intent. */
export function sessionMenuRuntimeIdentity(args: {
  sessionId: string;
  metadata: SessionMetadata | null;
  launchRuntime: RuntimeType;
  launchRuntimeSource: RuntimeSource | null | undefined;
  liveRuntime: string | null;
  liveRuntimeSource: RuntimeSource | null;
  liveRuntimeSessionId: string | null;
}): { runtime: RuntimeType | null; runtimeSource: RuntimeSource | null } {
  const {
    sessionId, metadata, launchRuntime, launchRuntimeSource,
    liveRuntime, liveRuntimeSource, liveRuntimeSessionId,
  } = args;
  if (metadata?.id === sessionId) {
    return {
      runtime: normalizeRuntime(metadata.runtime),
      runtimeSource: metadata.runtimeSource ??
        (isManagedProviderSessionSnapshot(metadata) ? 'managed-provider' : null),
    };
  }
  if (liveRuntime && liveRuntimeSessionId === sessionId) {
    return { runtime: normalizeRuntime(liveRuntime), runtimeSource: liveRuntimeSource };
  }
  if (isPendingSessionId(sessionId)) {
    return { runtime: launchRuntime, runtimeSource: launchRuntimeSource ?? null };
  }
  // A concrete history target must wait for its own snapshot; another
  // Session's runtime or the Agent's current preference cannot stand in.
  return { runtime: null, runtimeSource: null };
}
