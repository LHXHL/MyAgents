import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import CronTaskStatusBar from './CronTaskStatusBar';

describe('CronTaskStatusBar', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
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
