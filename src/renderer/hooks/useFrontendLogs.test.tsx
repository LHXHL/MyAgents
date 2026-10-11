import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useFrontendLogs } from './useFrontendLogs';
import { appendFrontendLog, clearFrontendLogs, snapshotFrontendLogs } from '@/utils/frontendLogger';
import type { LogEntry } from '@/types/log';

const entry = (message: string, scope: Partial<LogEntry> = {}): LogEntry => ({
  source: 'rust', level: 'info', message, timestamp: '2026-10-11T00:00:00Z', ...scope,
});

describe('panel-only diagnostic projection', () => {
  beforeEach(() => clearFrontendLogs());

  it('does not update a hidden panel and backfills scoped history when opened', () => {
    let renders = 0;
    const view = renderHook(({ enabled }) => {
      renders += 1;
      return useFrontendLogs(enabled, { tabId: 't1', sessionId: 's1' });
    }, { initialProps: { enabled: false } });
    const before = renders;
    act(() => {
      appendFrontendLog(entry('global'));
      appendFrontendLog(entry('my-tab', { source: 'react', tabId: 't1' }));
      appendFrontendLog(entry('my-session', { source: 'bun', sessionId: 's1' }));
      appendFrontendLog(entry('other-tab', { tabId: 't2' }));
      appendFrontendLog(entry('old-session', { tabId: 't1', sessionId: 'old' }));
    });
    expect(renders).toBe(before);
    expect(view.result.current.logs).toEqual([]);
    view.rerender({ enabled: true });
    expect(view.result.current.logs.map(log => log.message)).toEqual(['global', 'my-tab', 'my-session']);
    act(() => appendFrontendLog(entry('live', { sessionId: 's1' })));
    expect(view.result.current.logs.at(-1)?.message).toBe('live');
    view.rerender({ enabled: false });
    const closed = renders;
    act(() => appendFrontendLog(entry('after-close')));
    expect(renders).toBe(closed);
  });

  it('clears only one view and keeps its cursor across closing and buffer eviction', () => {
    const first = renderHook(({ enabled }) => useFrontendLogs(enabled), { initialProps: { enabled: true } });
    const second = renderHook(() => useFrontendLogs(true));
    act(() => appendFrontendLog(entry('before-clear')));
    act(() => first.result.current.clear());
    expect(first.result.current.logs).toEqual([]);
    expect(second.result.current.logs.map(log => log.message)).toEqual(['before-clear']);
    first.rerender({ enabled: false });
    act(() => {
      for (let index = 0; index < 5001; index += 1) appendFrontendLog(entry(`new-${index}`));
    });
    expect(snapshotFrontendLogs()).toHaveLength(5000);
    first.rerender({ enabled: true });
    expect(first.result.current.logs).toHaveLength(5000);
    expect(first.result.current.logs[0].message).toBe('new-1');
  });
});
