export type CronScheduleKind = 'at' | 'every' | 'cron';

export interface CronReminderInput {
  prompt: string;
  taskId: string;
  aiCanExit: boolean;
  scheduleKind?: CronScheduleKind;
  runMode?: string;
  intervalMinutes?: number;
  executionNumber?: number;
}

function metadataLine(label: string, value: string | number | boolean | undefined): string | null {
  if (value === undefined || value === '') return null;
  return `${label}: ${value}`;
}

export function buildCronTaskReminder(input: CronReminderInput): string {
  const lines = [
    'You are running inside a MyAgents scheduled task execution.',
    'The user-visible text after this reminder is the task prompt for this execution.',
    '',
    ...[
      metadataLine('cronTaskId', input.taskId),
      metadataLine('scheduleKind', input.scheduleKind),
      metadataLine('runMode', input.runMode),
      metadataLine('executionNumber', input.executionNumber),
      metadataLine('intervalMinutes', input.intervalMinutes),
      metadataLine('allowExit', input.aiCanExit),
    ].filter((line): line is string => line !== null),
  ];

  if (input.aiCanExit) {
    lines.push(
      '',
      'If this MyAgents scheduled task goal is complete and future executions should stop, run:',
      '  myagents cron exit --reason "<brief reason>"',
      '',
      'The command is bound to the current cron execution context; do not pass a task id.',
    );
  }

  const reminder = [
    '<system-reminder>',
    '<CRON_TASK>',
    ...lines,
    '</CRON_TASK>',
    '</system-reminder>',
  ].join('\n');

  return `${reminder}\n${input.prompt}`;
}
