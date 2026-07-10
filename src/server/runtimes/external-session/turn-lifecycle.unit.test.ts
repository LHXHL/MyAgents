import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginExternalTurnPromotion,
  cancelExternalTurnPromotion,
  finishExternalTurnPromotion,
  isExternalTurnPromotionCurrent,
  isExternalTurnPromotionInFlight,
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

  it('invalidates a guarded turn promotion exactly once on Stop', () => {
    const promotion = beginExternalTurnPromotion();
    expect(promotion).not.toBeNull();
    expect(beginExternalTurnPromotion()).toBeNull();
    expect(isExternalTurnPromotionInFlight()).toBe(true);
    expect(isExternalTurnPromotionCurrent(promotion!)).toBe(true);

    expect(cancelExternalTurnPromotion()).toBe(true);
    expect(cancelExternalTurnPromotion()).toBe(false);
    expect(isExternalTurnPromotionCurrent(promotion!)).toBe(false);
    expect(isExternalTurnPromotionInFlight()).toBe(false);

    finishExternalTurnPromotion(promotion!);
    expect(isExternalTurnPromotionInFlight()).toBe(false);
  });
});
