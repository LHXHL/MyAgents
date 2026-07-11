import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import CronTaskStatusBar from './CronTaskStatusBar';

describe('CronTaskStatusBar Goal states', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('shows the running round and an explicit cancel action', () => {
    render(
      <CronTaskStatusBar
        mode="running"
        intervalMinutes={5}
        goalStatus="active"
        goalObjective="Finish the release"
        executionCount={3}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByText('Round 3 · Finish the release')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel goal' })).toBeInTheDocument();
  });

  it('uses semantic colors for terminal states', () => {
    const { container, rerender } = render(
      <CronTaskStatusBar
        mode="stopped"
        intervalMinutes={5}
        goalStatus="complete"
        goalObjective="Finish the release"
        executionCount={4}
      />,
    );
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--goal-status-color'))
      .toBe('var(--success)');

    rerender(
      <CronTaskStatusBar
        mode="stopped"
        intervalMinutes={5}
        goalStatus="blocked"
        goalObjective="Finish the release"
        executionCount={4}
      />,
    );
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--goal-status-color'))
      .toBe('var(--warning)');
  });

  it('keeps the user cancel action available while the Goal is paused', () => {
    render(
      <CronTaskStatusBar
        mode="running"
        intervalMinutes={5}
        goalStatus="paused"
        goalObjective="Finish the release"
        executionCount={3}
        onStop={vi.fn()}
        onResume={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Cancel goal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });

  it('does not infer Goal identity from a legacy Loop schedule', () => {
    const { rerender } = render(
      <CronTaskStatusBar
        mode="draft"
        taskKind="cron"
        intervalMinutes={5}
        schedule={{ kind: 'loop' }}
      />,
    );
    expect(screen.getByText('Scheduled mode')).toBeInTheDocument();
    expect(screen.queryByText('Goal Mode')).not.toBeInTheDocument();

    rerender(
      <CronTaskStatusBar
        mode="draft"
        taskKind="goal"
        intervalMinutes={5}
        schedule={{ kind: 'loop' }}
      />,
    );
    expect(screen.getByText('Goal Mode')).toBeInTheDocument();
  });
});
