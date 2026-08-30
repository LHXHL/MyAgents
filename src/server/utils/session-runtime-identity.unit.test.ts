import { describe, expect, it } from 'vitest';

import { createDshBinding } from '../../shared/integrated-runtimes/identity';
import type { SessionMetadata } from '../types/session';
import { normalizeSessionRuntimeIdentity } from './session-runtime-identity';

function session(overrides: Partial<SessionMetadata>): SessionMetadata {
  return {
    id: 'session-1',
    agentDir: '/tmp/workspace',
    title: 'Session',
    createdAt: '2026-07-12T00:00:00.000Z',
    lastActiveAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeSessionRuntimeIdentity', () => {
  it('quarantines historical builtin/managed-provider metadata without Codex proof', () => {
    const normalized = normalizeSessionRuntimeIdentity(session({
      runtime: 'builtin',
      runtimeSource: 'managed-provider',
      model: 'claude-fable-4-6',
      providerId: 'anthropic-sub',
      providerRoute: {
        kind: 'subscription',
        providerId: 'anthropic-sub',
        model: 'claude-fable-4-6',
      },
      providerEnvJson: '{"providerId":"anthropic-sub"}',
    }));

    expect(normalized.runtime).toBe('builtin');
    expect(normalized.runtimeSource).toBe('managed-provider');
    expect(normalized.providerId).toBe('anthropic-sub');
    expect(normalized.runtimeBinding).toBeUndefined();
    expect(normalized.runtimeBindingCompatibility).toMatchObject({
      state: 'incompatible',
      code: 'legacy-managed-provider-without-codex-proof',
    });
  });

  it('migrates valid builtin and managed Codex identities idempotently', () => {
    const builtin = session({ runtime: 'builtin', providerId: 'anthropic-sub' });
    const managed = session({ runtime: 'codex', runtimeSource: 'managed-provider' });

    const normalizedBuiltin = normalizeSessionRuntimeIdentity(builtin);
    expect(normalizedBuiltin.runtimeBinding).toMatchObject({
      family: 'integrated',
      id: 'claude-agent-sdk',
    });
    expect(normalizeSessionRuntimeIdentity(normalizedBuiltin)).toEqual(normalizedBuiltin);

    const normalizedManaged = normalizeSessionRuntimeIdentity(managed);
    expect(normalizedManaged.runtimeBinding).toMatchObject({
      family: 'managed-provider',
      id: 'managed-codex',
    });
    expect(normalizedManaged.providerId).toBe('codex-sub');
    expect(normalizeSessionRuntimeIdentity(normalizedManaged)).toEqual(normalizedManaged);
  });

  it('preserves the canonical DSH compatibility projection from its authoritative binding', () => {
    const normalized = normalizeSessionRuntimeIdentity(session({
      runtime: 'builtin',
      runtimeBinding: createDshBinding('darwin-arm64'),
    }));

    expect(normalized).toMatchObject({
      runtime: 'dsh',
      runtimeSource: 'integrated',
      runtimeBinding: { family: 'integrated', id: 'dsh' },
    });
    expect(normalizeSessionRuntimeIdentity(normalized)).toEqual(normalized);
  });
});
