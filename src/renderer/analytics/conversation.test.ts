import { describe, expect, it } from 'vitest';
import { messageCompletionParams } from './conversation';

describe('conversation completion analytics', () => {
  it('keeps absent usage unknown while preserving reported zeros', () => {
    expect(messageCompletionParams('dsh', null, {})).toEqual({ runtime: 'dsh', runtime_source: 'integrated' });
    expect(messageCompletionParams('dsh', null, { input_tokens: 0, output_tokens: 24, duration_ms: 0 })).toEqual({ runtime: 'dsh', runtime_source: 'integrated', input_tokens: 0, output_tokens: 24, duration_ms: 0 });
  });

  it('separates managed/system Codex and ignores invalid optional telemetry', () => {
    expect(messageCompletionParams('codex', 'managed-provider', { cache_read_tokens: -1, duration_ms: NaN })).toEqual({ runtime: 'codex', runtime_source: 'managed-provider' });
    expect(messageCompletionParams('builtin', 'integrated', null)).toEqual({ runtime: 'builtin', runtime_source: null });
    expect(messageCompletionParams('unknown', 'system-cli', null)).toEqual({ runtime: 'unknown', runtime_source: null });
  });
});
