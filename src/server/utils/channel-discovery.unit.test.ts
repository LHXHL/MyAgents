import { describe, expect, it, vi } from 'vitest';
import { projectConfiguredChannel, projectScopedChannels, readChannelIdentities } from './channel-discovery';
import { managementApi } from './management-api-client';

vi.mock('./management-api-client', () => ({ managementApi: vi.fn() }));

describe('CLI channel identity projection', () => {
  it('does not guess an offline plugin protocol from the installation name', () => {
    const input = { id: 'stopped-plugin', type: 'openclaw:custom-install', enabled: false };
    expect(projectConfiguredChannel(input, new Map())).toMatchObject({
      type: input.type, platform: null, pluginId: 'custom-install', enabled: false,
    });
    expect(projectScopedChannels([{ channelId: input.id, platform: input.type, targetTypes: [] }], new Map()))
      .toEqual([{ channelId: input.id, platform: null, pluginId: null, targetTypes: [] }]);
    for (const type of ['telegram', 'feishu', 'dingtalk']) {
      expect(projectConfiguredChannel({ id: type, type }, new Map())).toMatchObject({ platform: type, pluginId: null });
    }
  });

  it('uses registered identity by connection ID and leaves scoped execution input untouched', async () => {
    vi.mocked(managementApi).mockResolvedValue({ ok: true, channels: [
      { channelId: 'connection', platform: 'openclaw:custom-protocol', pluginId: 'custom-install' },
      { botId: 'stopped', platform: null, pluginId: 'other-install' },
    ] });
    const identities = await readChannelIdentities();
    const scoped = [{ channelId: 'connection', platform: 'openclaw:custom-install', mode: 'tool_only', targetTypes: [] }];
    expect(projectScopedChannels(scoped, identities)[0]).toMatchObject({ platform: 'openclaw:custom-protocol', pluginId: 'custom-install', mode: 'tool_only' });
    expect(scoped[0].platform).toBe('openclaw:custom-install');
    expect(projectConfiguredChannel({ id: 'stopped', type: 'openclaw:other-install' }, identities).platform).toBeNull();
  });

  it('honors the explicit installation ID in historical protocol-valued configs', () => {
    const channel = { id: 'legacy', type: 'openclaw:wecom', openclawPluginId: 'wecom-openclaw-plugin' };
    for (const identities of [new Map(), new Map([['legacy', { platform: 'openclaw:wecom', pluginId: channel.openclawPluginId }]])]) {
      expect(projectConfiguredChannel(channel, identities)).toMatchObject({
        type: 'openclaw:wecom', pluginId: 'wecom-openclaw-plugin',
      });
    }
  });

  it('keeps local config discovery usable when the runtime catalog is unavailable', async () => {
    vi.mocked(managementApi).mockResolvedValue({ ok: false, error: 'App unavailable' });
    const identities = await readChannelIdentities();
    expect(projectConfiguredChannel({ id: 'connection', type: 'openclaw:wecom-openclaw-plugin' }, identities))
      .toMatchObject({ id: 'connection', platform: null, pluginId: 'wecom-openclaw-plugin' });
  });
});
