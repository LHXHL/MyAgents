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
    workspacePath: '/tmp/workspace',
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

  it('respects an explicit channel permission override', () => {
    const a = agent({ permissionMode: 'fullAgency' });
    const ch = channel({ overrides: { permissionMode: 'plan' } });

    expect(resolveAgentChannelPermissionMode(a, ch)).toBe('plan');
    expect(resolveEffectiveConfig(a, ch).permissionMode).toBe('plan');
  });

  it('uses the selected runtime max permission when no channel override exists', () => {
    expect(resolveAgentChannelPermissionMode(agent({ runtime: 'codex' }), channel())).toBe('no-restrictions');
    expect(resolveAgentChannelPermissionMode(agent({ runtime: 'claude-code' }), channel())).toBe('bypassPermissions');
    expect(resolveAgentChannelPermissionMode(agent({ runtime: 'gemini' }), channel())).toBe('yolo');
  });

  it('lets channel runtime overrides control the default permission and runtimeConfig', () => {
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
    expect(effective.runtime).toBe('codex');
    expect(effective.permissionMode).toBe('no-restrictions');
    expect(effective.runtimeConfig).toEqual({ permissionMode: 'full-auto' });
  });

  it('projects the managed Codex subscription provider to Codex max permission', () => {
    const a = agent({ permissionMode: 'plan', runtime: 'builtin' });
    const ch = channel({
      overrides: {
        providerId: 'codex-sub',
        model: 'gpt-5.5-codex',
      },
    });

    const effective = resolveEffectiveConfig(a, ch);
    expect(effective.runtime).toBe('codex');
    expect(effective.permissionMode).toBe('no-restrictions');
  });
});
