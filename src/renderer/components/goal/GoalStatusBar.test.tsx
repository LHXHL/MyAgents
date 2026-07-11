import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type { SessionGoal } from '@/types/sessionGoal';
import GoalStatusBar from './GoalStatusBar';

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    id: 'goal-1',
    workspacePath: '/workspace',
    sessionId: 'session-1',
    objective: 'Finish the release',
    status: 'active',
    endConditions: { aiCanExit: true },
    notifyEnabled: true,
    permissionMode: '',
    turnCount: 3,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    revision: 1,
    controlRevision: 1,
    isExecuting: false,
    ...overrides,
  };
}

describe('GoalStatusBar', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('shows a live Goal round and explicit cancel action', () => {
    render(
      <GoalStatusBar
        goal={goal({ isExecuting: true, executionNumber: 4 })}
        isExecuting
        executionNumber={4}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/Round 4.*Finish the release/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel goal' })).toBeInTheDocument();
  });

  it('keeps resume and cancel available while paused', () => {
    render(
      <GoalStatusBar
        goal={goal({ status: 'paused' })}
        onResume={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel goal' })).toBeInTheDocument();
  });
});
