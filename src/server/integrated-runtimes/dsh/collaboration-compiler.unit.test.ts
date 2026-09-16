import { describe, expect, it } from 'vitest';
import { PRESET_PROVIDERS } from '../../../shared/config-types';
import { compileDshModelExecutionProfile } from './profile-compiler';
import { compileDshCollaboration } from './collaboration-compiler';

const provider = structuredClone(PRESET_PROVIDERS.find(provider => provider.id === 'deepseek')!);
const primary = { profile: compileDshModelExecutionProfile({ provider, modelId: 'deepseek-v4-pro', reasoningEffort: 'max' }), apiKey: 'synthetic-fixture', authType: 'both' as const };
const resolve = () => ({ provider, apiKey: 'synthetic-fixture' });
describe('DSH collaboration catalog admission', () => {
  it('keeps the default direct-parent model and omits all credentials from Runtime declarations', () => {
    const result = compileDshCollaboration(primary, undefined, resolve);
    expect(result.collaboration).toMatchObject({ maxDepth: 1, messageDelivery: 'realtime', modelProfiles: [], modelPolicy: { mode: 'inherit', roles: [] } });
    expect(JSON.stringify(result.collaboration)).not.toContain(primary.apiKey);
  });
  it('deduplicates shared credentials and preserves root reasoning when the same model is selected by a role', () => {
    const result = compileDshCollaboration(primary, { maxDepth: 4, modelPolicy: 'agent',
      allowedModels: [{ providerId: provider.id, modelId: 'deepseek-flash' }],
      roleModels: [{ role: 'Explore', providerId: provider.id, modelId: 'deepseek-v4-pro' }, { role: 'Plan', providerId: provider.id, modelId: 'deepseek-flash' }],
    }, resolve);
    expect(result.bindings).toHaveLength(2);
    expect(result.collaboration.modelPolicy.roles[0]?.profileRef).toBe(primary.profile.revision);
    expect(result.collaboration.modelProfiles[0]?.modelId).toBe('deepseek-flash');
  });
  it('fails closed for impossible capacity, duplicate roles and unavailable model choices', () => {
    expect(() => compileDshCollaboration(primary, { maxDepth: 9 }, resolve)).toThrow('out of range');
    expect(() => compileDshCollaboration(primary, { maxActiveChildren: 8, maxRetainedChildren: 4 }, resolve)).toThrow('capacity');
    expect(() => compileDshCollaboration(primary, { modelPolicy: 'fixed' }, resolve)).toThrow();
    const role = { role: 'Explore', providerId: provider.id, modelId: primary.profile.modelId };
    expect(() => compileDshCollaboration(primary, { roleModels: [role, role] }, resolve)).toThrow('multiple');
    expect(() => compileDshCollaboration(primary, { allowedModels: [{ providerId: provider.id, modelId: 'absent-model' }] }, resolve)).toThrow();
  });
});
