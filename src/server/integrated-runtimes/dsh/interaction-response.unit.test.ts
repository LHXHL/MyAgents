import { describe, expect, it, vi } from 'vitest';

import { reconcileExpiredDshInteractionResponse } from './interaction-response';

describe('DSH interaction response reconciliation', () => {
  it('settles an interaction when DSH reports that it already expired', () => {
    const deletePendingInteraction = vi.fn();
    const onEvent = vi.fn();

    expect(
      reconcileExpiredDshInteractionResponse(
        'expired',
        'permission-expired',
        deletePendingInteraction,
        onEvent,
      ),
    ).toBe(true);
    expect(deletePendingInteraction).toHaveBeenCalledWith('permission-expired');
    expect(onEvent).toHaveBeenCalledWith({
      kind: 'interactive_request_resolved',
      requestId: 'permission-expired',
      status: 'expired',
    });
  });

  it('leaves non-expired responses for the caller to process', () => {
    const deletePendingInteraction = vi.fn();
    const onEvent = vi.fn();

    expect(
      reconcileExpiredDshInteractionResponse(
        'rejected',
        'permission-rejected',
        deletePendingInteraction,
        onEvent,
      ),
    ).toBe(false);
    expect(deletePendingInteraction).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });
});
