import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

describe.each(['pending', 'approved'] as const)('%s group rows', status => {
  it.each([
    ['openclaw:wecom-openclaw-plugin', '企业微信'], ['telegram', 'Telegram'],
    ['dingtalk', '钉钉'], ['feishu', '飞书'], ['openclaw:custom-plugin', 'custom-plugin'],
  ] as const)('shows name and ID for %s without platform or redundant labels', (platform: ImPlatform, label) => {
    const permissions: GroupPermission[] = [{ groupId: 'test-group', groupName: 'Test group', platform, status, discoveredAt: '' }];
    render(<GroupPermissionList permissions={permissions} onBlockChange={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Test group（test-group）')).toBeInTheDocument();
    expect(screen.queryByText(label)).not.toBeInTheDocument();
    expect(screen.queryByText('已授权群聊')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const row = screen.getByText('Test group（test-group）').parentElement!;
    expect(within(row).getByRole('button', { name: '拉黑' })).toBeVisible();
    if (status === 'approved') {
      expect(within(row).getByRole('button', { name: '移除' })).toBeVisible();
      expect(within(row).getAllByRole('button')).toHaveLength(2);
    } else {
      expect(within(row).getByRole('button', { name: '允许' })).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: '拒绝' })).toBeInTheDocument();
    }
  });

  it.each(['', '  ', 'g'])('leaves missing or legacy ID-only name blank: %s', name => {
    render(<GroupPermissionList permissions={[{ groupId: 'g', groupName: name, platform: 'openclaw:wecom', status, discoveredAt: '' }]} onApprove={vi.fn()} onReject={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('（g）')).toBeInTheDocument();
  });
});

describe('group actions', () => {
  it('uses exact IDs and retains loading/error feedback for direct removal', async () => {
    let reject!: (reason: Error) => void;
    const remove = vi.fn(() => new Promise<void>((_resolve, failure) => { reject = failure; }));
    const block = vi.fn().mockResolvedValue(undefined);
    render(<GroupPermissionList permissions={[{ groupId: 'g', groupName: 'Team', platform: 'openclaw:wecom', status: 'approved', discoveredAt: '' }]} onBlockChange={block} onApprove={vi.fn()} onReject={vi.fn()} onRemove={remove} />);
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    expect(remove).toHaveBeenCalledWith('g');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '移除' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '拉黑' })).toBeDisabled();
    reject(new Error('remove failed'));
    expect(await screen.findByRole('alert')).toHaveTextContent('remove failed');
    expect(screen.getByRole('button', { name: '移除' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '拉黑' }));
    await waitFor(() => expect(block).toHaveBeenCalledWith('g', true));
  });
});
