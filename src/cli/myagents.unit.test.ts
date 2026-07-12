import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  formatCronInstantForDisplay,
  formatCronTaskScheduleForDisplay,
  buildRequestBody,
  buildRoute,
  buildClaimCancelBody,
  buildSpaceCompleteOperationKey,
  normalizeScheduleFlag,
  parseArgs,
  parseDispatchAtValue,
  readWorkspaceTextFile,
} from './myagents';

describe('myagents CLI Space issue contracts', () => {
  it('routes and builds exact comment lookup by issue and comment id', () => {
    expect(buildRoute('space', 'issue', ['comment', 'get', 'iss_1', 'comment_1']))
      .toBe('space/issue-comment-get');
    expect(buildRequestBody('space', 'issue', ['comment', 'get', 'iss_1', 'comment_1'], {
      workspacePath: '/workspace',
      agentId: 'rag_1',
    })).toEqual({
      issueId: 'iss_1',
      commentId: 'comment_1',
      agentId: 'rag_1',
      workspacePath: '/workspace',
    });
  });

  it('keeps the Issue detail default comment window at five', () => {
    expect(buildRequestBody('space', 'issue', ['view', 'iss_1'], {
      workspacePath: '/workspace',
    })).toMatchObject({
      issueId: 'iss_1',
      commentsLimit: undefined,
      commentsCursor: undefined,
    });
    expect(buildRoute('space', 'issue', ['comments', 'iss_1']))
      .toBe('space/issue-comments');
    expect(buildRequestBody('space', 'issue', ['comments', 'iss_1'], {
      workspacePath: '/workspace',
      cursor: 'opaque-cursor',
    })).toMatchObject({
      issueId: 'iss_1',
      cursor: 'opaque-cursor',
      limit: 20,
    });
  });

  it('uses claim origin to constrain attached-task rollback', () => {
    const claimBody = { issueId: 'iss_1', agentId: 'rag_1', workspacePath: '/workspace' };
    expect(buildClaimCancelBody(claimBody, {
      data: { claim: { id: 'claim_1', origin: 'self_claim' }, notificationVersion: 7 },
    })).toMatchObject({ rollback: true, expectedNotificationVersion: 7 });
    expect(buildClaimCancelBody(claimBody, {
      data: { claim: { id: 'claim_2', origin: 'assignment_confirmation' }, notificationVersion: 9 },
    })).toEqual({
      ...claimBody,
      rollback: true,
    });
  });

  it('generates a stable completion operation key bound to Issue, Task, and result', () => {
    const input = { issueId: 'iss_1', taskOrSessionId: 'task_1', resultComment: 'done' };
    expect(buildSpaceCompleteOperationKey(input)).toBe(buildSpaceCompleteOperationKey(input));
    expect(buildSpaceCompleteOperationKey(input)).not.toBe(
      buildSpaceCompleteOperationKey({ ...input, resultComment: 'different result' }),
    );
  });
});

