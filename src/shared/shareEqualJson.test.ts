import { describe, expect, it } from 'vitest';
import { shareEqualJson } from './shareEqualJson';

describe('shareEqualJson', () => {
  it('retains equal snapshots regardless of object property order', () => {
    const before = { agents: [{ id: 'a', channels: [] }], enabled: true };
    expect(shareEqualJson(before, { enabled: true, agents: [{ channels: [], id: 'a' }] })).toBe(before);
  });

  it('publishes changes while preserving untouched nested identities', () => {
    const before = { ui: 'dark', agents: [{ id: 'a' }], mcp: { env: { token: 'synthetic' } } };
    const after = { ...structuredClone(before), ui: 'light' };
    const result = shareEqualJson(before, after);
    expect(result).toEqual(after);
    expect(result).not.toBe(before);
    expect(result.agents).toBe(before.agents);
    expect(result.mcp).toBe(before.mcp);
    expect(before.ui).toBe('dark');
  });

  it('preserves deletions, array order, null, and optional field presence', () => {
    expect(shareEqualJson({ a: 1 }, {})).toEqual({});
    expect(shareEqualJson([1, 2], [2, 1])).toEqual([2, 1]);
    expect(shareEqualJson<unknown>({}, [])).toEqual([]);
    expect(shareEqualJson<unknown>({}, null)).toBeNull();
    expect(Object.hasOwn(shareEqualJson<unknown>({}, { a: undefined }) as object, 'a')).toBe(true);
  });

  it('treats JSON __proto__ as an own data property', () => {
    const next = JSON.parse('{"__proto__":{"value":"data"}}');
    const result = shareEqualJson({}, next);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result).toEqual(next);
  });
});
