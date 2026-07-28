import { describe, expect, it } from 'vitest';

import { SDK_BUILTIN_TOOLS, SDK_EXCLUDED_BUILTIN_TOOLS } from './sdk-builtin-tools';

describe('Claude Agent SDK builtin catalog', () => {
  it('keeps the product-owned 23-tool catalog exact and duplicate-free', () => {
    expect(SDK_BUILTIN_TOOLS).toEqual([
      'Read',
      'Write',
      'Edit',
      'NotebookEdit',
      'Glob',
      'Grep',
      'Bash',
      'WebFetch',
      'WebSearch',
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
      'Skill',
      'Task',
      'TaskOutput',
      'TaskStop',
      'SendMessage',
      'TaskCreate',
      'TaskGet',
      'TaskList',
      'TaskUpdate',
      'Monitor',
      'ReportFindings',
    ]);
    expect(new Set(SDK_BUILTIN_TOOLS).size).toBe(23);
  });

  it('does not expose any product-excluded builtin', () => {
    expect(SDK_EXCLUDED_BUILTIN_TOOLS).toHaveLength(9);
    for (const tool of SDK_EXCLUDED_BUILTIN_TOOLS) {
      expect(SDK_BUILTIN_TOOLS).not.toContain(tool);
    }
  });
});
