import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PermissionPrompt } from './PermissionPrompt';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('PermissionPrompt operation display', () => {
  it('shows a complete long command, directory and scope while preserving the decision identity', () => {
    const command = `printf '%s' '${'example'.repeat(200)}'\nprintf done`;
    const onDecision = vi.fn();
    const { container } = render(<PermissionPrompt request={{
      requestId: 'permission-1', toolName: 'Bash', input: '{"permissionClass":"process.execute"}',
      display: { command, cwd: '/workspace', description: 'Inspect files', alwaysAllowScope: 'session_workspace' },
    }} onDecision={onDecision} />);
    expect(container.querySelector('.whitespace-pre-wrap')?.textContent).toBe(command);
    expect(screen.getByText('/workspace')).toBeInTheDocument();
    expect(screen.getByText('Inspect files')).toBeInTheDocument();
    expect(screen.getByText('shell.permissionPrompt.sessionWorkspaceScope')).toBeInTheDocument();
    expect(screen.queryByText(/permissionClass/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('shell.permissionPrompt.allow'));
    expect(onDecision).toHaveBeenCalledWith('permission-1', 'allow_once');
  });

  it.each([
    ['Bash', { command: 'printf legacy', description: 'Legacy command' }, 'printf legacy'],
    ['Shell', { command: 'git status', cwd: '/codex' }, 'git status'],
    ['FileEdit', { reason: 'Approve edit' }, JSON.stringify({ reason: 'Approve edit' }, null, 2)],
  ])('preserves the existing %s rendering without optional display', (toolName, input, expected) => {
    const { container } = render(<PermissionPrompt request={{ requestId: 'legacy', toolName, input: JSON.stringify(input) }} onDecision={vi.fn()} />);
    expect(container.querySelector('.whitespace-pre-wrap')?.textContent).toBe(expected);
    expect(screen.queryByText('shell.permissionPrompt.cwd')).not.toBeInTheDocument();
    expect(screen.queryByText('shell.permissionPrompt.sessionWorkspaceScope')).not.toBeInTheDocument();
  });
});
