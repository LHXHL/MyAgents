import { describe, expect, it } from 'vitest';
import { resolveAgentConfigMutation, mutationForAgentModelSelection } from './agentConfigMutation';
import type { AgentConfig } from './types/agent';

const agent: AgentConfig = { id: 'a', name: 'test', enabled: false, permissionMode: 'auto', runtime: 'codex', channels: [], runtimeConfig: { model: 'model-b', permissionMode: 'full-auto', envPolicy: { proxy: 'terminal' } } };

describe('Agent execution edits at the config writer', () => {
  it('changes only the requested field against latest state', () => {
    const patch = resolveAgentConfigMutation(agent, { runtimeConfigPatch: { reasoningEffort: 'high' } });
    expect(patch).toEqual({ runtimeConfig: { ...agent.runtimeConfig, reasoningEffort: 'high' } });
    expect(patch).not.toHaveProperty('runtimeConfigPatch');
  });
  it('scrubs runtime-specific values while retaining current environment policy', () => {
    const patch = resolveAgentConfigMutation(agent, { runtime: 'claude-code' });
    expect(patch.runtime).toBe('claude-code');
    expect(patch.runtimeConfig).toEqual({ envPolicy: { proxy: 'terminal' } });
  });
  it('keeps explicit full replacements distinct from field patches', () => {
    expect(resolveAgentConfigMutation(agent, { runtimeConfig: {} })).toEqual({ runtimeConfig: {} });
  });
  it('scrubs top-level DSH permissions when switching to Claude SDK', () => {
    const patch = resolveAgentConfigMutation({
      ...agent, runtime: 'dsh', permissionMode: 'full-autonomous',
    }, { runtime: 'builtin' });
    expect(patch).toMatchObject({ runtime: 'builtin', permissionMode: 'auto' });
    expect(patch.runtimeConfig).toEqual({ envPolicy: { proxy: 'terminal' } });
  });
  it('uses DSH permission keys when switching from Claude SDK', () => {
    const patch = resolveAgentConfigMutation({
      ...agent, runtime: 'builtin', permissionMode: 'fullAgency',
    }, { runtime: 'dsh' });
    expect(patch).toMatchObject({ runtime: 'dsh', permissionMode: 'approval-required' });
  });
  it('preserves an explicit valid permission selected with the target runtime', () => {
    expect(resolveAgentConfigMutation({
      ...agent, runtime: 'dsh', permissionMode: 'full-autonomous',
    }, { runtime: 'builtin', permissionMode: 'fullAgency' })).toMatchObject({
      runtime: 'builtin', permissionMode: 'fullAgency',
    });
  });
  it('resolves managed provider selection using the latest environment and product permission', () => {
    const patch = resolveAgentConfigMutation(agent, {
      runtimeBackedProviderSelection: { kind: 'runtime-backed-provider', providerId: 'codex-sub', model: 'model-c', runtime: 'codex', runtimeSource: 'managed-provider' },
      permissionMode: 'fullAgency',
    });
    expect(patch).toMatchObject({ providerId: 'codex-sub', runtime: 'builtin', permissionMode: 'fullAgency', model: 'model-c', runtimeConfig: { envPolicy: { proxy: 'terminal' } } });
    expect(patch.runtimeConfig).not.toHaveProperty('model');
  });
});

describe('IM model default intents against fresh Agent records', () => {
  it('preserves the latest CLI environment and permission while patching only model/effort', () => {
    const mutation = mutationForAgentModelSelection(agent, { kind: 'external-cli', runtime: 'codex', runtimeSource: 'system-cli', model: 'next' }, 'low');
    expect(resolveAgentConfigMutation(agent, mutation)).toEqual({ runtimeConfig: { ...agent.runtimeConfig, model: 'next', reasoningEffort: 'low' } });
  });
  it('refuses to copy native CLI models into another Agent default Runtime', () => {
    expect(() => mutationForAgentModelSelection({ ...agent, runtime: 'builtin' }, { kind: 'external-cli', runtime: 'codex', runtimeSource: 'system-cli', model: 'next' })).toThrow('Runtime');
  });
  it('restores authoritative DSH preference when leaving Managed Codex', () => {
    const current: AgentConfig = { ...agent, runtime: 'builtin', providerId: 'codex-sub', runtimePreference: { family: 'integrated', id: 'dsh' } };
    const mutation = mutationForAgentModelSelection(current, { kind: 'product-provider', providerId: 'deepseek', model: 'next' });
    expect(resolveAgentConfigMutation(current, mutation)).toMatchObject({ runtime: 'dsh', providerId: 'deepseek', model: 'next' });
    expect(current.providerId).toBe('codex-sub');
  });
});
