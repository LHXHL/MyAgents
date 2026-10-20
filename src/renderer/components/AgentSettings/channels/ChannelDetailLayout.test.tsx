import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, ChannelConfig } from '../../../../shared/types/agent';
import ChannelDetailView from './ChannelDetailView';
import BindCodePanel from '../../ImSettings/components/BindCodePanel';
import BindQrPanel from '../../ImSettings/components/BindQrPanel';

const mocks = vi.hoisted(() => ({ tauri: false, invoke: vi.fn(), mutate: vi.fn() }));
vi.mock('@tauri-apps/api/core', async original => ({ ...await original<typeof import('@tauri-apps/api/core')>(), invoke: mocks.invoke }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn() }));
vi.mock('@/config/services/agentConfigService', async original => ({ ...await original<typeof import('@/config/services/agentConfigService')>(), mutateChannelAccess: mocks.mutate }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => mocks.tauri }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ config: { agents: [] }, refreshConfig: vi.fn() }) }));

beforeEach(() => { mocks.tauri = false; mocks.mutate.mockReset().mockResolvedValue(undefined); mocks.invoke.mockReset().mockResolvedValue(null); });

function show(type: ChannelConfig['type'] = 'openclaw:wecom') {
  const agent: AgentConfig = { id: 'a', name: 'Agent', enabled: false, permissionMode: 'auto', channels: [{ id: 'c', type, enabled: false, allowedUsers: ['u'], userDisplayNames: { u: 'Alice' } }] };
  return render(<ChannelDetailView agent={agent} channelId="c" onBack={vi.fn()} onChanged={vi.fn()} />);
}

function expectBefore(first: Element, second: Element) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe('Channel detail layout', () => {
  it('separates permission mode, expands user management and orders the management blocks', () => {
    show();
    const permission = screen.getByRole('region', { name: '权限模式' });
    expect(within(permission).queryByText('Alice（u）')).not.toBeInTheDocument();
    const users = screen.getByRole('button', { name: '用户管理' });
    expect(users).toHaveAttribute('aria-expanded', 'true');
    const userBody = document.getElementById(users.getAttribute('aria-controls')!)!;
    expect(within(userBody).getByText('Alice（u）')).toBeInTheDocument();
    expect(within(userBody).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(userBody).queryByRole('textbox')).not.toBeInTheDocument();
    expectBefore(permission, users);
    expectBefore(screen.getByText('启动渠道后可使用绑定入口。'), screen.getByRole('region', { name: '私聊用户' }));
    expectBefore(screen.getByRole('region', { name: '私聊用户' }), screen.getByRole('button', { name: '群聊管理' }));
    expectBefore(screen.getByRole('button', { name: '群聊管理' }), screen.getByRole('heading', { name: '消息发送方式' }));
    fireEvent.click(users);
    expect(users).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Alice（u）')).not.toBeVisible();
    fireEvent.click(users);
    expect(screen.getByText('Alice（u）')).toBeInTheDocument();
  });

  it('retains pending row actions and errors across collapse and reopen', async () => {
    let reject!: (reason: Error) => void;
    mocks.mutate.mockImplementation(() => new Promise((_resolve, failure) => { reject = failure; }));
    show();
    fireEvent.click(screen.getByRole('button', { name: '拉黑' }));
    const users = screen.getByRole('button', { name: '用户管理' });
    fireEvent.click(users);
    fireEvent.click(users);
    expect(screen.getByRole('button', { name: '拉黑' })).toBeDisabled();
    reject(new Error('保存失败'));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
    expect(screen.getByRole('button', { name: '拉黑' })).toBeEnabled();
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });

  it('embeds a running QR-login entry before the user list without another card', async () => {
    mocks.tauri = true;
    mocks.invoke.mockImplementation(async command => command === 'cmd_agent_channel_status' ? {
      channelId: 'c', channelType: 'openclaw:openclaw-weixin', status: 'online', uptimeSeconds: 0,
      activeSessions: [], restartCount: 0, bufferedMessages: 0,
    } : null);
    show('openclaw:openclaw-weixin');
    const login = await screen.findByRole('button', { name: '扫码登录' });
    const userBody = document.getElementById(screen.getByRole('button', { name: '用户管理' }).getAttribute('aria-controls')!)!;
    expect(userBody).toContainElement(login);
    expectBefore(login, screen.getByRole('region', { name: '私聊用户' }));
    expect(login.closest('.border-dashed')).toBeNull();
    await waitFor(() => expect(screen.queryByText('启动渠道后可使用绑定入口。')).not.toBeInTheDocument());
  });

  it.each(['telegram', 'dingtalk'] as const)('puts %s sending options inside the final delivery block', type => {
    show(type);
    const delivery = screen.getByRole('heading', { name: '消息发送方式' }).closest('section')!;
    expectBefore(screen.getByRole('button', { name: '群聊管理' }), delivery);
    expect(within(delivery).getByText(type === 'telegram' ? 'Draft 流式模式' : 'AI Card 流式回复')).toBeInTheDocument();
    expectBefore(delivery, screen.getByRole('button', { name: /删除/ }));
  });

  it('keeps private-only channels free of group controls', () => {
    show('openclaw:openclaw-weixin');
    expect(screen.getByRole('region', { name: '私聊用户' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '群聊管理' })).not.toBeInTheDocument();
  });

  it('embeds binding content without changing default wizard card presentation', () => {
    const { container, rerender } = render(<BindCodePanel bindCode="BIND_FIXTURE" hasWhitelistUsers embedded />);
    expect(container.firstElementChild).not.toHaveClass('border');
    expect(screen.getByText('口令绑定')).toBeInTheDocument();
    expect(screen.getByTitle('复制口令')).toBeInTheDocument();
    rerender(<BindCodePanel bindCode="BIND_FIXTURE" hasWhitelistUsers />);
    expect(container.firstElementChild).toHaveClass('border');
    rerender(<BindQrPanel bindUrl="https://t.me/fixture?start=BIND_fixture" hasWhitelistUsers embedded />);
    expect(container.firstElementChild).not.toHaveClass('border');
    rerender(<BindQrPanel bindUrl="https://t.me/fixture?start=BIND_fixture" hasWhitelistUsers />);
    expect(container.firstElementChild).toHaveClass('border');
  });
});
