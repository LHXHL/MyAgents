import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TITLE_TIMEOUT_MS,
  extractTitleTextFromSdkMessage,
} from './title-generator';

describe('extractTitleTextFromSdkMessage', () => {
  it('reads text even when a thinking block precedes it', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hidden reasoning' },
          { type: 'text', text: '会话标题' },
        ],
      },
    })).toBe('会话标题');
  });

  it('joins multiple assistant text blocks and ignores non-text blocks', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'MyAgents ' },
          { type: 'tool_use', id: 'toolu_1' },
          { type: 'text', text: '标题修复' },
        ],
      },
    })).toBe('MyAgents 标题修复');
  });

  it('falls back to the last assistant message from a success result', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'result',
      subtype: 'success',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'first draft' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '最终标题' }] },
      ],
    })).toBe('最终标题');
  });

  it('reads the SDK 0.3 result.result field when no assistant message is present', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'result',
      subtype: 'success',
      result: 'Result 字段标题',
    })).toBe('Result 字段标题');
  });

  it('returns null for whitespace-only or failed result messages', () => {
    expect(extractTitleTextFromSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '   ' }] },
    })).toBeNull();
    expect(extractTitleTextFromSdkMessage({
      type: 'result',
      subtype: 'error_during_execution',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ignored' }] }],
    })).toBeNull();
  });
});

describe('BUILTIN_TITLE_TIMEOUT_MS', () => {
  it('keeps builtin title generation within the same 30s budget as external title generation', () => {
    expect(BUILTIN_TITLE_TIMEOUT_MS).toBe(30_000);
  });
});
