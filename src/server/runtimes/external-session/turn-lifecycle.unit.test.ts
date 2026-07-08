import { beforeEach, describe, expect, it } from 'vitest';

import {
  markExternalSessionComplete,
  markExternalTurnStarted,
  resetExternalTurnLifecycleState,
  setExternalTurnCompleted,
} from './turn-lifecycle';

describe('external turn lifecycle owner', () => {
  beforeEach(() => {
    resetExternalTurnLifecycleState();
  });

  it('ignores a prewarm process exit when no external turn started', () => {
    setExternalTurnCompleted(false);

    const plan = markExternalSessionComplete(
      { kind: 'session_complete', subtype: 'error', result: 'process exited' },
      {
        hasAssistantText: true,
        consumeUserRequestedStop: () => true,
      },
    );

    expect(plan).toEqual({ kind: 'ignore-prewarm-exit', subtype: 'error' });
  });

  it('routes a runtime-started resumed turn through user-stop handling', () => {
    setExternalTurnCompleted(false);
    markExternalTurnStarted(123);

    const plan = markExternalSessionComplete(
      { kind: 'session_complete', subtype: 'error', result: 'process exited' },
      {
        hasAssistantText: true,
        consumeUserRequestedStop: () => true,
      },
    );

    expect(plan.kind).toBe('suppress-user-stop');
  });
});
