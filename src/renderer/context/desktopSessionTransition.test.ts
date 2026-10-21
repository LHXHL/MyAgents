import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { transitionDesktopSession } from './desktopSessionTransition';

const mocks = {
  newDesktopSession: vi.fn(),
  adoptMigratedSession: vi.fn(),
  releaseMigratedTabOwner: vi.fn(),
  reportError: vi.fn(),
};

function runTransition() {
  return transitionDesktopSession({
    sessionId: 'old-session',
    tabId: 'tab-1',
    newDesktopSession: mocks.newDesktopSession,
    adoptMigratedSession: mocks.adoptMigratedSession,
    releaseMigratedTabOwner: mocks.releaseMigratedTabOwner,
    reportError: mocks.reportError,
  });
}

describe('transitionDesktopSession', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    vi.clearAllMocks();
    mocks.adoptMigratedSession.mockResolvedValue(true);
    mocks.releaseMigratedTabOwner.mockResolvedValue(false);
  });

  it('adopts the migrated channel session without plain reset', async () => {
    mocks.newDesktopSession.mockResolvedValue({ newSessionId: 'new-session', createNewSidecar: false });

    await expect(runTransition()).resolves.toBe(true);

    expect(mocks.newDesktopSession).toHaveBeenCalledWith({
      oldSessionId: 'old-session',
      tabId: 'tab-1',
    });
    expect(mocks.adoptMigratedSession).toHaveBeenCalledWith('new-session', { sidecarAlreadyMigrated: true, newConversation: true });
    expect(mocks.releaseMigratedTabOwner).not.toHaveBeenCalled();
  });

  it('fails closed when migration returns no target', async () => {
    mocks.newDesktopSession.mockResolvedValue({ newSessionId: null, createNewSidecar: false });

    await expect(runTransition()).resolves.toBe(false);

    expect(mocks.adoptMigratedSession).not.toHaveBeenCalled();
    expect(mocks.releaseMigratedTabOwner).not.toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalledWith('新对话创建失败');
  });

  it('releases the migrated Tab owner when renderer adoption is refused', async () => {
    mocks.newDesktopSession.mockResolvedValue({ newSessionId: 'new-session', createNewSidecar: false });
    mocks.adoptMigratedSession.mockResolvedValue(false);

    await expect(runTransition()).resolves.toBe(false);

    expect(mocks.releaseMigratedTabOwner).toHaveBeenCalledWith('new-session', 'tab-1');
    expect(mocks.reportError).toHaveBeenCalledWith('新对话创建失败');
  });

  it('fails closed without owner cleanup when migration never committed', async () => {
    mocks.newDesktopSession.mockRejectedValue(new Error('offline'));

    await expect(runTransition()).resolves.toBe(false);

    expect(mocks.releaseMigratedTabOwner).not.toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalledWith('新对话创建失败');
  });
  it('consumes admitted background completion even when the old turn finishes before the UI callback', async () => {
    const background = vi.fn(async () => true);
    mocks.newDesktopSession.mockResolvedValue({ newSessionId: null, createNewSidecar: true });
    await expect(transitionDesktopSession({
      sessionId: 'busy-source', tabId: 'tab-1', ...mocks,
      onNewSidecar: background,
      releaseMigratedTabOwner: mocks.releaseMigratedTabOwner,
    })).resolves.toBe(true);
    expect(background).toHaveBeenCalledWith('busy-source');
    expect(mocks.adoptMigratedSession).not.toHaveBeenCalled();
    expect(mocks.releaseMigratedTabOwner).not.toHaveBeenCalled();
  });

  it('opens separately for a retained source without adopting or releasing that source', async () => {
    const openNew = vi.fn(async () => true);
    mocks.newDesktopSession.mockResolvedValue({ newSessionId: null, createNewSidecar: true });
    await expect(transitionDesktopSession({
      sessionId: 'channel-or-task-source', tabId: 'tab-1', ...mocks,
      onNewSidecar: openNew,
    })).resolves.toBe(true);
    expect(openNew).toHaveBeenCalledWith('channel-or-task-source');
    expect(mocks.adoptMigratedSession).not.toHaveBeenCalled();
    expect(mocks.releaseMigratedTabOwner).not.toHaveBeenCalled();
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it('uses each committed source for consecutive new conversations without channel polling', async () => {
    let current = 'a';
    const sources: string[] = [];
    for (const next of ['b', 'c']) {
      await expect(transitionDesktopSession({
        sessionId: current, tabId: 'tab-1',
        newDesktopSession: async args => { sources.push(args.oldSessionId); return { newSessionId: next, createNewSidecar: false }; },
        adoptMigratedSession: async id => { current = id; return true; },
        releaseMigratedTabOwner: mocks.releaseMigratedTabOwner,
        reportError: mocks.reportError,
      })).resolves.toBe(true);
    }
    expect(sources).toEqual(['a', 'b']);
    expect(current).toBe('c');
  });

});
