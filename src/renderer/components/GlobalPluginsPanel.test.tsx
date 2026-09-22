import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import GlobalPluginsPanel from './GlobalPluginsPanel';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/api/apiFetch', () => ({
  apiGetJson: (...args: unknown[]) => mocks.get(...args),
  apiPostJson: (...args: unknown[]) => mocks.post(...args),
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => mocks.toast,
}));

describe('GlobalPluginsPanel uninstall confirmation', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();

    const plugin = {
      id: 'example-plugin@local',
      name: 'example-plugin',
      source: 'local',
      sourceUrl: 'file:///tmp/example-plugin',
      installPath: '/Users/example/.myagents/plugins/example-plugin',
      dataPath: '/Users/example/.myagents/plugins/data/example-plugin-local',
      installedAt: '2026-09-20T00:00:00.000Z',
      enabled: true,
      status: 'ok',
      components: {
        skills: [],
        commands: [],
        agents: [],
        hooks: 0,
        mcpServers: [],
        lspServers: [],
        monitors: [],
        hasBin: false,
      },
    };
    mocks.get.mockImplementation(async (url: string) => url.includes('/detail')
      ? { success: true, plugin }
      : { success: true, plugins: [plugin] });
  });

  it('keeps the parent-owned confirmation visible from detail and shows the real data path', async () => {
    const user = userEvent.setup();
    render(<GlobalPluginsPanel />);

    await user.click(await screen.findByText('example-plugin'));
    await screen.findByRole('heading', { name: 'example-plugin', level: 2 });
    await user.click(screen.getByRole('button', { name: 'Uninstall' }));

    expect(screen.getByText('Uninstall example-plugin?')).toBeInTheDocument();
    expect(screen.getByText(/\/Users\/example\/\.myagents\/plugins\/data\/example-plugin-local/))
      .toBeInTheDocument();
    expect(screen.queryByText(/\$\{CLAUDE_PLUGIN_DATA\}/)).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
