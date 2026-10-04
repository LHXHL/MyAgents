import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceSession, SpaceSessionView } from '@/api/spaceCloud';

const mocks = vi.hoisted(() => ({
  snapshot: {
    scope: 'production', enabled: true, generation: 1, loadState: 'ready',
    view: null as SpaceSessionView | null, error: null as string | null,
    avatarPresets: { people: [], agents: [], lastFetchedAt: 0, isLoading: false, error: null },
  },
  refresh: vi.fn(), updateProfile: vi.fn(), loadAvatarPresets: vi.fn(), logout: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('./useMyAgentsAccount', () => ({ useMyAgentsAccount: () => mocks.snapshot }));
vi.mock('./accountStore', () => ({
  getAccountSnapshot: () => mocks.snapshot,
  accountActions: { refresh: mocks.refresh, updateProfile: mocks.updateProfile, loadAvatarPresets: mocks.loadAvatarPresets, logout: mocks.logout },
}));
vi.mock('@/components/Toast', () => ({ useToast: () => mocks.toast }));
import AccountEntry from './AccountEntry';
import { i18n } from '@/i18n';

const session: SpaceSession = {
  sessionBindingId: 'binding-1', baseUrl: 'https://space.myagents.test',
  user: { id: 'user-1', name: 'Alice', email: 'alice@example.test' },
  space: { id: 'official', slug: 'official', name: 'Official', joinPolicy: 'open' },
  membership: { id: 'm-1', role: 'member' }, updatedAt: '2026-10-04T00:00:00Z',
};
const props = () => ({ expanded: true, available: true, environment: 'production', onOpenSpace: vi.fn() });
function signIn(value = session) { mocks.snapshot.view = { state: 'authenticated', session: value }; }

describe('global account entry', () => {
  beforeEach(async () => {
    vi.clearAllMocks(); await i18n.changeLanguage('en-US');
    mocks.snapshot.view = null; mocks.snapshot.loadState = 'ready'; mocks.snapshot.generation = 1; mocks.snapshot.error = null;
    mocks.refresh.mockResolvedValue(undefined); mocks.updateProfile.mockResolvedValue(undefined); mocks.logout.mockResolvedValue(undefined);
  });
  it('uses the existing Space navigation without starting a browser sign-in', () => {
    const callbacks = props(); render(<AccountEntry {...callbacks} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to MyAgents' }));
    expect(callbacks.onOpenSpace).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('treats reauth as unsigned and uses the same navigation', () => {
    mocks.snapshot.view = { state: 'reauth_required', account: session, invalidatedSessionBindingId: 'binding-1' };
    const callbacks = props(); render(<AccountEntry {...callbacks} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to MyAgents' }));
    expect(callbacks.onOpenSpace).toHaveBeenCalledOnce();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });
  it('opens account details without changing Tab and removes the old Settings action', async () => {
    signIn(); const callbacks = props(); render(<AccountEntry {...callbacks} />);
    fireEvent.click(screen.getByRole('button', { name: /Alice/ }));
    expect(screen.getByRole('dialog', { name: 'MyAgents account' })).toBeInTheDocument();
    expect(screen.getByText('alice@example.test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit account profile' })).toBeInTheDocument();
    expect(screen.getByText('FREE')).toBeInTheDocument();
    expect(screen.queryByText('Free account')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(callbacks.onOpenSpace).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('edits via the account information row with no Space Tab and keeps email read-only', async () => {
    const user = userEvent.setup(); signIn(); const callbacks = props(); render(<AccountEntry {...callbacks} />);
    await user.click(screen.getByRole('button', { name: /Alice/ }));
    await user.click(screen.getByRole('button', { name: 'Edit account profile' }));
    expect(screen.queryByRole('dialog', { name: 'MyAgents account' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Account settings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeDisabled();
    await user.clear(screen.getByLabelText('Nickname')); await user.type(screen.getByLabelText('Nickname'), 'New Alice');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledWith({ name: 'New Alice', avatarFilePath: null, avatarPresetId: null, nameChanged: true }));
    expect(callbacks.onOpenSpace).not.toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalled();
  });
  it('supports keyboard menu opening, editing selection, and Escape focus return', async () => {
    const user = userEvent.setup(); signIn(); render(<AccountEntry {...props()} />);
    await user.tab();
    const trigger = screen.getByRole('button', { name: /Alice/ });
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Edit account profile' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'MyAgents account' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it('keeps failed profile input available for retry', async () => {
    const user = userEvent.setup(); signIn(); mocks.updateProfile.mockRejectedValue(new Error('Save failed'));
    render(<AccountEntry {...props()} />);
    await user.click(screen.getByRole('button', { name: /Alice/ })); await user.click(screen.getByRole('button', { name: 'Edit account profile' }));
    await user.clear(screen.getByLabelText('Nickname')); await user.type(screen.getByLabelText('Nickname'), 'Retry name');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/Save failed/)).toBeInTheDocument());
    expect(screen.getByLabelText('Nickname')).toHaveValue('Retry name');
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
  it('retires menus and profile dialogs when collapsing or changing identity', () => {
    signIn(); const callbacks = props(); const { rerender } = render(<AccountEntry {...callbacks} />);
    fireEvent.click(screen.getByRole('button', { name: /Alice/ }));
    rerender(<AccountEntry {...callbacks} expanded={false} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<AccountEntry {...callbacks} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Alice/ })); fireEvent.click(screen.getByRole('button', { name: 'Edit account profile' }));
    mocks.snapshot.generation++; mocks.snapshot.view = null; rerender(<AccountEntry {...callbacks} />);
    expect(screen.queryByRole('heading', { name: 'Account settings' })).not.toBeInTheDocument();
  });
  it('keeps avatar initials visible immediately on menu reopen and sidebar re-expansion', () => {
    signIn({ ...session, user: { ...session.user, avatarUrl: 'https://avatars.example.test/unavailable.png' } });
    const callbacks = props(); const { rerender } = render(<AccountEntry {...callbacks} />);
    const trigger = screen.getByRole('button', { name: /Alice/ });
    expect(within(trigger).getByText('A')).toBeVisible();
    fireEvent.error(trigger.querySelector('img')!);
    fireEvent.click(trigger);
    const profile = screen.getByRole('button', { name: 'Edit account profile' });
    expect(within(profile).getByText('A')).toBeVisible();
    fireEvent.error(profile.querySelector('img')!);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(trigger);
    expect(within(screen.getByRole('button', { name: 'Edit account profile' })).getByText('A')).toBeVisible();
    rerender(<AccountEntry {...callbacks} expanded={false} />);
    rerender(<AccountEntry {...callbacks} />);
    expect(within(screen.getByRole('button', { name: /Alice/ })).getByText('A')).toBeVisible();
  });
  it('uses account Pro entitlement and refreshes stale projections on open', async () => {
    signIn({ ...session, accountPlan: { effectiveTier: 'pro', evaluatedAt: '2026-01-01T00:00:00Z', membership: {
      planTier: 'pro', status: 'active', startsAt: '2026-01-01T00:00:00Z', expiresAt: '2099-10-11T00:00:00Z', source: 'operations', version: 1,
    } } });
    render(<AccountEntry {...props()} />); fireEvent.click(screen.getByRole('button', { name: /Alice/ }));
    expect(screen.getByText('PRO')).toBeInTheDocument(); expect(screen.getByText(/Pro account · valid until/)).toBeInTheDocument();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  });
  it.each(['expired', 'revoked'] as const)('retains Free display for %s membership without signing out', (status) => {
    signIn({ ...session, accountPlan: { effectiveTier: status === 'expired' ? 'pro' : 'free', evaluatedAt: '2026-01-01T00:00:00Z', membership: {
      planTier: 'pro', status, startsAt: '2025-01-01T00:00:00Z', expiresAt: '2026-01-01T00:00:00Z', source: 'operations', version: 1,
    } } });
    render(<AccountEntry {...props()} />); fireEvent.click(screen.getByRole('button', { name: /Alice/ }));
    expect(screen.getByText('FREE')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    if (status === 'revoked') expect(screen.queryByText(/Pro expired on/)).not.toBeInTheDocument();
  });
  it('reports failed local logout without dismissing account identity', async () => {
    signIn(); mocks.logout.mockRejectedValue(new Error('Local exit failed'));
    render(<AccountEntry {...props()} />); fireEvent.click(screen.getByRole('button', { name: /Alice/ })); fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringContaining('Local exit failed')));
    expect(screen.getByRole('dialog', { name: 'MyAgents account' })).toBeInTheDocument();
  });
  it('localizes the global entry and account edit action in Chinese', async () => {
    await i18n.changeLanguage('zh-CN'); const callbacks = props(); const { rerender } = render(<AccountEntry {...callbacks} />);
    expect(screen.getByRole('button', { name: '登录 MyAgents' })).toBeInTheDocument();
    signIn(); rerender(<AccountEntry {...callbacks} />); fireEvent.click(screen.getByRole('button', { name: /Alice/ }));
    expect(screen.getByRole('button', { name: '编辑账号资料' })).toBeInTheDocument();
    expect(screen.getByText('FREE')).toBeInTheDocument();
    expect(screen.queryByText('免费账户')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument();
  });
});
