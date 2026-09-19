import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import { i18n } from '@/i18n';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  copyPlainText: vi.fn(async () => undefined),
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
    mocks.listenWithCleanup.mockImplementation(async (
      _event: string,
      listener: () => void,
    ) => {
      mocks.listener = listener;
      return { unlisten: vi.fn(), isRegistered: () => true };
    });
    await i18n.changeLanguage('en-US');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'cmd_get_external_cli_access') {
        return {
          enabled: false,
          launcherPath: '/Applications/MyAgents/myagents',
        };
      }
      if (command === 'cmd_set_external_cli_enabled') {
        return {
          enabled: true,
          token: 'mae_test_token',
          createdAt: '2026-09-19T00:00:00.000Z',
          launcherPath: '/Applications/MyAgents/myagents',
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
  });

  it('refreshes from the Rust authority when another window changes access', async () => {
    mocks.invoke.mockResolvedValueOnce({
      enabled: false,
      launcherPath: '/Applications/MyAgents/myagents',
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
      })
      .mockResolvedValueOnce({
        enabled: true,
        token: 'mae_missed_event',
        createdAt: '2026-09-19T00:00:00.000Z',
        launcherPath: '/Applications/MyAgents/myagents',
      });

    renderSection();
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));

    completeRegistration?.();

    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('loads disabled by default, enables through the Rust owner, and exposes the fixed public surface', async () => {
    const user = userEvent.setup();
    renderSection();

    const toggle = await screen.findByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('myagents agent create')).toBeInTheDocument();
    expect(screen.getByText('myagents session get')).toBeInTheDocument();
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
});
