import { describe, expect, it } from 'vitest';

import {
  buildResumeAnchorReplayItem,
  extractSdkMissingResumeMessageUuid,
  isSdkMissingResumeMessageError,
  shouldSuppressRecoveredResumeAnchorError,
} from './resume-error-recovery';

describe('resume-error-recovery', () => {
  it('detects SDK resumeSessionAt missing-message errors', () => {
    expect(isSdkMissingResumeMessageError(
      'Claude Code returned an error result: No message found with message.uuid of: a1',
    )).toBe(true);
    expect(isSdkMissingResumeMessageError('No conversation found')).toBe(false);
  });

  it('extracts the rejected SDK message uuid when present', () => {
    expect(extractSdkMissingResumeMessageUuid(
      'Claude Code returned an error result: No message found with message.uuid of: 75c9051f-a071-4243-bc25-92cfc396e2db',
    )).toBe('75c9051f-a071-4243-bc25-92cfc396e2db');
    expect(extractSdkMissingResumeMessageUuid('No message found with message.uuid')).toBeUndefined();
  });

  it('suppresses missing-message errors only after a stale anchor was actually cleared', () => {
    const errorMessage = 'Claude Code returned an error result: No message found with message.uuid of: a1';

    expect(shouldSuppressRecoveredResumeAnchorError({
      errorMessage,
      recoveredAnchors: ['reload'],
    })).toBe(true);
    expect(shouldSuppressRecoveredResumeAnchorError({
      errorMessage,
      recoveredAnchors: ['rewind', 'fork'],
    })).toBe(true);
    expect(shouldSuppressRecoveredResumeAnchorError({
      errorMessage,
      recoveredAnchors: [],
    })).toBe(false);
  });

  it('does not hide unrelated SDK errors even if recovery state was present', () => {
    expect(shouldSuppressRecoveredResumeAnchorError({
      errorMessage: 'No conversation found',
      recoveredAnchors: ['reload'],
    })).toBe(false);
  });

  it('clones a current turn for replay while preserving caller correlation fields', () => {
    let resolved = false;
    const source = {
      id: 'turn-1',
      requestId: 'request-1',
      inboxMeta: { replyBack: true, originalMessageId: 'msg-1' },
      resolve: () => { resolved = true; },
    };

    const replay = buildResumeAnchorReplayItem(source);

    expect(replay).toMatchObject({
      id: 'turn-1',
      requestId: 'request-1',
      inboxMeta: { replyBack: true, originalMessageId: 'msg-1' },
    });
    expect(replay).not.toBe(source);
    replay?.resolve();
    expect(resolved).toBe(false);
    expect(buildResumeAnchorReplayItem(null)).toBeNull();
  });
});
