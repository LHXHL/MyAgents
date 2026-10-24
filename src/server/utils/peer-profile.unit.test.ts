import { describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../types/session';

vi.mock('./admin-config', () => ({
  getAllEffectiveProviders: () => [
    { id: 'anthropic', models: [{ model: 'opus' }, { model: 'sonnet' }] },
    { id: 'off', enabled: false, models: [{ model: 'x' }] },
    { id: 'custom-endpoint', models: [] },
    { id: 'codex-sub', models: [] },
  ],
  getAllMcpServers: () => [{ id: 'browser' }],
}));

import { completePeerProfileSnapshot, peerProfileFromSession, resolvePeerProfileBirth } from './peer-profile';

const session = (extra: Partial<SessionMetadata>): SessionMetadata => ({
  id: 's', agentDir: '/w', title: '', createdAt: '', lastActiveAt: '', configSnapshotAt: 't', ...extra,
});
const resolve = (profile: unknown) => resolvePeerProfileBirth(profile, {} as never, ['report']);

describe('peer profile projection', () => {
  it('copies the complete execution choice and never the permission', () => {
    const profile = peerProfileFromSession(session({
      runtime: 'builtin', providerId: 'anthropic', model: 'opus', reasoningEffort: 'high', permissionMode: 'plan',
      mcpEnabledServers: ['browser'], enabledPluginIds: ['report'], enabledOfficialToolIds: ['web-search' as never],
    }));
    expect(profile).toEqual({
      runtime: 'builtin', providerId: 'anthropic', model: 'opus', reasoningEffort: 'high',
      mcpEnabledServers: ['browser'], enabledPluginIds: ['report'], enabledOfficialToolIds: ['web-search'],
    });
    expect(profile).not.toHaveProperty('permissionMode');
  });

  it('keeps a runtime-backed identity instead of a Product provider id', () => {
    const identity = { kind: 'runtime-backed-provider', providerId: 'codex-sub', runtime: 'codex', runtimeSource: 'managed-provider', model: 'gpt' } as const;
    const profile = peerProfileFromSession(session({ runtime: 'codex', runtimeSource: 'managed-provider', providerId: 'codex-sub', model: 'gpt', providerExecutionIdentity: identity }));
    expect(profile.providerExecutionIdentity).toEqual(identity);
    expect(profile).not.toHaveProperty('providerId');
  });
});

describe('peer profile birth', () => {
  it('applies a valid profile and filters tools that no longer exist', () => {
    const birth = resolve({ runtime: 'builtin', providerId: 'anthropic', model: 'sonnet', mcpEnabledServers: ['browser', 'gone'], enabledPluginIds: ['report', 'gone'], enabledOfficialToolIds: ['nope'] });
    expect(birth).toEqual({ kind: 'applied', fields: { runtime: 'builtin', providerId: 'anthropic', model: 'sonnet', reasoningEffort: 'default', mcpEnabledServers: ['browser'], enabledPluginIds: ['report'], enabledOfficialToolIds: [] } });
  });

  it.each([
    ['unknown Runtime', { runtime: 'gone' }, 'runtime'],
    ['deleted Provider', { runtime: 'builtin', providerId: 'deleted', model: 'm' }, 'provider'],
    ['disabled Provider', { runtime: 'dsh', providerId: 'off', model: 'x' }, 'provider'],
    ['removed model', { runtime: 'builtin', providerId: 'anthropic', model: 'retired' }, 'model'],
    ['last model removed', { runtime: 'builtin', providerId: 'custom-endpoint', model: 'anything' }, 'model'],
    ['malformed value', 'nope', 'malformed'],
  ])('rejects a permanently invalid profile: %s', (_label, profile, reason) => {
    expect(resolve(profile)).toEqual({ kind: 'rejected', reason });
  });

  it('does not judge readiness, credentials or CLI-owned models', () => {
    expect(resolve({ runtime: 'codex', runtimeSource: 'system-cli', model: 'cli-model' }).kind).toBe('applied');
    const identity = { kind: 'runtime-backed-provider', providerId: 'codex-sub', runtime: 'codex', runtimeSource: 'managed-provider', model: 'gpt' };
    expect(resolve({ runtime: 'codex', runtimeSource: 'managed-provider', providerExecutionIdentity: identity })).toMatchObject({ kind: 'applied', fields: { providerExecutionIdentity: identity } });
  });
});

describe('complete peer profile births', () => {
  const agentTemplate = { model: 'agent-model', providerId: 'agent-provider', providerRoute: { kind: 'concrete' } as never, providerEnvJson: '{}' };

  it('records an unset effort as provider default instead of leaving it to the Agent', () => {
    expect(peerProfileFromSession(session({ runtime: 'builtin', providerId: 'anthropic', model: 'opus' })).reasoningEffort).toBe('default');
  });

  it('clears template fields the profile leaves unset', () => {
    const born = completePeerProfileSnapshot(agentTemplate, { runtime: 'codex', runtimeSource: 'system-cli' });
    expect(born).toMatchObject({ model: undefined, providerId: undefined, providerRoute: undefined, providerEnvJson: undefined });
  });

  it('keeps the explicit profile values', () => {
    const born = completePeerProfileSnapshot({ ...agentTemplate, model: 'opus', providerId: 'anthropic' }, { runtime: 'builtin', providerId: 'anthropic', model: 'opus' });
    expect(born).toMatchObject({ model: 'opus', providerId: 'anthropic' });
  });
});
