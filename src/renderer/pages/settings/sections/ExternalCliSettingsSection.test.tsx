import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { i18n } from '@/i18n';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  copyPlainText: vi.fn(async (_value: string) => undefined),
  listener: undefined as undefined | (() => void),
  listenWithCleanup: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: mocks.listenWithCleanup,
}));
vi.mock('@/utils/clipboard', () => ({ copyPlainText: mocks.copyPlainText }));

import { ExternalCliSettingsSection } from './ExternalCliSettingsSection';

function renderSection() {
  return render(
    <ToastProvider>
      <ExternalCliSettingsSection />
    </ToastProvider>,
  );
}

describe('ExternalCliSettingsSection', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.listener = undefined;
    mocks.listenWithCleanup.mockImplementation(
      async (_event: string, listener: () => void) => {
        mocks.listener = listener;
        return { unlisten: vi.fn(), isRegistered: () => true };
      },
    );
    await i18n.changeLanguage('en-US');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'cmd_get_external_cli_access') {
        return {
          enabled: false,
          launcherPath: '/Applications/MyAgents/myagents',
          skillPath: '/Users/test/.myagents/external-myagents-cli/SKILL.md',
          skillReady: true,
        };
      }
      if (command === 'cmd_set_external_cli_enabled') {
        return {
          enabled: true,
          token: 'mae_test_token',
          createdAt: '2026-09-19T00:00:00.000Z',
          launcherPath: '/Applications/MyAgents/myagents',
          skillPath: '/Users/test/.myagents/external-myagents-cli/SKILL.md',
          skillReady: true,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
  });

  it('refreshes from the Rust authority when another window changes access', async () => {
    mocks.invoke.mockResolvedValueOnce({
      enabled: false,
      launcherPath: '/Applications/MyAgents/myagents',
      skillPath: '/Users/test/.myagents/external-myagents-cli/SKILL.md',
      skillReady: true,
    });
    renderSection();

    const toggle = await screen.findByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(mocks.listener).toBeTypeOf('function'));

    mocks.invoke.mockResolvedValueOnce({
      enabled: true,
      token: 'mae_from_other_window',
      createdAt: '2026-09-19T00:00:00.000Z',
      launcherPath: '/Applications/MyAgents/myagents',
      skillPath: '/Users/test/.myagents/external-myagents-cli/SKILL.md',
      skillReady: true,
    });
    mocks.listener?.();

    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      'cmd_get_external_cli_access',
    );
  });

  it('catches up when a change is emitted before listener registration completes', async () => {
    let completeRegistration: (() => void) | undefined;
    mocks.listenWithCleanup.mockImplementation(
      (_event: string, listener: () => void) => {
        mocks.listener = listener;
        return new Promise((resolve) => {
          completeRegistration = () =>
            resolve({ unlisten: vi.fn(), isRegistered: () => true });
        });
      },
    );
    mocks.invoke
      .mockResolvedValueOnce({
        enabled: false,
        launcherPath: '/Applications/MyAgents/myagents',
        skillPath: '/Users/test/.myagents/external-myagents-cli/SKILL.md',
        skillReady: true,
      })
      .mockResolvedValueOnce({
        enabled: true,
        token: 'mae_missed_event',
        createdAt: '2026-09-19T00:00:00.000Z',
        launcherPath: '/Applications/MyAgents/myagents',
        skillPath: '/Users/test/.myagents/external-myagents-cli/SKILL.md',
        skillReady: true,
      });

    renderSection();
    const toggle = await screen.findByRole('switch');
    await waitFor(() =>
      expect(toggle).toHaveAttribute('aria-checked', 'false'),
    );

    completeRegistration?.();

    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('loads disabled by default and enables through the Rust owner', async () => {
    const user = userEvent.setup();
    renderSection();

    const toggle = await screen.findByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Prompt for another AI')).toBeInTheDocument();
    expect(screen.queryByText('mae_test_token')).not.toBeInTheDocument();

    await user.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(mocks.invoke).toHaveBeenCalledWith('cmd_set_external_cli_enabled', {
      enabled: true,
    });
    expect(screen.getByLabelText('Show token')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Show token'));
    expect(screen.getByText('mae_test_token')).toBeInTheDocument();
  });

  it('keeps the rendered prompt redacted and injects the active token only when copied', async () => {
    const user = userEvent.setup();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'cmd_get_external_cli_access') {
        return {
          enabled: true,
          token: 'mae_real_secret_must_not_leak',
          createdAt: '2026-09-19T00:00:00.000Z',
          launcherPath: '/Users/test/.myagents/bin/myagents',
          skillPath: '/Users/test/.myagents/external-myagents-cli/SKILL.md',
          skillReady: true,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    await i18n.changeLanguage('zh-CN');
    renderSection();

    expect(await screen.findByText('MYAGENTS_API_TOKEN')).toBeInTheDocument();
    expect(
      screen.getByText(/export MYAGENTS_API_TOKEN="<token>"/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/mae_real_secret_must_not_leak/),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: '复制 Prompt' }),
    );

    const copied = mocks.copyPlainText.mock.calls.at(-1)?.[0] as string;
    expect(copied).toBe(
      '请先阅读本机文件 "/Users/test/.myagents/external-myagents-cli/SKILL.md"，并严格按照其中的公开 CLI 契约操作 MyAgents。\n\n' +
        '本机 MyAgents CLI 完整路径是："/Users/test/.myagents/bin/myagents"\n\n' +
        '请将 MYAGENTS_API_TOKEN 注入到环境变量：`export MYAGENTS_API_TOKEN="mae_real_secret_must_not_leak"`',
    );
    expect(copied).not.toContain('<token>');
  });

  it('shows the security warning in the access card only while enabled', async () => {
    const user = userEvent.setup();
    renderSection();

    expect(
      screen.queryByText(/A local program holding MYAGENTS_API_TOKEN/),
    ).not.toBeInTheDocument();

    await user.click(await screen.findByRole('switch'));

    const warning = await screen.findByText(
      /A local program holding MYAGENTS_API_TOKEN/,
    );
    const accessHeading = screen.getByText('MyAgents CLI external access');
    const promptHeading = screen.getByText('Prompt for another AI');

    expect(warning.closest('section')).toBe(accessHeading.closest('section'));
    expect(warning.closest('section')).not.toBe(promptHeading.closest('section'));
  });

  it('does not expose a copy action before absolute paths are loaded', () => {
    mocks.invoke.mockImplementation(() => new Promise(() => undefined));

    renderSection();

    expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull();
    expect(
      screen.getByText('Reading the local guide and CLI paths…'),
    ).toBeInTheDocument();
  });

  it('hides a previously loaded prompt while authority refresh is pending', async () => {
    renderSection();
    expect(
      await screen.findByRole('button', { name: 'Copy prompt' }),
    ).toBeInTheDocument();

    mocks.invoke.mockImplementation(() => new Promise(() => undefined));
    mocks.listener?.();

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull(),
    );
    expect(
      screen.getByText('Reading the local guide and CLI paths…'),
    ).toBeInTheDocument();
  });

  it('keeps a stale prompt hidden when an authority refresh fails', async () => {
    renderSection();
    expect(
      await screen.findByRole('button', { name: 'Copy prompt' }),
    ).toBeInTheDocument();

    mocks.invoke.mockRejectedValue(new Error('read failed'));
    mocks.listener?.();

    expect(
      await screen.findByText(
        'The local invocation paths could not be loaded. Try again shortly.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull();
  });

  it('keeps access controls usable when the guide projection is unavailable', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'cmd_get_external_cli_access') {
        return {
          enabled: true,
          token: 'mae_existing_token',
          createdAt: '2026-09-19T00:00:00.000Z',
          launcherPath: '/Users/test/.myagents/bin/myagents',
          skillPath: '/Users/test/.myagents/external-myagents-cli/SKILL.md',
          skillReady: false,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    renderSection();

    expect(await screen.findByLabelText('Show token')).toBeInTheDocument();
    expect(
      screen.getByText(/external CLI guide is temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull();
  });

  it('anchors the toggle thumb inside the fixed-width settings track', async () => {
    renderSection();

    const toggle = await screen.findByRole('switch');
    expect(toggle).toHaveClass('h-6', 'w-11', 'shrink-0');
    expect(toggle.querySelector('span')).toHaveClass(
      'left-0.5',
      'top-0.5',
      'translate-x-0',
      'bg-[var(--toggle-thumb)]',
    );
  });
});
