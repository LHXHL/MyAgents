import { describe, expect, it } from 'vitest';

import type { AgentConfig, ChannelConfig } from './agent';
import {
  resolveAgentChannelPermissionMode,
  resolveAgentChannelRuntime,
  resolveEffectiveConfig,
} from './agent';

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Agent',
    enabled: true,
    permissionMode: 'auto',
    channels: [],
    ...overrides,
  };
}

function channel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'channel-1',
    type: 'feishu',
    enabled: true,
    ...overrides,
  };
}

describe('Agent Channel effective config', () => {
  it('defaults IM channels to builtin fullAgency instead of inheriting Agent permissionMode', () => {
    const a = agent({ permissionMode: 'plan' });
    const ch = channel();

    expect(resolveAgentChannelRuntime(a, ch)).toBe('builtin');
    expect(resolveAgentChannelPermissionMode(a, ch)).toBe('fullAgency');
    expect(resolveEffectiveConfig(a, ch).permissionMode).toBe('fullAgency');
  });

  it('ignores legacy channel permission overrides at birth', () => {
    const a = agent({ permissionMode: 'fullAgency' });
    const ch = channel({ overrides: { permissionMode: 'plan' } });

    expect(resolveAgentChannelPermissionMode(a, ch)).toBe('fullAgency');
    expect(resolveEffectiveConfig(a, ch).permissionMode).toBe('fullAgency');
  });

  it('uses the selected runtime max permission when no channel override exists', () => {
    expect(resolveAgentChannelPermissionMode(agent({ runtime: 'codex' }), channel())).toBe('no-restrictions');
    expect(resolveAgentChannelPermissionMode(agent({ runtime: 'claude-code' }), channel())).toBe('bypassPermissions');
  });

  it('ignores legacy channel runtime and runtimeConfig overrides', () => {
    const a = agent({
      runtime: 'builtin',
      runtimeConfig: { permissionMode: 'auto' },
    });
    const ch = channel({
      overrides: {
        runtime: 'codex',
        runtimeConfig: { permissionMode: 'full-auto' },
      },
    });

    const effective = resolveEffectiveConfig(a, ch);
    expect(effective.runtime).toBe('builtin');
    expect(effective.permissionMode).toBe('fullAgency');
    expect(effective.runtimeConfig).toEqual({ permissionMode: 'auto' });
  });

  it('keeps managed Channel permission in product vocabulary until execution projection', () => {
    const a = agent({ permissionMode: 'plan', runtime: 'builtin', providerId: 'codex-sub', model: 'gpt-5.5-codex' });
    const ch = channel({
      overrides: {
        providerId: 'codex-sub',
        model: 'gpt-5.5-codex',
      },
    });

    const effective = resolveEffectiveConfig(a, ch);
    expect(effective.runtime).toBe('codex');
    expect(effective.permissionMode).toBe('fullAgency');
  });

  it('does not let a dormant managed provider override an explicit system runtime', () => {
    const a = agent({
      providerId: 'codex-sub',
      model: 'gpt-5.5-codex',
      runtime: 'claude-code',
      runtimeConfig: { source: 'managed-provider' },
    });

    expect(resolveAgentChannelRuntime(a, channel())).toBe('claude-code');
    expect(resolveAgentChannelPermissionMode(a, channel())).toBe('bypassPermissions');
  });

  it('uses authoritative Integrated DSH preference ahead of a stale legacy projection', () => {
    const a = agent({
      runtime: 'codex',
      runtimePreference: { family: 'integrated', id: 'dsh' },
      providerId: 'deepseek',
    });

    expect(resolveAgentChannelRuntime(a, channel())).toBe('dsh');
    expect(resolveAgentChannelPermissionMode(a, channel())).toBe('full-autonomous');
  });

  it('applies subscription constraints after Integrated preference but preserves explicit External preference', () => {
    expect(resolveAgentChannelRuntime(agent({
      runtimePreference: { family: 'integrated', id: 'dsh' },
      providerId: 'anthropic-sub',
    }), channel())).toBe('builtin');
    expect(resolveAgentChannelRuntime(agent({
      runtimePreference: { family: 'integrated', id: 'dsh' },
      providerId: 'codex-sub',
    }), channel())).toBe('codex');
    expect(resolveAgentChannelRuntime(agent({
      runtimePreference: { family: 'external', id: 'claude-code' },
      providerId: 'codex-sub',
    }), channel())).toBe('claude-code');
  });

  it('ignores invalid system Runtime Channel history without weakening IM max agency', () => {
    const a = agent({ runtime: 'claude-code' });

    expect(resolveAgentChannelPermissionMode(a, channel())).toBe('bypassPermissions');
    expect(resolveAgentChannelPermissionMode(a, channel({
      overrides: { permissionMode: 'fullAgency' },
    }))).toBe('bypassPermissions');
  });

  it('ignores invalid managed Channel history without weakening IM max agency', () => {
    const a = agent({ providerId: 'codex-sub', runtime: 'builtin' });
    const ch = channel({ overrides: { permissionMode: 'full-auto' } });

    expect(resolveAgentChannelPermissionMode(a, ch)).toBe('fullAgency');
  });
});
