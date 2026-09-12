import { describe, expect, it, vi } from 'vitest';

import { buildDshQuestionAnswer, reconcileExpiredDshInteractionResponse } from './interaction-response';

describe('DSH question answers', () => {
  it('preserves selected labels and custom text independently, including commas', () => {
    expect(buildDshQuestionAnswer('q', {
      selected: ['One, two', 'Three'], custom: 'Write locally, then continue',
    }, ['One, two', 'Three'], true)).toEqual({
      id: 'q', selected: ['One, two', 'Three'], custom: 'Write locally, then continue',
    });
  });

  it('interprets legacy strings using the question options without splitting free text', () => {
    expect(buildDshQuestionAnswer('q', 'One, two', ['One, two', 'Three'], false))
      .toEqual({ id: 'q', selected: ['One, two'] });
    expect(buildDshQuestionAnswer('q', 'One,Three', ['One', 'Three'], true))
      .toEqual({ id: 'q', selected: ['One', 'Three'] });
    expect(buildDshQuestionAnswer('q', 'Write locally, then continue', ['One', 'Three'], false))
      .toEqual({ id: 'q', selected: [], custom: 'Write locally, then continue' });
  });
});

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
