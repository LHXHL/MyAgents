import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearExternalSessionMessages,
  getExternalSessionMessagesSnapshot,
  getExternalTranscriptSessionId,
  resetExternalTranscriptState,
  setExternalSessionMessages,
} from './transcript-persistence';
import type { SessionMessage } from '../../types/session';

function message(id: string): SessionMessage {
  return {
    id,
    role: 'user',
    content: id,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

describe('external transcript persistence owner', () => {
  beforeEach(() => {
    resetExternalTranscriptState();
  });

  it('tracks which session owns the in-memory transcript', () => {
    setExternalSessionMessages('session-a', [message('a-1')]);

    expect(getExternalTranscriptSessionId()).toBe('session-a');
    expect(getExternalSessionMessagesSnapshot().map((item) => item.id)).toEqual(['a-1']);

    clearExternalSessionMessages('session-b');

    expect(getExternalTranscriptSessionId()).toBe('session-b');
    expect(getExternalSessionMessagesSnapshot()).toEqual([]);
  });

  it('clears transcript ownership on full reset', () => {
    setExternalSessionMessages('session-a', [message('a-1')]);

    resetExternalTranscriptState();

    expect(getExternalTranscriptSessionId()).toBe('');
    expect(getExternalSessionMessagesSnapshot()).toEqual([]);
  });
});
