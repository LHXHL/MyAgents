import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, ChannelConfig } from '../../../../shared/types/agent';
import type { GroupPermission, ImPlatform } from '../../../../shared/types/im';
import ChannelDetailView from './ChannelDetailView';
import GroupPermissionList from '../../ImSettings/components/GroupPermissionList';

const mocks = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => false }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ config: { agents: [] }, refreshConfig: vi.fn() }) }));
vi.mock('@/config/services/agentConfigService', async importOriginal => ({
  ...await importOriginal<typeof import('@/config/services/agentConfigService')>(),
  patchAgentChannelConfig: mocks.patch,
}));

function showChannel(type: ChannelConfig['type'], groupActivation: 'mention' | 'always' = 'mention') {
  const agent: AgentConfig = {
    id: 'test-agent', name: 'Agent', enabled: false, permissionMode: 'auto',
    channels: [{ id: 'test-channel', type, enabled: false, allowedUsers: [], groupActivation }],
  };
  render(<ChannelDetailView agent={agent} channelId="test-channel" onBack={vi.fn()} onChanged={vi.fn()} />);
  const groups = screen.queryByRole('button', { name: '群聊管理' });
  if (groups) fireEvent.click(groups);
}

beforeEach(() => mocks.patch.mockReset());

describe('group activation settings', () => {
  it.each(['openclaw:openclaw-weixin', 'openclaw:weixin'] as const)('%s has no group controls', type => {
    showChannel(type);
    expect(screen.queryByRole('button', { name: '群聊管理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '全部消息' })).not.toBeInTheDocument();
  });

  it.each(['openclaw:wecom-openclaw-plugin', 'openclaw:wecom', 'openclaw:qqbot', 'dingtalk'] as const)(
    '%s cannot select all messages even with a previously saved always setting', type => {
      showChannel(type, 'always');
      expect(screen.getByText('此渠道仅接收 @机器人 的群消息，不支持全部消息')).toBeInTheDocument();
      const all = screen.getByRole('button', { name: '全部消息' });
      expect(all).toBeDisabled();
      fireEvent.click(all);
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '@提及' })).toBeEnabled();
    },
  );

  it.each(['telegram', 'feishu', 'openclaw:openclaw-lark', 'openclaw:custom-plugin'] as const)(
    '%s keeps the existing all-message setting', async type => {
      showChannel(type);
      const all = screen.getByRole('button', { name: '全部消息' });
      expect(all).toBeEnabled();
      fireEvent.click(all);
      await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('test-agent', 'test-channel', { groupActivation: 'always' }));
    },
  );
});

describe.each(['pending', 'approved'] as const)('%s group platform labels', status => {
  it.each([
    ['openclaw:wecom-openclaw-plugin', '企业微信'], ['openclaw:wecom', '企业微信'],
    ['telegram', 'Telegram'], ['dingtalk', '钉钉'], ['feishu', '飞书'],
    ['openclaw:openclaw-lark', '飞书'], ['openclaw:custom-plugin', 'custom-plugin'],
  ] as const)('labels %s as %s', (platform: ImPlatform, label) => {
    const permissions: GroupPermission[] = [{ groupId: 'test-group', groupName: 'Test group', platform, status, discoveredAt: '2026-10-18T00:00:00Z' }];
    render(<GroupPermissionList permissions={permissions} onApprove={vi.fn()} onReject={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    if (label !== '飞书') expect(screen.queryByText('飞书')).not.toBeInTheDocument();
  });
});
