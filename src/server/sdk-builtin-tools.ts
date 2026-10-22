/**
 * MyAgents' product-owned Claude Agent SDK builtin catalog.
 *
 * This is deliberately separate from permission policy: exposing a tool to the
 * model does not auto-approve it. Keeping an explicit catalog also prevents a
 * Claude Code patch from silently adding a new builtin with no MyAgents owner.
 */
// Claude Agent SDK 0.3.308 rejects these names before Query initialization.
// Share the catalog between registration and projection of existing configs.
export const SDK_RESERVED_MCP_NAMES: readonly string[] = [
  'claude-in-chrome',
  'computer-use',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
];

export const SDK_BUILTIN_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Bash',
  'PowerShell',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
  'Agent',
  'Task',
  'TaskStop',
  'SendMessage',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'Monitor',
  'ReportFindings',
  'Workflow',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
] as const;

export const SDK_EXCLUDED_BUILTIN_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'PushNotification',
  'DesignSync',
] as const;
