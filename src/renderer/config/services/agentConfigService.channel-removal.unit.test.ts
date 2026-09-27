import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../types';

const state = vi.hoisted(() => ({ current: undefined as unknown, stopError: false }));
const invoke = vi.hoisted(() => vi.fn(async (command: string) => {
  if (command === 'cmd_stop_agent_channel') {
    const agents = (state.current as AppConfig).agents ?? [];
    expect(agents[0].channels).toEqual([]);
    if (state.stopError) throw new Error('bridge stop failed');
  }
}));

vi.mock('./appConfigService', () => ({
  atomicModifyConfig: vi.fn(async (modify: (config: AppConfig) => AppConfig) => {
    state.current = modify(state.current as AppConfig);
    return state.current;
  }),
}));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { removeAgentChannelConfig } from './agentConfigService';

describe('Agent Channel deletion intent', () => {
  beforeEach(() => {
    state.stopError = false;
    invoke.mockClear();
    state.current = {
      defaultPermissionMode: 'auto', themeId: 'myagents-default', appearanceMode: 'system',
      minimizeToTray: true, showDevTools: false, autoStart: false,
      osNotifications: true, notificationSound: true,
      agents: [{
      id: 'agent-1', name: 'Agent', enabled: true, permissionMode: 'auto', channels: [
        { id: 'channel-1', type: 'openclaw:openclaw-lark', enabled: true },
      ],
      }],
    } satisfies AppConfig;
  });

  it('removes the disk intent before stopping the exact runtime', async () => {
    await removeAgentChannelConfig('agent-1', 'channel-1');
    expect(invoke).toHaveBeenCalledWith('cmd_stop_agent_channel', {
      agentId: 'agent-1', channelId: 'channel-1',
    });
  });

  it('reports a partial failure when shutdown fails after durable removal', async () => {
    state.stopError = true;
    await expect(removeAgentChannelConfig('agent-1', 'channel-1'))
      .rejects.toThrow('bridge stop failed');
    expect((state.current as AppConfig).agents?.[0].channels).toEqual([]);
  });
});
