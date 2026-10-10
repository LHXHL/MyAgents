import { describe, expect, it } from 'vitest';
import { CodexRuntime } from './codex';
import type { UnifiedEvent, UnifiedEventCallback } from './types';

function completed(item: Record<string, unknown>): UnifiedEvent[] {
  const runtime = new CodexRuntime();
  const parse = (runtime as unknown as {
    parseNotification: (proc: { threadId: string; currentTurnId: string }, method: string, params: unknown, emit: UnifiedEventCallback) => UnifiedEvent[];
  }).parseNotification.bind(runtime);
  return parse({ threadId: 'main', currentTurnId: 'turn-one' }, 'item/completed', { threadId: 'main', item: { id: 'search', type: 'webSearch', ...item } }, () => {});
}

describe('Codex web search source transport', () => {
  it('preserves native 0.159 standalone ref IDs and URLs in the existing tool result', () => {
    const results = [{ type: 'text_result', ref_id: 'turn0search0', title: 'Search Result', url: 'https://example.com/search-result', snippet: 'Evidence', extra_future_field: true }];
    const events = completed({ query: 'example', action: { type: 'search', queries: ['example', 'other'] }, results });
    expect(events[0]).toEqual({ kind: 'tool_use_stop', toolUseId: 'search' });
    expect(events[1]).toMatchObject({ kind: 'tool_result', toolUseId: 'search' });
    if (events[1].kind !== 'tool_result') throw new Error('Expected result');
    expect(JSON.parse(events[1].content as string)).toEqual({ results, answer: 'Query: example\nQueries: example | other' });
  });

  it('preserves legacy/hosted no-results summaries and explicit empty results', () => {
    expect(completed({ query: 'query', action: { type: 'openPage', url: 'https://example.com/' } })[1]).toMatchObject({ content: 'Query: query\nURL: https://example.com/' });
    expect(completed({ results: null })[1]).toMatchObject({ content: 'Search completed' });
    expect(completed({ results: [] })[1]).toMatchObject({ content: '{"results":[],"answer":""}' });
  });
});
