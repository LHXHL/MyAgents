import { describe, expect, it } from 'vitest';
import { recoverDshSegmentTail, reconcileDshV2Assistant } from './dsh-product-projection';
import type { SessionMessage } from '../types/session';
const message = (id: string, text: string): SessionMessage => ({ id, role: 'assistant', timestamp: 't', content: JSON.stringify([{ type: 'text', text, id: `${id}-block` }]) });
describe('DSH V2 native recovery preserves Product segments', () => {
  it('recovers only the suffix absent from an earlier displayed segment', () => {
    expect(JSON.parse(recoverDshSegmentTail(message('full', 'beforeafter'), [message('first', 'before')]))).toEqual([expect.objectContaining({ text: 'after' })]);
    expect(() => recoverDshSegmentTail(message('full', 'other'), [message('first', 'before')])).toThrow('prefix');
  });
  it('preserves the tail block identity while confirming partial text and terminal ownership', () => {
    const rows: SessionMessage[] = [{ id: 'user', role: 'user', content: 'hello', timestamp: 't', turnId: 'user' },
      { ...message('first', 'before'), turnId: 'user' },
      { id: 'steer', role: 'user', content: 'more', timestamp: 't', turnId: 'user' },
      { ...message('last', 'af'), turnId: 'user', transcriptState: 'interrupted' }];
    const assistant = { ...message('full', 'beforeafter'), runtimeTurnAnchor: { turnId: 'native-turn', rootUserMessageId: 'user' } };
    const root = { clientUserMessageId: 'user', productTurnId: 'native-turn', consumedUserMessageIds: ['steer'] };
    expect(reconcileDshV2Assistant(rows, assistant, root)).toBe(true);
    expect(JSON.parse(rows[3]!.content)).toEqual([expect.objectContaining({ id: 'last-block', text: 'after' })]);
    expect(rows[1]!.runtimeTurnAnchor).toBeUndefined();
    expect(reconcileDshV2Assistant(rows, assistant, root)).toBe(false);
  });
  it('confirms a late tool result in its original pre-steer segment during recovery', () => {
    const tool = { type: 'tool_use', id: 'product-block', tool: { id: 'native-tool', name: 'Shell', input: {}, result: 'part', isLoading: true } };
    const rows: SessionMessage[] = [{ id: 'user', role: 'user', content: 'hello', timestamp: 't', turnId: 'user' },
      { ...message('first', ''), content: JSON.stringify([tool]), turnId: 'user' },
      { id: 'steer', role: 'user', content: 'more', timestamp: 't', turnId: 'user' },
      { ...message('last', 'ans'), turnId: 'user', transcriptState: 'interrupted' }];
    const assistant: SessionMessage = { ...message('full', ''), content: JSON.stringify([
      { ...tool, tool: { ...tool.tool, result: 'complete result', isLoading: false } }, { type: 'text', text: 'answer' },
    ]), runtimeTurnAnchor: { turnId: 'native-turn', rootUserMessageId: 'user' } };
    expect(reconcileDshV2Assistant(rows, assistant, { clientUserMessageId: 'user', productTurnId: 'native-turn', consumedUserMessageIds: ['steer'] })).toBe(true);
    expect(JSON.parse(rows[1]!.content)).toEqual([expect.objectContaining({ id: 'product-block', tool: expect.objectContaining({ result: 'complete result', isLoading: false }) })]);
    expect(rows[3]!.content).not.toContain('native-tool');
  });

  it('creates a recovered tail after the last consumed input when only the pre-steer segment survived', () => {
    const rows: SessionMessage[] = [{ id: 'user', role: 'user', content: 'hello', timestamp: 't', turnId: 'user' },
      { ...message('first', 'before'), turnId: 'user' },
      { id: 'steer', role: 'user', content: 'more', timestamp: 't', turnId: 'user' }];
    const assistant = { ...message('full', 'beforeafter'), runtimeTurnAnchor: { turnId: 'native-turn', rootUserMessageId: 'user' } };
    expect(reconcileDshV2Assistant(rows, assistant, { clientUserMessageId: 'user', productTurnId: 'native-turn', consumedUserMessageIds: ['steer'] })).toBe(true);
    expect(rows.map(row => row.id)).toEqual(['user', 'first', 'steer', 'full']);
    expect(JSON.parse(rows[1]!.content)[0].text).toBe('before');
    expect(JSON.parse(rows[3]!.content)[0].text).toBe('after');
    expect(rows[1]!.runtimeTurnAnchor).toBeUndefined();
  });

});
