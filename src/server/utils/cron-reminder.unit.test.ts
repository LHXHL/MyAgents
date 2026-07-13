import { describe, expect, it } from 'vitest';

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

});
