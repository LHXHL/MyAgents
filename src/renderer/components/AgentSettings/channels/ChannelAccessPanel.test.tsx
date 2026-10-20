import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelConfig } from '../../../../shared/types/agent';
import ChannelAccessPanel, { ChannelUserList } from './ChannelAccessPanel';
import GroupPermissionList from '../../ImSettings/components/GroupPermissionList';

const mutate = vi.hoisted(() => vi.fn());
vi.mock('@/config/services/agentConfigService', () => ({ mutateChannelAccess: mutate }));
const channel: ChannelConfig = { id: 'channel-1', type: 'telegram', enabled: false, allowedUsers: ['123', 'old_username'], userDisplayNames: { '123': 'Alice' }, blockedUserIds: ['456'] };
beforeEach(() => { mutate.mockReset().mockResolvedValue(undefined); });

describe('channel access controls', () => {
  it('keeps missing mode unset until an explicit selection, including review', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<ChannelAccessPanel channel={channel} refresh={refresh} />);
    expect(screen.getByText(/尚未设置，沿用当前渠道/)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '审核使用' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(mutate).toHaveBeenCalledWith('channel-1', { kind: 'setMode', mode: 'review' });
  });

  it('keeps the saved snapshot visible while pending and retains it on failure', async () => {
    let reject!: (reason: Error) => void;
    mutate.mockImplementation(() => new Promise((_resolve, failure) => { reject = failure; }));
    const refresh = vi.fn();
    render(<ChannelAccessPanel channel={channel} refresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: '自由使用' }));
    expect(screen.getByRole('button', { name: '自由使用' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '审核使用' })).toHaveAttribute('aria-pressed', 'true');
    reject(new Error('disk unavailable'));
    expect(await screen.findByRole('alert')).toHaveTextContent('disk unavailable');
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '审核使用' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps all users and blocking actions without filters or ID controls', async () => {
    render(<ChannelUserList channel={channel} refresh={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByText('Alice（123）')).toBeInTheDocument();
    expect(screen.getByText('私聊用户')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '按 ID 拉黑' })).not.toBeInTheDocument();
    expect(screen.getByText('456')).toBeInTheDocument();
    const username = screen.getByText('old_username').closest('li')!;
    expect(within(username).getByRole('button', { name: '拉黑' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '解除拉黑' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('channel-1', { kind: 'setUserBlocked', userId: '456', blocked: false }));
  });

  it('removes the original user ID with the renamed action', async () => {
    render(<ChannelUserList channel={channel} refresh={vi.fn().mockResolvedValue(undefined)} />);
    const row = screen.getByText('Alice（123）').closest('li')!;
    expect(screen.queryByText('移除资格')).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('channel-1', { kind: 'removeUser', userId: '123' }));
  });

  it('reports durable success separately from a failed refresh', async () => {
    render(<ChannelAccessPanel channel={channel} refresh={vi.fn().mockRejectedValue(new Error('refresh unavailable'))} />);
    fireEvent.click(screen.getByRole('button', { name: '自由使用' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('已保存，但配置刷新失败');
  });

  it('shows discovered groups accurately in open mode and can unblock removed groups', async () => {
    const block = vi.fn().mockResolvedValue(undefined);
    render(<GroupPermissionList permissions={[{ groupId: 'g1', groupName: 'Team', platform: 'telegram', status: 'pending', discoveredAt: '' }]}
      openAccess blockedGroupIds={['removed-group']} onBlockChange={block} onApprove={vi.fn()} onReject={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('已发现，尚未使用')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '解除拉黑' }));
    await waitFor(() => expect(block).toHaveBeenCalledWith('removed-group', false));
  });
});
