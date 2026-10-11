import { describe, expect, it } from 'vitest';
import { ResponsesStreamTranslator } from './stream-responses';
import { translateResponsesResponse } from './response-responses';
import { translateRequestToResponses } from './request-responses';
import type { ResponsesResponse } from '../types/openai-responses';

const response = (status: ResponsesResponse['status'], reason?: string): ResponsesResponse => ({
  id: 'r', object: 'response', model: 'target', status, output: [],
  usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 },
  ...(reason ? { incomplete_details: { reason } } : {}),
});

describe('Responses terminal authority (#654)', () => {
  it('ends an incomplete stream immediately with max_tokens and terminal usage', () => {
    const t = new ResponsesStreamTranslator('target');
    const events = t.feed({ type: 'response.incomplete', response: response('incomplete', 'max_output_tokens') });
    expect(events).toContainEqual({ type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { input_tokens: 15, output_tokens: 5 } });
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
    expect(t.finalize()).toEqual([]);
    expect(t.feed({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'late' })).toEqual([]);
  });
  it('does not turn a failed response into successful assistant text', () => {
    const t = new ResponsesStreamTranslator('target');
    const events = t.feed({ type: 'response.failed', response: { ...response('failed'), error: { code: 'server_error', message: 'failure' } } });
    expect(events.some(e => e.type === 'error')).toBe(true);
    expect(events.some(e => e.type === 'message_stop')).toBe(false);
  });
  it.each(['max_output_tokens', 'content_filter', 'unknown'])('preserves incomplete reason %s in both response modes', reason => {
    const r = response('incomplete', reason);
    if (reason === 'max_output_tokens') expect(translateResponsesResponse(r, 'target').stop_reason).toBe('max_tokens');
    else expect(() => translateResponsesResponse(r, 'target')).toThrow(reason);
  });
  it('rejects non-terminal non-stream responses', () => {
    expect(() => translateResponsesResponse(response('in_progress'), 'target')).toThrow();
  });
  it('rejects EOF without a real protocol terminal, including an empty stream', () => {
    for (const started of [false, true]) {
      const t = new ResponsesStreamTranslator('target');
      if (started) t.feed({ type: 'response.created', response: response('in_progress') });
      const events = t.finalize();
      expect(events.some(e => e.type === 'error')).toBe(true);
      expect(events.some(e => e.type === 'message_stop')).toBe(false);
    }
  });
  it('never executes a truncated tool call', () => {
    const r = response('incomplete', 'max_output_tokens');
    r.output = [{ type: 'function_call', id: 'f', call_id: 'c', name: 'tool', arguments: '{', status: 'incomplete' }];
    expect(() => translateResponsesResponse(r, 'target')).toThrow();
  });
});

describe('Responses request semantics (#654)', () => {
  it.each(['auto', 'any', 'tool'] as const)('preserves parallel tool restriction for %s', type => {
    const out = translateRequestToResponses({ model: 'm', messages: [], max_tokens: 10,
      tool_choice: type === 'tool' ? { type, name: 'lookup', disable_parallel_tool_use: true } : { type, disable_parallel_tool_use: true },
      tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { optional: { type: 'string' } } } }],
    });
    expect(out.parallel_tool_calls).toBe(false);
    expect(out.tools?.[0].strict).toBe(false);
    expect(out.tools?.[0].parameters?.required).toBeUndefined();
    expect(out.store).toBe(false);
  });
  it('keeps instructions shape when no system block has a cache marker', () => {
    const out = translateRequestToResponses({ model: 'm', messages: [], max_tokens: 10,
      system: [{ type: 'text', text: 'instructions' }],
    }, { promptCacheBreakpoints: true });
    expect(out.instructions).toBe('instructions');
    expect(out.input).toEqual([]);
  });
});