describe('myagents CLI Goal file inputs', () => {
  it('reads shell-sensitive objective and reason text from workspace files', () => {
    const dir = mkdtempSync(join(process.cwd(), '.goal-cli-test-'));
    try {
      const objectivePath = join(dir, 'objective.txt');
      const reasonPath = join(dir, 'reason.txt');
      const objective = 'finish $(touch should-not-run) with `literal` and "quotes"';
      const reason = 'verified $HOME without shell expansion';
      writeFileSync(objectivePath, objective, 'utf8');
      writeFileSync(reasonPath, reason, 'utf8');

      expect(buildRequestBody('goal', 'create', [], {
        objectiveFile: objectivePath,
      })).toEqual({ objective });
      expect(buildRequestBody('goal', 'update', [], {
        status: 'complete',
        reasonFile: reasonPath,
      })).toEqual({ status: 'complete', reason });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the workspace, symlinks, oversized files, and NUL bytes', () => {
    const root = mkdtempSync(join(process.cwd(), '.goal-cli-safety-test-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    try {
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, 'outside', 'utf8');
      expect(() => readWorkspaceTextFile(outside, workspace)).toThrow(/inside workspace/);

      const target = join(workspace, 'target.txt');
      const link = join(workspace, 'link.txt');
      writeFileSync(target, 'target', 'utf8');
      symlinkSync(target, link);
      expect(() => readWorkspaceTextFile(link, workspace)).toThrow(/symlink/);

      const oversized = join(workspace, 'oversized.txt');
      writeFileSync(oversized, 'x'.repeat(1024 * 1024 + 1), 'utf8');
      expect(() => readWorkspaceTextFile(oversized, workspace)).toThrow(/exceeds/);

      const nul = join(workspace, 'nul.txt');
      writeFileSync(nul, 'before\0after', 'utf8');
      expect(() => readWorkspaceTextFile(nul, workspace)).toThrow(/NUL/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects inline and positional Goal text before building an API request', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => buildRequestBody('goal', 'create', [], {
        objective: '$(touch should-not-run)',
      })).toThrow('process.exit(2)');
      expect(() => buildRequestBody('goal', 'create', ['positional objective'], {}))
        .toThrow('process.exit(2)');
      expect(() => buildRequestBody('goal', 'update', [], {
        status: 'complete',
        reason: '`touch should-not-run`',
      })).toThrow('process.exit(2)');
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});

describe('myagents CLI parseArgs', () => {
  it('normalizes file-only Goal flags to camelCase', () => {
    expect(parseArgs([
      'goal',
      'create',
      '--objective-file',
      'myagents_files/objective.txt',
    ])).toMatchObject({
      positional: ['goal', 'create'],
      flags: { objectiveFile: 'myagents_files/objective.txt' },
    });
  });

  it('collects consecutive values for repeatable flags', () => {
    expect(parseArgs([
      'model',
      'add',
      '--models',
      'sensenova-6.7-flash-lite',
      'deepseek-v4-flash',
      'glm-5.2',
      '--primary-model',
      'sensenova-6.7-flash-lite',
    ])).toMatchObject({
      positional: ['model', 'add'],
      flags: {
        models: ['sensenova-6.7-flash-lite', 'deepseek-v4-flash', 'glm-5.2'],
        primaryModel: 'sensenova-6.7-flash-lite',
      },
    });
  });

  it('appends repeated repeatable flags instead of overwriting them', () => {
    expect(parseArgs([
      'model',
      'add',
      '--models',
      'A',
      '--models',
      'B',
      '--models=C',
    ])).toMatchObject({
      flags: { models: ['A', 'B', 'C'] },
    });
  });

  it('keeps model names aligned when both model lists use consecutive values', () => {
    expect(parseArgs([
      'model',
      'add',
      '--models',
      'A',
      'B',
      '--model-names',
      'Model A',
      'Model B',
    ])).toMatchObject({
      flags: {
        models: ['A', 'B'],
        modelNames: ['Model A', 'Model B'],
      },
    });
  });

  it('still accepts dash-prefixed values as the first repeatable value', () => {
    expect(parseArgs([
      'mcp',
      'add',
      '--args',
      '--stdio',
      'server.js',
      '--env',
      'TOKEN=secret',
    ])).toMatchObject({
      flags: {
        args: ['--stdio', 'server.js'],
        env: ['TOKEN=secret'],
      },
    });
  });
});

describe('myagents CLI cron time handling', () => {
  it('adds a default IANA timezone to bare cron schedules on create paths', () => {
    expect(normalizeScheduleFlag('0 9 * * *', {
      fillMissingCronTimezone: true,
      defaultTimezone: 'Asia/Shanghai',
    })).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'Asia/Shanghai',
    });
  });

  it('leaves bare cron schedules timezone-free for update inheritance', () => {
    expect(normalizeScheduleFlag('0 9 * * *')).toEqual({
      kind: 'cron',
      expr: '0 9 * * *',
    });
  });

  it('fills missing JSON cron timezone on create but preserves explicit UTC', () => {
    expect(normalizeScheduleFlag('{"kind":"cron","expr":"0 9 * * *"}', {
      fillMissingCronTimezone: true,
      defaultTimezone: 'Asia/Shanghai',
    })).toMatchObject({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'Asia/Shanghai',
    });

    expect(normalizeScheduleFlag('{"kind":"cron","expr":"0 9 * * *","tz":"UTC"}', {
      fillMissingCronTimezone: true,
      defaultTimezone: 'Asia/Shanghai',
    })).toMatchObject({
      kind: 'cron',
      expr: '0 9 * * *',
      tz: 'UTC',
    });
  });

  it('rejects retired loop schedules from ordinary cron commands', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => normalizeScheduleFlag('{"kind":"loop"}')).toThrow('process.exit(2)');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Goal Mode'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('myagents goal create --objective-file'));
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('requires explicit offset or Z for one-shot dispatchAt strings', () => {
    expect(parseDispatchAtValue('2026-06-01T09:00:00+08:00')).toBe(Date.parse('2026-06-01T09:00:00+08:00'));
    expect(parseDispatchAtValue('2026-06-01T01:00:00Z')).toBe(Date.parse('2026-06-01T01:00:00Z'));
    expect(() => parseDispatchAtValue('2026-06-01T09:00:00')).toThrow(/explicit timezone offset or Z/);
  });

  it('marks legacy cron schedules without tz as UTC by default in display text', () => {
    expect(formatCronTaskScheduleForDisplay({
      schedule: { kind: 'cron', expr: '0 9 * * *' },
    }, 'long')).toBe('0 9 * * * @ UTC(default)');
  });

  it('formats instants with timezone name and offset for human output', () => {
    expect(formatCronInstantForDisplay('2026-07-09T01:00:00Z', 'Asia/Shanghai', 'long'))
      .toBe('2026-07-09 09:00 Asia/Shanghai (UTC+08:00)');
  });
});
