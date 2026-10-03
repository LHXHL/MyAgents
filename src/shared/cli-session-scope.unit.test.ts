import { describe, expect, it } from 'vitest';
import { cliSessionScopeError } from './cli-session-scope';

describe('CLI Product Session scope', () => {
  it('accepts exact current scope and leaves unscoped terminal management available', () => {
    expect(cliSessionScopeError('product-a', 'product-a')).toBeUndefined();
    expect(cliSessionScopeError(null, 'product-a')).toBeUndefined();
    expect(cliSessionScopeError(null, undefined)).toBeUndefined();
  });

  it('refuses another workspace, Global Sidecar, old materialization and malformed scope', () => {
    for (const [requested, current] of [
      ['product-a', 'product-b'], ['product-a', undefined], ['pending-a', 'materialized-a'],
      ['', ''], ['a/b', 'a/b'], ['a'.repeat(100), 'a'.repeat(100)],
    ]) expect(cliSessionScopeError(requested!, current)).toMatchObject({ code: 'CLI_SESSION_SCOPE_MISMATCH', success: false });
  });
});
