import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '../../../../shared/types/agent';
import ChannelWizard from './ChannelWizard';
import { modifyAgentChannelConfig, mutateChannelAccess } from '@/config/services/agentConfigService';

const runtime = vi.hoisted(() => ({ tauri: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', async original => ({ ...await original<typeof import('@tauri-apps/api/core')>(), invoke: runtime.invoke }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn() }));
beforeEach(() => { runtime.tauri = false; runtime.invoke.mockReset(); });
afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); });

const savedChannel = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/analytics', () => ({ track: vi.fn() }));
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => runtime.tauri }));
vi.mock('@/components/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({
    config: { agents: [] },
    refreshConfig: vi.fn(),
  }),
}));
vi.mock('@/config/services/agentConfigService', () => ({
  modifyAgentChannelConfig: vi.fn(async (_agentId, _channelId, modify, initialChannel, onPersisted) => {
    savedChannel.current = modify(savedChannel.current ?? initialChannel);
    onPersisted?.();
    return savedChannel.current;
  }),
  invokeStartAgentChannel: vi.fn(),
  patchAgentChannelOpenClawConfig: vi.fn().mockResolvedValue(undefined),
  mutateChannelAccess: vi.fn().mockResolvedValue(undefined),
}));

const agent: AgentConfig = {
  id: 'agent-1',
  name: 'Agent',
  enabled: true,
  permissionMode: 'auto',
  channels: [],
};

