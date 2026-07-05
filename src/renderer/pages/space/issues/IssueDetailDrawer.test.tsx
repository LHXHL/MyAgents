import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { SpaceIssueDetail, SpaceSession } from '@/api/spaceCloud';
import type { SpaceActions } from '@/pages/space/spaceStore';
import { IssueDetailDrawer } from '@/pages/space/issues/IssueDetailDrawer';

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    error: vi.fn(),
    success: vi.fn(),
  }),
}));

const session: SpaceSession = {
  baseUrl: 'https://space.myagents.test',
  user: { id: 'u-1', email: 'user@example.com', name: 'User' },
  space: { id: 'space-1', slug: 'official', name: 'Official Space', joinPolicy: 'open' },
  membership: { id: 'membership-1', role: 'member' },
  updatedAt: '2026-06-30T00:00:00.000Z',
};

const detail: SpaceIssueDetail = {
  issue: {
    id: 'iss-1',
    number: 113,
    spaceId: 'space-1',
    title: 'Markdown issue',
    body: 'Issue body with **bold issue text**.\n\n- task one',
    state: 'todo',
    creator: { id: 'u-1', name: 'Ethan' },
    createdAt: '2026-06-25T00:25:00.000Z',
    updatedAt: '2026-06-25T00:25:00.000Z',
  },
  comments: {
    items: [
      {
        id: 'comment-1',
        author: { id: 'u-2', type: 'user', name: 'Commenter', avatarUrl: 'https://r2-public.myagents.test/commenter.png' },
        body: '## Comment heading\n\nComment with `inline code`.',
        createdAt: '2026-06-30T11:30:00.000Z',
      },
    ],
    hasMore: false,
    limit: 20,
  },
  attachments: [],
};

function actions(): SpaceActions {
  return {
    refreshIssueDetail: vi.fn().mockResolvedValue(undefined),
    updateIssue: vi.fn().mockResolvedValue({ ...detail.issue, title: 'Updated title', body: 'Updated body' }),
    uploadIssueAttachments: vi.fn().mockResolvedValue([]),
  } as unknown as SpaceActions;
}

describe('IssueDetailDrawer', () => {
  it('places issue actions in the header menu and renders issue text as Markdown', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <IssueDetailDrawer
        issueId="iss-1"
        session={session}
        projects={[]}
        detailState={{ detail, isLoading: false, lastFetchedAt: Date.now(), error: null }}
        actions={actions()}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    const issueTitle = screen.getByRole('heading', { name: 'Markdown issue' });
    expect(within(issueTitle.parentElement!).queryByRole('button', { name: '复制 issue 口令' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复制 issue 口令' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    expect(await screen.findByRole('button', { name: '复制 issue 口令' })).toBeInTheDocument();
    const metaRow = screen.getByText('#113').parentElement!;
    const metaText = metaRow.textContent ?? '';
    expect(metaText.indexOf('#113')).toBeLessThan(metaText.indexOf('Ethan'));
    expect(screen.getByText('Ethan').tagName).toBe('SPAN');
    expect(screen.getByText('Commenter').tagName).toBe('SPAN');
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
    expect(screen.queryByText('Issue 口令')).not.toBeInTheDocument();

    const attachmentsHeading = screen.getByRole('heading', { name: /附件/ });
    expect(within(attachmentsHeading.parentElement!).getByRole('button', { name: '上传' })).toBeInTheDocument();

    expect(screen.getByText('bold issue text').tagName).toBe('STRONG');
    expect(screen.getByRole('heading', { name: 'Comment heading' })).toBeInTheDocument();
    expect(screen.getByText('inline code')).toBeInTheDocument();
    expect(container.querySelectorAll('.ai-message-content')).toHaveLength(2);
  });

  it('saves edited issue title and body', async () => {
    const user = userEvent.setup();
    const mockActions = actions();
    render(
      <IssueDetailDrawer
        issueId="iss-1"
        session={session}
        projects={[]}
        detailState={{ detail, isLoading: false, lastFetchedAt: Date.now(), error: null }}
        actions={mockActions}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('button', { name: '编辑' }));
    await user.clear(screen.getByLabelText('Issue 标题'));
    await user.type(screen.getByLabelText('Issue 标题'), 'Renamed issue');
    await user.clear(screen.getByLabelText('Issue 正文'));
    await user.type(screen.getByLabelText('Issue 正文'), 'Edited body');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(mockActions.updateIssue).toHaveBeenCalledWith({
      issueId: 'iss-1',
      title: 'Renamed issue',
      body: 'Edited body',
    });
  });

  it('navigates to adjacent issues from header arrow buttons', async () => {
    const user = userEvent.setup();
    const onNavigateIssue = vi.fn();
    render(
      <IssueDetailDrawer
        issueId="iss-1"
        session={session}
        projects={[]}
        detailState={{ detail, isLoading: false, lastFetchedAt: Date.now(), error: null }}
        actions={actions()}
        onClose={vi.fn()}
        onNavigateIssue={onNavigateIssue}
        previousIssueId="iss-0"
        nextIssueId="iss-2"
        onChanged={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '上一条 Issue' }));
    await user.click(screen.getByRole('button', { name: '下一条 Issue' }));

    expect(onNavigateIssue).toHaveBeenNthCalledWith(1, 'iss-0');
    expect(onNavigateIssue).toHaveBeenNthCalledWith(2, 'iss-2');
  });
});
