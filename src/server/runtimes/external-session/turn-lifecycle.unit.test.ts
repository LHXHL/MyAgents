import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginExternalTurnPromotion,
  bindExternalTurn,
  cancelExternalTurnPromotion,
  finishExternalTurnPromotion,
  getExternalCurrentTurnIdentity,
  getExternalTurnTerminalGeneration,
  isExternalTurnPromotionCurrent,
  isExternalTurnPromotionInFlight,
  markExternalSessionComplete,
  markExternalTurnComplete,
  markExternalTurnStarted,
  notifyExternalTurnOutcome,
  notifyExternalTurnStopped,
  resetExternalTurnLifecycleState,
  setExternalTurnCompleted,
  waitForExternalTurnTerminalObserver,
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
    const cancelDispatch = vi.fn();
    const promotion = beginExternalTurnPromotion({
      queueId: 'goal-turn',
      owner: { kind: 'goal', id: 'goal-1' },
      cancelDispatch,
    });
    expect(promotion).not.toBeNull();
    expect(beginExternalTurnPromotion()).toBeNull();
    expect(isExternalTurnPromotionInFlight()).toBe(true);
    expect(isExternalTurnPromotionCurrent(promotion!)).toBe(true);
    expect(getExternalCurrentTurnIdentity()).toEqual({
      queueId: 'goal-turn',
      owner: { kind: 'goal', id: 'goal-1' },
    });

    expect(cancelExternalTurnPromotion()).toBe(true);
    expect(cancelDispatch).toHaveBeenCalledOnce();
    expect(cancelExternalTurnPromotion()).toBe(false);
    expect(isExternalTurnPromotionCurrent(promotion!)).toBe(false);
    expect(isExternalTurnPromotionInFlight()).toBe(false);

    finishExternalTurnPromotion(promotion!);
    expect(isExternalTurnPromotionInFlight()).toBe(false);
  });

  it('assigns one monotonic terminal generation to each runtime turn', () => {
    const before = getExternalTurnTerminalGeneration();
    markExternalTurnStarted(100);
    markExternalTurnComplete(
      { kind: 'turn_complete', status: 'completed' },
      { intentionalStopInProgress: false },
    );
    expect(getExternalTurnTerminalGeneration()).toBe(before + 1);

    markExternalSessionComplete(
      { kind: 'session_complete', subtype: 'success', result: '' },
      { hasAssistantText: true, consumeUserRequestedStop: () => false },
    );
    expect(getExternalTurnTerminalGeneration()).toBe(before + 1);

    setExternalTurnCompleted(false);
    markExternalTurnStarted(200);
    markExternalSessionComplete(
      { kind: 'session_complete', subtype: 'success', result: '' },
      { hasAssistantText: true, consumeUserRequestedStop: () => false },
    );
    expect(getExternalTurnTerminalGeneration()).toBe(before + 2);
  });

  it('notifies the current queue turn once without retaining an outcome cache', () => {
    const onTerminal = vi.fn();
    bindExternalTurn('queue-1', { kind: 'goal', id: 'goal-1' }, onTerminal);
    expect(getExternalCurrentTurnIdentity()).toEqual({
      queueId: 'queue-1',
      owner: { kind: 'goal', id: 'goal-1' },
    });

    const before = getExternalTurnTerminalGeneration();
    markExternalTurnStarted(100);
    markExternalTurnComplete(
      { kind: 'turn_complete', status: 'completed' },
      { intentionalStopInProgress: false },
    );
    notifyExternalTurnOutcome(before + 1, {
      success: true,
      text: 'target result',
    });
    notifyExternalTurnOutcome(before + 1, {
      success: true,
      text: 'duplicate',
    });

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith({
      status: 'complete',
      text: 'target result',
      assistantMessagePresent: true,
    });
    expect(getExternalCurrentTurnIdentity()).toBeNull();
  });

  it('settles the current queue turn when process stop has no terminal event', () => {
    const onTerminal = vi.fn();
    bindExternalTurn('queue-stop', { kind: 'goal', id: 'goal-1' }, onTerminal);

    notifyExternalTurnStopped('partial output');
    notifyExternalTurnStopped('duplicate');

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith({
      status: 'stopped',
      text: 'partial output',
      assistantMessagePresent: true,
      error: 'Execution stopped',
    });
    expect(getExternalCurrentTurnIdentity()).toBeNull();
  });

  it('keeps the next external turn behind an async terminal observer', async () => {
    let release!: () => void;
    bindExternalTurn('queue-barrier', undefined, () => new Promise<void>((resolve) => {
      release = resolve;
    }));

    notifyExternalTurnStopped('partial');
    let settled = false;
    void waitForExternalTurnTerminalObserver().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await waitForExternalTurnTerminalObserver();
    expect(settled).toBe(true);
  });
});
