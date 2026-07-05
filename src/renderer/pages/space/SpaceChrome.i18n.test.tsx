import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SpaceSession } from '@/api/spaceCloud';
import { i18n } from '@/i18n';
import { SpaceLogin, SpaceSidebar } from './SpaceChrome';

vi.mock('@/hooks/useCloseLayer', () => ({
  useCloseLayer: vi.fn(),
}));

const session: SpaceSession = {
  user: { id: 'u-1', email: 'user@example.com', name: 'User' },
  space: {
    id: 'space-1',
    slug: 'official',
    name: 'Official Space',
    joinPolicy: 'open',
  },
  membership: { id: 'membership-1', role: 'member' },
  baseUrl: 'https://space.myagents.test',
  updatedAt: '2026-06-28T00:00:00.000Z',
};

describe('SpaceChrome i18n', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('renders login chrome in English', () => {
    render(<SpaceLogin authBusy={false} authFlow={null} onLogin={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'MyAgents Community' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.queryByText('MyAgents 社区')).not.toBeInTheDocument();
    expect(screen.queryByText('继续使用 Google')).not.toBeInTheDocument();
  });

  it('renders sidebar account menu in English without translating data', () => {
    render(<SpaceSidebar session={session} mode="issues" onSpaceTabChange={vi.fn()} onLogout={vi.fn()} onOpenProfileSettings={vi.fn()} />);

    expect(screen.getByText('Official Space')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /user/i }));
    expect(screen.getAllByText('user@example.com').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByText('开放加入')).not.toBeInTheDocument();
    expect(screen.queryByText('退出登录')).not.toBeInTheDocument();
  });

  it('closes the sidebar account menu when clicking outside', async () => {
    render(<SpaceSidebar session={session} mode="issues" onSpaceTabChange={vi.fn()} onLogout={vi.fn()} onOpenProfileSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /user/i }));
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    });
  });
});
