import { describe, expect, it } from 'vitest';

import { parseLeadingSystemReminder } from '../../shared/systemReminder';
import { buildCronTaskReminder } from './cron-reminder';

describe('buildCronTaskReminder', () => {
  it('puts operational cron instructions in the hidden reminder and leaves prompt as visible text', () => {
    const wrapped = buildCronTaskReminder({
      taskId: 'cron_123',
      prompt: 'Goal: polish the wiki',
      aiCanExit: true,
      scheduleKind: 'cron',
      runMode: 'single_session',
      executionNumber: 2,
      intervalMinutes: 30,
    });

    expect(wrapped).toBe([
      '<system-reminder>',
      '<CRON_TASK>',
      'You are running inside a MyAgents scheduled task execution.',
      'The user-visible text after this reminder is the task prompt for this execution.',
      '',
      'cronTaskId: cron_123',
      'scheduleKind: cron',
      'runMode: single_session',
      'executionNumber: 2',
      'intervalMinutes: 30',
      'allowExit: true',
      '',
      'If this MyAgents scheduled task goal is complete and future executions should stop, run:',
      '  myagents cron exit --reason "<brief reason>"',
      '',
      'The command is bound to the current cron execution context; do not pass a task id.',
      '</CRON_TASK>',
      '</system-reminder>',
      'Goal: polish the wiki',
    ].join('\n'));
  });

  it('omits exit command guidance when AI exit is disabled', () => {
    const wrapped = buildCronTaskReminder({
      taskId: 'cron_123',
      prompt: 'Check status',
      aiCanExit: false,
    });

    expect(wrapped).toContain('allowExit: false');
    expect(wrapped).not.toContain('myagents cron exit');
  });

  it('uses Goal continuation reminder only for explicit Goal tasks', () => {
    const wrapped = buildCronTaskReminder({
      taskId: 'goal_123',
      prompt: 'Ship Goal Mode',
      goalObjective: 'Ship Goal Mode with pause/resume',
      goalStatus: 'active',
      aiCanExit: true,
      scheduleKind: 'loop',
      runMode: 'single_session',
      executionNumber: 3,
      intervalMinutes: 30,
    });

    expect(wrapped).toContain('<system-reminder>');
    expect(wrapped).toContain('<GOAL_CONTINUATION>');
    expect(wrapped).toContain('goalId: goal_123');
    expect(wrapped).toContain('status: active');
    expect(wrapped).toContain('turnNumber: 3');
    expect(wrapped).toContain('Ship Goal Mode with pause/resume');
    expect(wrapped).toContain('myagents goal update --status complete');
    expect(wrapped).not.toContain('<CRON_TASK>');
    expect(wrapped).not.toMatch(/<\/system-reminder>\s*Ship Goal Mode/);
  });

  it('shows the original Goal query only on the first execution', () => {
    const first = buildCronTaskReminder({
      taskId: 'goal_first',
      prompt: '分析这个项目有什么价值',
      goalObjective: '分析这个项目有什么价值',
      goalStatus: 'active',
      aiCanExit: true,
      isFirstExecution: true,
    });
    const continuation = buildCronTaskReminder({
      taskId: 'goal_first',
      prompt: '分析这个项目有什么价值',
      goalObjective: '分析这个项目有什么价值',
      goalStatus: 'active',
      aiCanExit: true,
      isFirstExecution: false,
    });

    expect(parseLeadingSystemReminder(first)).toMatchObject({
      kind: 'GOAL_CONTINUATION',
      visibleText: '分析这个项目有什么价值',
    });
    expect(parseLeadingSystemReminder(continuation)).toMatchObject({
      kind: 'GOAL_CONTINUATION',
      visibleText: '',
    });
  });

  it('keeps a legacy loop task on the ordinary cron reminder path', () => {
    const wrapped = buildCronTaskReminder({
      taskId: 'legacy_loop',
      prompt: 'Continue legacy loop work',
      aiCanExit: true,
      scheduleKind: 'loop',
      runMode: 'single_session',
    });

    expect(wrapped).toContain('<CRON_TASK>');
    expect(wrapped).not.toContain('<GOAL_CONTINUATION>');
  });

  it('does not expose Goal terminal commands when autonomous exit is disabled', () => {
    const wrapped = buildCronTaskReminder({
      taskId: 'goal_no_exit',
      prompt: 'Keep investigating',
      goalObjective: 'Find the root cause',
      goalStatus: 'active',
      aiCanExit: false,
      scheduleKind: 'loop',
      runMode: 'single_session',
    });

    expect(wrapped).toContain('disabled autonomous Goal termination');
    expect(wrapped).not.toContain('myagents goal update --status');
    expect(wrapped).not.toContain('myagents cron exit');
  });
});
