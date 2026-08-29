import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import {
  legacyProjectionForBinding,
  resolvePersistedRuntimeBinding,
} from '../../shared/integrated-runtimes/identity';
import type { SessionMetadata } from '../types/session';

/** Resolve the effective Claude SDK identity without treating it as resume proof. */
export function resolveBuiltinSdkSessionId(meta: SessionMetadata): string | undefined {
  return meta.sdkSessionId ?? (meta.unifiedSession ? meta.id : undefined);
}

/**
 * Materialize the authoritative discriminated Runtime binding at the storage
 * read boundary. Legal legacy rows retain an exact legacy projection for old
 * readers. Illegal or unknown rows are quarantined and remain readable; they
 * never silently fall back to Claude SDK.
 */
export function normalizeSessionRuntimeIdentity(session: SessionMetadata): SessionMetadata {
  const resolution = resolvePersistedRuntimeBinding(session);
  if (resolution.status === 'incompatible') {
    return {
      ...session,
      runtimeBindingCompatibility: resolution.compatibility,
    };
  }

  const projection = legacyProjectionForBinding(resolution.binding);
  const normalized: SessionMetadata = {
    ...session,
    runtimeBinding: resolution.binding,
    runtime: projection.runtime,
  };
  delete normalized.runtimeBindingCompatibility;
  if (projection.runtimeSource) {
    normalized.runtimeSource = projection.runtimeSource;
  } else {
    delete normalized.runtimeSource;
  }
  if (resolution.binding.family === 'managed-provider') {
    normalized.providerId = CODEX_SUBSCRIPTION_PROVIDER_ID;
    delete normalized.providerRoute;
    delete normalized.providerEnvJson;
    if (normalized.providerExecutionIdentity?.runtimeSource !== 'managed-provider'
        || normalized.providerExecutionIdentity.runtime !== 'codex') {
      delete normalized.providerExecutionIdentity;
    }
  }
  return normalized;
}
