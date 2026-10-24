import { isProviderEnabled } from '../../shared/config-types';
import { normalizeOfficialToolIds, type OfficialToolId } from '../../shared/official-tools';
import { VALID_RUNTIMES, type RuntimeSource, type RuntimeType } from '../../shared/types/runtime';
import type { RuntimeBackedProviderIdentity } from '../../shared/providerExecution';
import type { SessionMetadata } from '../types/session';
import { getAllEffectiveProviders, getAllMcpServers, type AdminAppConfig } from './admin-config';

/**
 * Team AI peer profile: the birth template one private chat / group owns once
 * its current Session configuration has been changed.
 *
 * Node owns this shape. Rust stores it opaquely in
 * `agents[].channels[].peerProfiles[sessionKey]` and only hands it back to
 * `POST /sessions`, so the fields are exactly that endpoint's explicit birth
 * fields. Permission is deliberately absent: IM births always use the
 * Runtime's highest unattended mode.
 */
export interface PeerProfile {
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
  providerExecutionIdentity?: RuntimeBackedProviderIdentity;
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
  mcpEnabledServers?: string[];
  enabledPluginIds?: string[];
  enabledOfficialToolIds?: OfficialToolId[];
}

/** Copy a Session's complete execution choices. Called only for a peer's current Session. */
export function peerProfileFromSession(metadata: SessionMetadata): PeerProfile {
  const identity = metadata.providerExecutionIdentity?.kind === 'runtime-backed-provider'
    ? metadata.providerExecutionIdentity
    : undefined;
  return {
    runtime: (metadata.runtime ?? 'builtin') as RuntimeType,
    ...(metadata.runtimeSource ? { runtimeSource: metadata.runtimeSource } : {}),
    ...(identity ? { providerExecutionIdentity: { ...identity } } : {}),
    ...(!identity && metadata.providerId ? { providerId: metadata.providerId } : {}),
    ...(metadata.model ? { model: metadata.model } : {}),
    // An unset effort means "provider default"; record it so births never fall back to the Agent's.
    reasoningEffort: metadata.reasoningEffort ?? 'default',
    mcpEnabledServers: [...(metadata.mcpEnabledServers ?? [])],
    enabledPluginIds: [...(metadata.enabledPluginIds ?? [])],
    enabledOfficialToolIds: [...(metadata.enabledOfficialToolIds ?? [])],
  };
}

export type PeerProfileBirth =
  | { kind: 'applied'; fields: PeerProfile }
  | { kind: 'rejected'; reason: string };

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : undefined;

/**
 * Decide whether a stored profile can still seed a birth.
 *
 * Only facts that the configuration proves permanently gone reject the
 * profile (the caller then deletes it): unknown Runtime, deleted or disabled
 * Provider, or a model no longer listed by that Provider. Credentials,
 * subscription verification, Managed Codex readiness and CLI login are
 * transient and stay with the normal birth/runtime errors. Missing MCP servers
 * or plugins are filtered instead of invalidating the whole profile.
 */
export function resolvePeerProfileBirth(
  raw: unknown,
  config: AdminAppConfig,
  installedPluginIds: readonly string[],
): PeerProfileBirth {
  if (!raw || typeof raw !== 'object') return { kind: 'rejected', reason: 'malformed' };
  const value = raw as Record<string, unknown>;
  if (!(VALID_RUNTIMES as readonly unknown[]).includes(value.runtime)) return { kind: 'rejected', reason: 'runtime' };
  const runtime = value.runtime as RuntimeType;
  const identity = value.providerExecutionIdentity as RuntimeBackedProviderIdentity | undefined;
  const providerId = identity?.providerId ?? (typeof value.providerId === 'string' ? value.providerId : undefined);
  const model = typeof value.model === 'string' ? value.model : undefined;
  if (providerId && (runtime === 'builtin' || runtime === 'dsh' || identity)) {
    const provider = getAllEffectiveProviders(config).find(candidate => candidate.id === providerId);
    if (!provider || !isProviderEnabled(provider)) return { kind: 'rejected', reason: 'provider' };
    const models = (provider as { models?: Array<{ model?: unknown }> }).models ?? [];
    if (!identity && model && !models.some(entry => entry.model === model)) {
      return { kind: 'rejected', reason: 'model' };
    }
  }
  const mcpIds = new Set(getAllMcpServers(config).map(server => server.id));
  const plugins = new Set(installedPluginIds);
  return {
    kind: 'applied',
    fields: {
      runtime,
      ...(typeof value.runtimeSource === 'string' ? { runtimeSource: value.runtimeSource as RuntimeSource } : {}),
      ...(identity ? { providerExecutionIdentity: identity } : {}),
      ...(!identity && providerId ? { providerId } : {}),
      ...(model ? { model } : {}),
      reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : 'default',
      mcpEnabledServers: (strings(value.mcpEnabledServers) ?? []).filter(id => mcpIds.has(id)),
      enabledPluginIds: (strings(value.enabledPluginIds) ?? []).filter(id => plugins.has(id)),
      enabledOfficialToolIds: normalizeOfficialToolIds(value.enabledOfficialToolIds ?? []),
    },
  };
}

type BirthSnapshot = Pick<SessionMetadata, 'model' | 'providerId' | 'providerRoute' | 'providerEnvJson' | 'providerExecutionIdentity' | 'reasoningEffort'>;

/**
 * A profile is the complete birth choice. `POST /sessions` starts from the
 * Agent template and overrides only fields that are present, so fields the
 * profile leaves unset must be cleared here rather than inherited. Call it
 * after the endpoint's own field coercion so the profile has the last word.
 */
export function completePeerProfileSnapshot<T extends BirthSnapshot>(snapshot: T, profile: PeerProfile): T {
  // The runtime-only effort coercer lacks Provider context (DSH, OpenAI levels);
  // the profile's effort was already accepted by its source Session, so keep it.
  const next = { ...snapshot, ...(profile.reasoningEffort !== undefined ? { reasoningEffort: profile.reasoningEffort } : {}) };
  if (profile.providerExecutionIdentity) return next;
  if (profile.model === undefined) {
    next.model = undefined;
    next.providerRoute = undefined;
  }
  if (profile.providerId === undefined) {
    next.providerId = undefined;
    next.providerRoute = undefined;
    next.providerEnvJson = undefined;
  }
  return next;
}
