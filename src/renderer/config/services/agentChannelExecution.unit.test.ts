import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../types';
import type { ChannelConfig } from '../../../shared/types/agent';
const state = vi.hoisted(() => ({ config: {} as unknown, invoke: vi.fn() }));
vi.mock('./appConfigService', () => ({
  atomicModifyConfig: async (modify: (config: unknown) => unknown) => { state.config = modify(state.config); },
  loadAppConfig: vi.fn(), notifyConfigChanged: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }));
import { modifyAgentChannelConfig } from './agentConfigService';
const channel: ChannelConfig = { id: 'c', type: 'telegram', enabled: true,
  overrides: { model: 'legacy', runtime: 'codex', permissionMode: 'plan', toolsDeny: ['Bash'] } };
beforeEach(() => {
  vi.clearAllMocks();
  state.config = { agents: [{ id: 'a', name: 'Agent', enabled: true, permissionMode: 'auto', channels: [structuredClone(channel)] }] };
});
describe('Channel configuration writer', () => {
  it('preserves read-only legacy execution data and tool restrictions on transport edits', async () => {
    const result = await modifyAgentChannelConfig('a', 'c', current => ({ ...current, name: 'Renamed', allowedUsers: ['user'] }));
    expect(result.overrides).toEqual(channel.overrides);
    expect(result.allowedUsers).toEqual(['user']);
    expect((state.config as AppConfig).agents![0].channels[0]).toEqual(result);
  });
  it.each(['model', 'providerId', 'runtime', 'runtimePreference', 'runtimeConfig', 'permissionMode'] as const)('rejects new execution override %s before committing config', async key => {
    const before = structuredClone(state.config);
    await expect(modifyAgentChannelConfig('a', 'c', current => ({ ...current,
      overrides: { ...current.overrides, [key]: 'changed' } }))).rejects.toThrow('no longer supported');
    expect(state.config).toEqual(before); expect(state.invoke).not.toHaveBeenCalled();
  });
  it('still permits changing Channel tool restrictions', async () => {
    await modifyAgentChannelConfig('a', 'c', current => ({ ...current, overrides: { ...current.overrides, toolsDeny: [] } }));
    expect((state.config as AppConfig).agents![0].channels[0].overrides?.toolsDeny).toEqual([]);
  });
  it('rejects execution fields supplied in an initial channel or legacy root shape', async () => {
    const before = structuredClone(state.config);
    await expect(modifyAgentChannelConfig('a', 'new', current => current,
      { ...channel, id: 'new' })).rejects.toThrow('no longer supported');
    await expect(modifyAgentChannelConfig('a', 'c', current => ({ ...current, model: 'root-model' })))
      .rejects.toThrow('no longer supported');
    expect(state.config).toEqual(before); expect(state.invoke).not.toHaveBeenCalled();
  });
});