describe('ChannelWizard Feishu credential provisioning', () => {
  it('defaults the official Feishu plugin to QR provisioning with a manual fallback', () => {
    render(
      <ChannelWizard
        agent={agent}
        platform="openclaw:openclaw-lark"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('tab', { name: '扫码添加' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '手动配置' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('扫码创建机器人')).toBeInTheDocument();
    expect(screen.getByText(/将创建新的 飞书 机器人/)).toBeInTheDocument();
    expect(screen.queryByAltText('飞书开放平台 — 凭证与基础信息')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /下一步/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('tab', { name: '手动配置' }));

    expect(screen.getByRole('tab', { name: '扫码添加' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: '手动配置' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText(/appId/)).toBeInTheDocument();
    expect(screen.getByLabelText(/appSecret/)).toHaveAttribute('type', 'password');
    expect(screen.getByRole('link', { name: /前往飞书开放平台创建自建应用/ })).toHaveAttribute(
      'href',
      'https://open.feishu.cn/app',
    );
    expect(screen.getByAltText('飞书开放平台 — 凭证与基础信息')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/appId/), { target: { value: 'cli_app' } });
    fireEvent.change(screen.getByLabelText(/appSecret/), { target: { value: 'secret' } });
    expect(screen.getByRole('button', { name: /下一步/ })).toBeEnabled();
  });

  it('does not offer its initial channel again after a retry', async () => {
    savedChannel.current = undefined;
    vi.mocked(modifyAgentChannelConfig).mockClear();
    render(
      <ChannelWizard
        agent={agent}
        platform="feishu"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('cli_xxxxxxxxxx'), { target: { value: 'cli_app' } });
    fireEvent.change(screen.getByPlaceholderText('xxxxxxxxxxxxxxxxxxxxxxxx'), { target: { value: 'secret' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /下一步/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    await waitFor(() => expect(vi.mocked(modifyAgentChannelConfig)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(modifyAgentChannelConfig).mock.calls[0][3]).toMatchObject({ id: expect.any(String) });

    fireEvent.click(screen.getByRole('button', { name: /上一步|返回/ }));
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    await waitFor(() => expect(vi.mocked(modifyAgentChannelConfig)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(modifyAgentChannelConfig).mock.calls[1][3]).toBeUndefined();
  });

  it('does not offer initial creation after a save that committed then reported an error', async () => {
    savedChannel.current = undefined;
    const modify = vi.mocked(modifyAgentChannelConfig);
    modify.mockClear();
    modify.mockImplementationOnce(async (_agentId, _channelId, change, initialChannel, onPersisted) => {
      savedChannel.current = change(initialChannel!);
      onPersisted?.();
      throw new Error('Failed after config write');
    });
    render(
      <ChannelWizard
        agent={agent}
        platform="feishu"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('cli_xxxxxxxxxx'), { target: { value: 'cli_app' } });
    fireEvent.change(screen.getByPlaceholderText('xxxxxxxxxxxxxxxxxxxxxxxx'), { target: { value: 'secret' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /下一步/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    await waitFor(() => expect(modify).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /下一步/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    await waitFor(() => expect(modify).toHaveBeenCalledTimes(2));
    expect(modify.mock.calls[1][3]).toBeUndefined();
  });

  it('allows retry after the initial disk write failed', async () => {
    savedChannel.current = undefined;
    const modify = vi.mocked(modifyAgentChannelConfig);
    modify.mockClear();
    modify.mockRejectedValueOnce(new Error('Disk write failed'));
    render(
      <ChannelWizard
        agent={agent}
        platform="feishu"
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('cli_xxxxxxxxxx'), { target: { value: 'cli_app' } });
    fireEvent.change(screen.getByPlaceholderText('xxxxxxxxxxxxxxxxxxxxxxxx'), { target: { value: 'secret' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /下一步/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    await waitFor(() => expect(modify).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /下一步/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    await waitFor(() => expect(modify).toHaveBeenCalledTimes(2));
    expect(modify.mock.calls[1][3]).toMatchObject({ id: expect.any(String) });
  });
  it('can explicitly open a connected channel and finish with no bound users', async () => {
    savedChannel.current = undefined;
    const complete = vi.fn();
    render(<ChannelWizard agent={agent} platform="feishu" onComplete={complete} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('cli_xxxxxxxxxx'), { target: { value: 'cli_app' } });
    fireEvent.change(screen.getByPlaceholderText('xxxxxxxxxxxxxxxxxxxxxxxx'), { target: { value: 'secret' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /下一步/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /下一步/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    fireEvent.click(await screen.findByRole('button', { name: '自由模式' }));
    await waitFor(() => expect(mutateChannelAccess).toHaveBeenCalledWith(expect.any(String), { kind: 'setMode', mode: 'open' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /完成/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /完成/ }));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(savedChannel.current).toMatchObject({ setupCompleted: true, allowedUsers: [] });
  });

});

describe('ChannelWizard QR-bound WeChat', () => {
  it.each(['openclaw:openclaw-weixin', 'openclaw:weixin'] as const)('finishes %s after scanning without modes or another user binding', async platform => {
    runtime.tauri = true;
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: runtime.invoke } });
    savedChannel.current = undefined;
    vi.mocked(mutateChannelAccess).mockClear();
    runtime.invoke.mockImplementation(async command => {
      if (command === 'cmd_list_openclaw_plugins') return [];
      if (command === 'cmd_plugin_qr_login_start') return { ok: true, qrDataUrl: 'data:image/png;base64,AA==', sessionKey: 'fixture' };
      if (command === 'cmd_plugin_qr_login_wait') return { ok: true, connected: true, accountId: 'fixture-account' };
      return null;
    });
    const complete = vi.fn();
    render(<ChannelWizard agent={agent} platform={platform} onComplete={complete} onCancel={vi.fn()} />);
    const finish = await screen.findByRole('button', { name: /完成/ }, { timeout: 4000 });
    expect(screen.queryByRole('button', { name: '白名单模式' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '自由模式' })).not.toBeInTheDocument();
    expect(screen.queryByText('口令绑定')).not.toBeInTheDocument();
    fireEvent.click(finish);
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(mutateChannelAccess).not.toHaveBeenCalled();
    expect(savedChannel.current).not.toHaveProperty('accessMode');
  });
});
