import { render, screen, within } from '@testing-library/react';
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
        author: { id: 'u-2', type: 'user' },
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
    uploadIssueAttachments: vi.fn().mockResolvedValue([]),
  } as unknown as SpaceActions;
}

describe('IssueDetailDrawer', () => {
  it('places issue actions in the header and renders issue text as Markdown', () => {
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
    expect(within(issueTitle.parentElement!).getByRole('button', { name: '复制 issue 口令' })).toBeInTheDocument();
    expect(screen.queryByText('Issue 口令')).not.toBeInTheDocument();

    const attachmentsHeading = screen.getByRole('heading', { name: /附件/ });
    expect(within(attachmentsHeading.parentElement!).getByRole('button', { name: '上传' })).toBeInTheDocument();

    expect(screen.getByText('bold issue text').tagName).toBe('STRONG');
    expect(screen.getByRole('heading', { name: 'Comment heading' })).toBeInTheDocument();
    expect(screen.getByText('inline code')).toBeInTheDocument();
    expect(container.querySelectorAll('.ai-message-content')).toHaveLength(2);
  });
});
