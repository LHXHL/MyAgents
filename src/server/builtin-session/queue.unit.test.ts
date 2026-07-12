import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginPromotedItem,
  cancelTurnAdmissionTicket,
  cancelPromotedItem,
  clearPromotedItem,
  hasQueuedTurnByOwner,
  isPromotedItemCanceled,
  isPromotedItemInFlight,
  getTurnAdmissionIdentity,
  resetQueueForTest,
  setTurnAdmissionTicket,
} from './queue';
import type { MessageQueueItem } from './types';

function queueItem(id: string): MessageQueueItem {
  return {
    id,
    message: { role: 'user', content: [{ type: 'text', text: 'continue Goal' }] },
    messageText: 'continue Goal',
    wasQueued: false,
    resolve: () => undefined,
    turnOwner: { kind: 'goal', id: 'goal-1' },
  };
}

describe('builtin promoted queue item', () => {
  beforeEach(() => {
    resetQueueForTest();
  });

  it('keeps one stable identity cancellable during dispatch promotion', () => {
    const cancelDispatch = vi.fn();
    const item = queueItem('goal-turn');
    item.beforeDispatch = Object.assign(async () => ({ accepted: true }), {
      cancel: cancelDispatch,
    });
    beginPromotedItem(item);

    expect(isPromotedItemInFlight()).toBe(true);
    expect(hasQueuedTurnByOwner({ kind: 'goal', id: 'goal-1' })).toBe(true);
    expect(hasQueuedTurnByOwner({ kind: 'goal', id: 'goal-2' })).toBe(false);
    expect(cancelPromotedItem('other-turn')).toBeNull();
    expect(cancelPromotedItem('goal-turn')).toBe(item);
    expect(cancelDispatch).toHaveBeenCalledOnce();
    expect(isPromotedItemCanceled('goal-turn')).toBe(true);

    clearPromotedItem('goal-turn');
    expect(isPromotedItemInFlight()).toBe(false);
  });

  it('publishes and cancels the owner identity during turn admission', () => {
    const cancelDispatch = vi.fn();
    const beforeDispatch = Object.assign(async () => ({ accepted: true }), {
      cancel: cancelDispatch,
    });
    setTurnAdmissionTicket({
      queueId: 'goal-admission',
      createdAt: 1,
      messageText: 'continue Goal',
      turnOwner: { kind: 'goal', id: 'goal-1' },
      beforeDispatch,
      canceled: false,
    });

    expect(getTurnAdmissionIdentity()).toEqual({
      queueId: 'goal-admission',
      owner: { kind: 'goal', id: 'goal-1' },
    });
    expect(hasQueuedTurnByOwner({ kind: 'goal', id: 'goal-1' })).toBe(true);

    const canceled = cancelTurnAdmissionTicket('goal-admission');
    expect(canceled?.canceled).toBe(true);
    expect(cancelDispatch).toHaveBeenCalledOnce();
    expect(getTurnAdmissionIdentity()).toBeNull();
  });
});
