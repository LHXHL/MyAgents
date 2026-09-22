import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import AgentIdentityConflicts from './AgentIdentityConflicts';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(), post: vi.fn(), success: vi.fn(),
  projects: [
    { id: 'one', name: 'Current', path: '/current', agentId: 'shared' },
    { id: 'two', name: 'Preset', path: '/preset', agentId: 'shared', hidden: true, archivedAt: '2026-01-01' },
  ],
}));
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({
  config: { agents: [{ id: 'shared', name: 'Shared', channels: [] }] },
  projects: mocks.projects, refreshConfig: mocks.refresh,
}) }));
vi.mock('@/api/apiFetch', () => ({ apiPostJson: mocks.post }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ success: mocks.success }) }));
vi.mock('@/hooks/useCloseLayer', () => ({ useCloseLayer: vi.fn() }));

describe('Agent conflict chooser', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.post.mockResolvedValue({ success: true });
    mocks.refresh.mockResolvedValue(undefined);
    await i18n.changeLanguage('en-US');
  });

  it('shows both paths and requires an explicit choice; cancel writes nothing', () => {
    render(<AgentIdentityConflicts />);
    expect(screen.getByText('/current')).toBeInTheDocument();
    expect(screen.getByText('/preset')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose the workspace that keeps this Agent' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm repair' })).toBeDisabled();
    expect(screen.getByText('Hidden')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('submits only the selected keeper plus the observed claim snapshot', async () => {
    render(<AgentIdentityConflicts />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose the workspace that keeps this Agent' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Current /current' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm repair' }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalled());
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/agent/resolve-conflict', {
      agentId: 'shared', keepProjectId: 'one', expectedClaims: [{ id: 'one', path: '/current' }, { id: 'two', path: '/preset' }],
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('does not report success on a stale choice and refreshes instead of automatically retrying', async () => {
    mocks.post.mockResolvedValue({ success: false, error: 'Conflict changed. Refresh.' });
    render(<AgentIdentityConflicts />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose the workspace that keeps this Agent' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Current /current' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm repair' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Conflict changed. Refresh.'));
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
