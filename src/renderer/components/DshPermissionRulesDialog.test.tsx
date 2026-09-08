import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import DshPermissionRulesDialog from './DshPermissionRulesDialog';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock('@/context/TabContext', () => ({
  useTabApi: () => ({
    apiGet: mocks.apiGet,
    apiDelete: mocks.apiDelete,
  }),
}));

describe('DshPermissionRulesDialog', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en-US');
    mocks.apiGet
      .mockResolvedValueOnce({
        success: true,
        permissionMode: 'acceptEdits',
        autoAllowTools: ['Read'],
        revision: 'permission-revision-1',
        rules: [{
          ruleId: 'rule-1',
          revision: 'permission-revision-1',
          tool: 'Bash',
          permissionClass: 'process.execute',
          target: 'npm test',
          origin: 'root',
          createdAt: 1_000,
          expiresAt: null,
        }],
      })
      .mockResolvedValue({
        success: true,
        permissionMode: 'acceptEdits',
        autoAllowTools: ['Read'],
        revision: 'permission-revision-2',
        rules: [],
      });
    mocks.apiDelete.mockResolvedValue({
      success: true,
      mutation: { state: 'applied', revision: 'permission-revision-2' },
    });
  });

  it('shows exact Runtime rules and revokes with the displayed revision', async () => {
    const user = userEvent.setup();
    render(<DshPermissionRulesDialog onClose={vi.fn()} />);

    expect(await screen.findByRole('dialog', { name: 'Allowed actions' })).toBeInTheDocument();
    expect(await screen.findByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('process.execute')).toBeInTheDocument();
    expect(screen.getByText('Always allowed in this Session')).toBeInTheDocument();
    expect(screen.queryByText(/^Expires /)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revoke Bash grant' }));

    await waitFor(() => expect(mocks.apiDelete).toHaveBeenCalledWith(
      '/api/session/permission-rules?expectedRevision=permission-revision-1&ruleId=rule-1',
    ));
    await waitFor(() => expect(screen.getByText('No exact action grants are active.')).toBeInTheDocument());
  });

  it('shows desired/effective drift from the authoritative list snapshot', async () => {
    render(
      <DshPermissionRulesDialog
        desiredProductMode="fullAgency"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('fullAgency')).toBeInTheDocument();
    expect(await screen.findByText(/desired and effective Runtime permission modes differ/))
      .toBeInTheDocument();
  });
});
