import { describe, expect, it } from 'vitest';
import type { SessionMessage } from '../../shared/types/session-message';
import { selectBuiltinRewindBoundary } from './builtin-rewind-boundary';

const user: SessionMessage = { id: 'u', role: 'user', content: 'query', timestamp: 't', sdkUuid: 'native-u' };
const diagnostic: SessionMessage = { id: 'd', role: 'assistant', content: 'Error: exited', timestamp: 't', messageKind: 'diagnostic' };

describe('builtin retained native boundary', () => {
  it('skips only independent diagnostics and accepts the immediate native user UUID', () => {
    expect(selectBuiltinRewindBoundary([user, diagnostic, { ...diagnostic, id: 'd2' }]))
      .toEqual({ kind: 'exact', sdkUuid: 'native-u' });
  });

  it.each([{ prefix: [] }, { prefix: [diagnostic] }])('uses empty native history for $prefix', ({ prefix }) => {
    expect(selectBuiltinRewindBoundary(prefix)).toEqual({ kind: 'empty' });
  });

  it.each([
    { ...user, sdkUuid: undefined },
    { ...diagnostic, messageKind: undefined },
    { ...diagnostic, messageKind: undefined, content: 'real assistant fragment' },
  ])('does not search past real or unclassified content: %j', unknown => {
    expect(selectBuiltinRewindBoundary([user, unknown, diagnostic])).toEqual({ kind: 'unavailable' });
  });

  it.each([
    { ...diagnostic, role: 'user' as const },
    { ...diagnostic, sdkUuid: 'native-d' },
    { ...diagnostic, sdkUuid: '' },
    { ...diagnostic, runtimeTurnAnchor: { turnId: 'native-turn', rootUserMessageId: 'u' } },
    { ...diagnostic, runtimeOperationAnchor: { runtime: 'dsh' as const, clientOperationId: 'op', runtimeSessionId: 's' } },
  ])('refuses conflicting diagnostic provenance: %j', conflict => {
    expect(selectBuiltinRewindBoundary([user, conflict])).toEqual({ kind: 'unavailable' });
  });

  it('treats Error-prefixed native content as real content', () => {
    expect(selectBuiltinRewindBoundary([{ ...diagnostic, messageKind: undefined, sdkUuid: 'native-error' }]))
      .toEqual({ kind: 'exact', sdkUuid: 'native-error' });
  });
});
