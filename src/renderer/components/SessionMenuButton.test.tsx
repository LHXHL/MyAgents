import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ToastProvider } from './Toast';

const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  updateSession: vi.fn(),
  handoverSessionToChannel: vi.fn(),
  exportSessionAsMarkdown: vi.fn(),
}));

vi.mock('@/api/sessionClient', () => ({
  deleteSession: mocks.deleteSession,
  updateSession: mocks.updateSession,
}));

vi.mock('@/api/sessionHandoverClient', () => ({
  handoverSessionToChannel: mocks.handoverSessionToChannel,
}));

vi.mock('@/utils/sessionExport', () => ({
  exportSessionAsMarkdown: mocks.exportSessionAsMarkdown,
}));

import SessionMenuButton from './SessionMenuButton';
import type { BotChannelCandidate } from './SessionMenuButton';

const SESSION_ID = '642ea003-5219-4af7-a812-a9812d6e79de';

function renderMenu(overrides: Partial<ComponentProps<typeof SessionMenuButton>> = {}) {
  return render(
    <ToastProvider>
      <SessionMenuButton
        sessionId={SESSION_ID}
        sessionTitle="Test session"
        workspacePath="/Users/zhihu/Documents/project/MyAgents"
        boundChannel={null}
        availableChannels={[]}
        schedulerProtected={false}
        favorite={false}
        canRename
        onOpenRename={vi.fn()}
        onFavoriteChanged={vi.fn()}
        prepareCurrentSessionForDelete={vi.fn().mockResolvedValue(true)}
        {...overrides}
      />
    </ToastProvider>,
  );
}

describe('SessionMenuButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('shows a single-line SessionID row at the top of the menu', () => {
    renderMenu();

    fireEvent.click(screen.getByRole('button', { name: '对话操作' }));

    expect(screen.getByText('SessionID:')).toBeInTheDocument();
    expect(screen.getByText(SESSION_ID)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制 SessionID' })).toBeInTheDocument();
  });

  it('hides the trigger tooltip while the session menu is open', () => {
    renderMenu();

    expect(screen.getByText('对话操作')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '对话操作' }));

    expect(screen.queryByText('对话操作')).not.toBeInTheDocument();
    expect(screen.getByText('SessionID:')).toBeInTheDocument();
  });

  it('copies the AI-ready SessionID text', async () => {
    renderMenu();

    fireEvent.click(screen.getByRole('button', { name: '对话操作' }));
    fireEvent.click(screen.getByRole('button', { name: '复制 SessionID' }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`SessionID: ${SESSION_ID}`);
    });
  });

  it('hands over to the selected peer session instead of only the channel', async () => {
    const privateTarget: BotChannelCandidate = {
      agentId: 'agent-1',
      agentName: 'Mino',
      channelId: 'channel-1',
      channelType: 'openclaw:feishu',
      channelName: 'mino-bot',
      platformLabel: '飞书',
      sessionKey: 'agent:agent-1:openclaw:feishu:private:ou_target',
      sessionId: 'old-im-session',
      sourceType: 'private',
      sourceId: 'ou_target',
      sourceDisplayName: 'Ethan',
    };
    const groupTarget: BotChannelCandidate = {
      ...privateTarget,
      sessionKey: 'agent:agent-1:openclaw:feishu:group:oc_target',
      sourceType: 'group',
      sourceId: 'oc_target',
      sourceDisplayName: 'Product Crew',
    };
    mocks.handoverSessionToChannel.mockResolvedValue({
      ok: true,
      sessionKey: groupTarget.sessionKey,
      notified: true,
    });
    renderMenu({ availableChannels: [privateTarget, groupTarget] });

    fireEvent.click(screen.getByRole('button', { name: '对话操作' }));
    fireEvent.click(screen.getByRole('button', { name: /绑定聊天机器人/ }));
    fireEvent.click(screen.getByText('群聊 · Product Crew'));

    await waitFor(() => {
      expect(mocks.handoverSessionToChannel).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        agentId: groupTarget.agentId,
        channelId: groupTarget.channelId,
        sessionKey: groupTarget.sessionKey,
        workspacePath: '/Users/zhihu/Documents/project/MyAgents',
      });
    });
  });

  it('renders English chrome without translating channel/platform data', async () => {
    await i18n.changeLanguage('en-US');
    const groupTarget: BotChannelCandidate = {
      agentId: 'agent-1',
      agentName: 'Mino',
      channelId: 'channel-1',
      channelType: 'openclaw:feishu',
      channelName: 'mino-bot',
      platformLabel: '飞书',
      sessionKey: 'agent:agent-1:openclaw:feishu:group:oc_target',
      sessionId: 'old-im-session',
      sourceType: 'group',
      sourceId: 'oc_target',
      sourceDisplayName: 'Product Crew',
    };

    renderMenu({ availableChannels: [groupTarget] });

    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    fireEvent.click(screen.getByRole('button', { name: /Bind chat bot/ }));

    expect(screen.getByText('Group · Product Crew')).toBeInTheDocument();
    expect(screen.getByText('飞书')).toBeInTheDocument();
    expect(screen.getByText('mino-bot')).toBeInTheDocument();
  });

  it('moves the current tab off the session before deleting storage', async () => {
    const prepareCurrentSessionForDelete = vi.fn().mockResolvedValue(true);
    mocks.deleteSession.mockResolvedValue(true);
    renderMenu({ prepareCurrentSessionForDelete });

    fireEvent.click(screen.getByRole('button', { name: '对话操作' }));
    fireEvent.click(screen.getByText('删除对话'));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(prepareCurrentSessionForDelete).toHaveBeenCalledTimes(1);
      expect(mocks.deleteSession).toHaveBeenCalledWith(SESSION_ID);
    });
    expect(prepareCurrentSessionForDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteSession.mock.invocationCallOrder[0],
    );
  });

  it('does not delete storage when the current tab cannot move away from the session', async () => {
    const prepareCurrentSessionForDelete = vi.fn().mockResolvedValue(false);
    renderMenu({ prepareCurrentSessionForDelete });

    fireEvent.click(screen.getByRole('button', { name: '对话操作' }));
    fireEvent.click(screen.getByText('删除对话'));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(prepareCurrentSessionForDelete).toHaveBeenCalledTimes(1);
    });
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });
});
