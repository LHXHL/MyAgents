import type { DshCollaborationModelRef, Provider, ProviderAuthType } from '../../../shared/config-types';
import { compileDshModelExecutionProfile, type DshModelExecutionProfile } from './profile-compiler';

export type DshHostModelBinding = Readonly<{ profile: DshModelExecutionProfile; apiKey: string; authType: ProviderAuthType }>;
export type DshCollaborationDeclaration = Readonly<{
  version: 1; maxDepth: number; maxActiveChildren: number; maxRetainedChildren: number;
  messageDelivery: 'realtime' | 'turn';
  modelProfiles: readonly DshModelExecutionProfile[];
  modelPolicy: Readonly<{ mode: 'inherit' | 'fixed' | 'agent'; profileRef?: string; roles: readonly Readonly<{ role: string; profileRef: string }>[] }>;
}>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DSH collaboration settings must be an object');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('DSH collaboration identifier is invalid');
  return value;
}
function limit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new Error('DSH collaboration limit is out of range');
  return value as number;
}

/** Compiles user choices into the exact Runtime catalog; credentials stay only in the Host bindings. */
export function compileDshCollaboration(
  primary: DshHostModelBinding,
  value: unknown,
  resolve: (ref: DshCollaborationModelRef) => Readonly<{ provider: Provider; apiKey: string }>,
): Readonly<{ collaboration: DshCollaborationDeclaration; bindings: readonly DshHostModelBinding[] }> {
  const settings = value === undefined ? {} : record(value);
  const allowedKeys = new Set(['maxDepth', 'maxActiveChildren', 'maxRetainedChildren', 'messageDelivery', 'modelPolicy', 'fixedModel', 'roleModels', 'allowedModels']);
  if (Object.keys(settings).some(key => !allowedKeys.has(key))) throw new Error('Unknown DSH collaboration setting');
  const maxDepth = limit(settings.maxDepth, 1, 8);
  const maxActiveChildren = limit(settings.maxActiveChildren, 32, 32);
  const maxRetainedChildren = limit(settings.maxRetainedChildren, 256, 256);
  if (maxActiveChildren > maxRetainedChildren) throw new Error('DSH active capacity exceeds retained capacity');
  const mode = settings.modelPolicy ?? 'inherit';
  const messageDelivery = settings.messageDelivery ?? 'realtime';
  if (mode !== 'inherit' && mode !== 'fixed' && mode !== 'agent') throw new Error('DSH model strategy is invalid');
  if (messageDelivery !== 'realtime' && messageDelivery !== 'turn') throw new Error('DSH collaboration message timing is invalid');
  const bindings = new Map<string, DshHostModelBinding>([[primary.profile.revision, primary]]);
  const references = new Map<string, string>();
  const compile = (raw: unknown): string => {
    const ref = record(raw);
    if (Object.keys(ref).some(key => key !== 'providerId' && key !== 'modelId' && key !== 'role')) throw new Error('Unknown DSH model reference field');
    const providerId = identifier(ref.providerId);
    const modelId = identifier(ref.modelId);
    const key = JSON.stringify([providerId, modelId]);
    const known = references.get(key);
    if (known) return known;
    const resolved = resolve({ providerId, modelId });
    if (resolved.provider.id !== providerId) throw new Error('DSH collaboration resolver changed the requested Provider');
    if (!resolved.apiKey) throw new Error('DSH collaboration model lacks its Host credential');
    const profile = resolved.provider.id === primary.profile.provider && modelId === primary.profile.modelId
      ? primary.profile : compileDshModelExecutionProfile({ provider: resolved.provider, modelId, reasoningEffort: 'default' });
    if (!bindings.has(profile.revision)) {
      if (bindings.size >= 65) throw new Error('DSH collaboration model catalog exceeds 64 additional models');
      bindings.set(profile.revision, Object.freeze({ profile, apiKey: resolved.apiKey, authType: resolved.provider.authType ?? 'both' }));
    }
    references.set(key, profile.revision);
    return profile.revision;
  };
  const allowed = settings.allowedModels ?? [];
  const configuredRoles = settings.roleModels ?? [];
  if (!Array.isArray(allowed) || allowed.length > 64 || !Array.isArray(configuredRoles) || configuredRoles.length > 128) throw new Error('DSH collaboration catalog is not bounded');
  for (const model of allowed) compile(model);
  const roles = configuredRoles.map(raw => {
    const row = record(raw);
    const role = identifier(row.role);
    return Object.freeze({ role, profileRef: compile(row) });
  });
  if (new Set(roles.map(row => row.role)).size !== roles.length) throw new Error('DSH role has multiple fixed models');
  const profileRef = mode === 'fixed' ? compile(settings.fixedModel) : undefined;
  return Object.freeze({
    bindings: Object.freeze([...bindings.values()]),
    collaboration: Object.freeze({ version: 1, maxDepth, maxActiveChildren, maxRetainedChildren, messageDelivery,
      modelProfiles: Object.freeze([...bindings.values()].filter(binding => binding.profile.revision !== primary.profile.revision).map(binding => binding.profile)),
      modelPolicy: Object.freeze({ mode, ...(profileRef ? { profileRef } : {}), roles: Object.freeze(roles) }),
    }),
  });
}
