import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PermissionPrompt } from './PermissionPrompt';
import { fetchJsonLargeValueRef } from '../api/largeValueRef';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key} ${Object.values(values).join(' ')}` : key }) }));
vi.mock('../api/largeValueRef', () => ({ fetchJsonLargeValueRef: vi.fn() }));
vi.mock('../api/tauriClient', () => ({ getSessionPort: vi.fn().mockResolvedValue(4182) }));

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


describe('structured permission review', () => {
  const review = {
    operation: { kind: 'web_search' as const, query: 'Find exact example news', provider: 'fixture-search', allowedDomains: ['example.com'] },
    actor: { agentId: 'child-news', origin: 'foreground_child' as const },
    scope: { tool: 'WebSearch', permissionClass: 'network.search', target: 'provider:fixture-search', lifetimeMs: 3_600_000, owner: 'session_tree' as const },
  };
  it('loads complete referenced details before approval and retries a failed load', async () => {
    const loader = vi.mocked(fetchJsonLargeValueRef);
    loader.mockRejectedValueOnce(new Error('Details unavailable')).mockResolvedValueOnce(review);
    const onDecision = vi.fn();
    render(<PermissionPrompt request={{ requestId: 'referenced-review', sessionId: 'session-ref', toolName: 'WebSearch', input: '', reviewRef: { kind: 'ref', id: 'review-ref', mimetype: 'application/json', sizeBytes: 70_000, preview: '', expiresAt: 9_000_000_000_000 } }} onDecision={onDecision} />);
    expect(screen.getByText('shell.permissionPrompt.allow').closest('button')).toBeDisabled();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByText('shell.permissionPrompt.retry'));
    await screen.findByText(review.operation.query);
    fireEvent.click(screen.getByText('shell.permissionPrompt.allow'));
    expect(onDecision).toHaveBeenCalledWith('referenced-review', 'allow_once');
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it('shows query, filters, actor and scope and retries a failed response using the same interaction id', async () => {
    const onDecision = vi.fn().mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce(undefined);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = render(<PermissionPrompt request={{ requestId: 'permission-search', toolUseId: 'search-call', rootToolUseId: 'root-search-call', toolName: 'WebSearch', input: '', review }} onDecision={onDecision} />);
    expect(screen.getByText(review.operation.query)).toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText(/child-news/)).toBeInTheDocument();
    expect(screen.getByText(/provider:fixture-search/)).toBeInTheDocument();
    expect(container.querySelector('[data-tool-use-id="search-call"]')).toHaveAttribute('data-root-tool-use-id', 'root-search-call');
    fireEvent.click(screen.getByText('shell.permissionPrompt.allow'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Connection interrupted');
    fireEvent.click(screen.getByText('shell.permissionPrompt.allow'));
    await waitFor(() => expect(onDecision).toHaveBeenCalledTimes(2));
    expect(onDecision.mock.calls).toEqual([['permission-search', 'allow_once'], ['permission-search', 'allow_once']]);
    log.mockRestore();
  });
  it('does not approve a new request using details loaded for the previous request', async () => {
    const loader = vi.mocked(fetchJsonLargeValueRef);
    loader.mockResolvedValueOnce(review).mockReturnValueOnce(new Promise(() => undefined));
    const request = { requestId: 'review-a', sessionId: 'session-ref', toolName: 'WebSearch', input: '', reviewRef: { kind: 'ref' as const, id: 'aaaaaaaa', mimetype: 'application/json', sizeBytes: 70_000, preview: '', expiresAt: 9_000_000_000_000 } };
    const { rerender } = render(<PermissionPrompt request={request} onDecision={vi.fn()} />);
    await screen.findByText(review.operation.query);
    expect(screen.getByText('shell.permissionPrompt.allow').closest('button')).toBeEnabled();
    rerender(<PermissionPrompt request={{ ...request, requestId: 'review-b', reviewRef: { ...request.reviewRef, id: 'bbbbbbbb' } }} onDecision={vi.fn()} />);
    expect(screen.queryByText(review.operation.query)).not.toBeInTheDocument();
    expect(screen.getByText('shell.permissionPrompt.allow').closest('button')).toBeDisabled();
  });
  it('keeps the complete URL and file change visible, including content beyond the former 500-character boundary', () => {
    const { rerender } = render(<PermissionPrompt request={{ requestId: 'fetch-review', toolName: 'WebFetch', input: '', review: { ...review, operation: { kind: 'web_fetch', url: `https://example.com/search?q=${'full'.repeat(300)}`, prompt: 'Extract the release changes' } } }} onDecision={vi.fn()} />);
    expect(screen.getByText(`https://example.com/search?q=${'full'.repeat(300)}`)).toBeInTheDocument();
    rerender(<PermissionPrompt request={{ requestId: 'edit-review', toolName: 'Edit', input: '', review: { ...review, operation: { kind: 'file_change', action: 'edit', path: '/workspace/example.ts', before: 'old content', after: 'new content'.repeat(300), replacements: 2 } } }} onDecision={vi.fn()} />);
    expect(screen.getByText('new content'.repeat(300))).toBeInTheDocument();
    expect(screen.getByText('old content')).toBeInTheDocument();
  });
});
