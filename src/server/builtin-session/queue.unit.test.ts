import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginPromotedItem,
  cancelPromotedItem,
  clearPromotedItem,
  hasQueuedTurnByOwner,
  isPromotedItemCanceled,
  isPromotedItemInFlight,
  resetQueueForTest,
} from './queue';

describe('builtin promoted queue item', () => {
  beforeEach(() => {
    resetQueueForTest();
  });

  it('keeps one stable identity cancellable during dispatch promotion', () => {
    const cancelDispatch = vi.fn();
    beginPromotedItem({
      queueId: 'goal-turn',
      messageText: 'continue Goal',
      turnOwner: { kind: 'goal', id: 'goal-1' },
      cancelDispatch,
    });

    expect(isPromotedItemInFlight()).toBe(true);
    expect(hasQueuedTurnByOwner({ kind: 'goal', id: 'goal-1' })).toBe(true);
    expect(hasQueuedTurnByOwner({ kind: 'goal', id: 'goal-2' })).toBe(false);
    expect(cancelPromotedItem('other-turn')).toBeNull();
    expect(cancelPromotedItem('goal-turn')).toBe('continue Goal');
    expect(cancelDispatch).toHaveBeenCalledOnce();
    expect(isPromotedItemCanceled('goal-turn')).toBe(true);

    clearPromotedItem('goal-turn');
    expect(isPromotedItemInFlight()).toBe(false);
  });
});
