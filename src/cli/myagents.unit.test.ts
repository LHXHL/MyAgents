import { describe, expect, it } from 'vitest';

import {
  formatCronInstantForDisplay,
  formatCronTaskScheduleForDisplay,
  normalizeScheduleFlag,
  parseArgs,
  parseDispatchAtValue,
} from './myagents';

describe('myagents CLI parseArgs', () => {
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
