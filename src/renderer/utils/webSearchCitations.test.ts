import { describe, expect, it } from 'vitest';
import type { Message, ToolUseSimple } from '@/types/chat';
import { citationScope, createWebSearchCitationIndex } from './webSearchCitations';

const source = { ref_id: 'turn0search0', title: 'Source', url: 'https://example.com/' };
const tool: ToolUseSimple = { id: 'search', name: 'WebSearch', streamIndex: 0, input: {}, result: JSON.stringify({ results: [source] }) };
function message(id: string, turnId?: string, search: ToolUseSimple = tool): Message {
  return { id, turnId, role: 'assistant', timestamp: new Date(0), content: [{ type: 'tool_use', tool: search }] };
}

describe('turn-scoped citation sources', () => {
  it('shares search sources across product segments of the same turn without crossing turns', () => {
    const first = message('first', 'turn-one');
    const answer = { ...message('answer', 'turn-one'), content: 'Claim' };
    const other = { ...message('other', 'turn-two'), content: 'Claim' };
    const index = createWebSearchCitationIndex()([first, answer, other]);
    expect(index.get(citationScope(answer))?.get(source.ref_id)).toEqual({ title: source.title, url: source.url });
    expect(index.get(citationScope(other))).toBeUndefined();
  });

  it('retains index and turn identity across text-only streaming updates but invalidates a new source', () => {
    const collect = createWebSearchCitationIndex();
    const first = message('first', 'turn-one');
    const before = collect([first]);
    const delta = { ...first, content: [...(Array.isArray(first.content) ? first.content : []), { type: 'text' as const, text: 'streamed' }] };
    expect(collect([delta])).toBe(before);
    const updated = message('first', 'turn-one', { ...tool, result: JSON.stringify({ results: [{ ...source, url: 'https://example.org/' }] }) });
    const after = collect([updated]);
    expect(after).not.toBe(before);
    expect(after.get(citationScope(first))).not.toBe(before.get(citationScope(first)));
  });

  it('isolates legacy rows without turn identity and ignores nested child sources', () => {
    const legacy = message('legacy');
    const answer = { ...message('answer'), content: 'Claim' };
    const parent = message('parent', 'new-turn', { id: 'parent', name: 'Agent', streamIndex: 0, input: {}, subagentCalls: [{ id: 'child', name: 'WebSearch', input: {}, result: tool.result }] });
    const index = createWebSearchCitationIndex()([legacy, answer, parent]);
    expect(index.get(citationScope(legacy))?.get(source.ref_id)).toBeDefined();
    expect(index.get(citationScope(answer))).toBeUndefined();
    expect(index.get(citationScope(parent))).toBeUndefined();
  });

  it('makes conflicting source IDs unresolved while allowing exact repeated sources', () => {
    const conflict = message('second', 'same-turn', { ...tool, id: 'search-2', result: JSON.stringify({ results: [{ ...source, url: 'https://example.org/' }] }) });
    const first = message('first', 'same-turn');
    const collect = createWebSearchCitationIndex();
    expect(collect([first, { ...first, id: 'repeat' }]).get(citationScope(first))?.get(source.ref_id)).toBeDefined();
    expect(collect([first, conflict, { ...first, id: 'repeat' }]).get(citationScope(first))?.get(source.ref_id)).toBeNull();
  });

  it.each(['Query: only summary', '{bad json}', '{"results":[]}', '{"results":[{"title":"No ID","url":"https://example.com/"}]}'])('uses no invented sources for old/malformed result: %s', result => {
    expect(createWebSearchCitationIndex()([message('row', 'turn', { ...tool, result })]).size).toBe(0);
  });
});
