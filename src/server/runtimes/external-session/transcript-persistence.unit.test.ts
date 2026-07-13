import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveSessionMessages, updateSessionMetadata } from '../../SessionStore';

import {
  appendAndPersistExternalAssistantTurn,
  clearExternalSessionMessages,
  getExternalSessionMessagesSnapshot,
  getExternalTranscriptSessionId,
  persistExternalUserMessageAppend,
  pushExternalSessionMessage,
  resetExternalTranscriptState,
  setExternalSessionMessages,
  setLastPersistedRuntimeUsageTotals,
} from './transcript-persistence';
import type { SessionMessage } from '../../types/session';

vi.mock('../../SessionStore', () => ({
  saveSessionMessages: vi.fn(),
  updateSessionMetadata: vi.fn(),
}));

function okSave(count: number) {
  return { ok: true as const, action: 'appended' as const, count, totalCount: count };
}

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
    vi.mocked(saveSessionMessages).mockReset();
    vi.mocked(updateSessionMetadata).mockReset();
    vi.mocked(saveSessionMessages).mockResolvedValue(okSave(1));
    vi.mocked(updateSessionMetadata).mockResolvedValue(null);
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

  it('refreshes recency when persisting a human user message', async () => {
    setExternalSessionMessages('session-a', [
      { id: 'old', role: 'assistant', content: 'old answer', timestamp: '2026-01-01T00:00:00.000Z' },
    ]);
    pushExternalSessionMessage(message('human-query'));
    vi.mocked(saveSessionMessages).mockResolvedValueOnce(okSave(2));

    await persistExternalUserMessageAppend('session-a', 'human-query', 'persist human query');

    expect(updateSessionMetadata).toHaveBeenCalledWith('session-a', {
      lastActiveAt: expect.any(String),
      lastMessagePreview: 'human-query',
    });
  });

  it('refreshes recency for an attachment-only human user message', async () => {
    const attachmentOnly: SessionMessage = {
      id: 'image-query',
      role: 'user',
      content: '',
      timestamp: '2026-01-08T00:00:00.000Z',
      attachments: [{
        id: 'image-1',
        name: 'image.png',
        mimeType: 'image/png',
        path: 'image.png',
      }],
    };
    setExternalSessionMessages('session-a', [attachmentOnly]);

    await persistExternalUserMessageAppend('session-a', 'image-query', 'persist image query');

    expect(updateSessionMetadata).toHaveBeenCalledWith('session-a', {
      lastActiveAt: expect.any(String),
      lastMessagePreview: undefined,
    });
  });

  it('does not refresh recency for a persisted memory-update dispatch row', async () => {
    const memoryDispatch: SessionMessage = {
      id: 'memory-dispatch',
      role: 'user',
      content: '<system-reminder><MEMORY_UPDATE>maintain</MEMORY_UPDATE></system-reminder>',
      timestamp: '2026-01-08T00:00:00.000Z',
    };
    setExternalSessionMessages('session-a', [message('old-human'), memoryDispatch]);
    vi.mocked(saveSessionMessages).mockResolvedValueOnce(okSave(2));

    await persistExternalUserMessageAppend(
      'session-a',
      'memory-dispatch',
      'persist memory dispatch',
    );

    expect(updateSessionMetadata).toHaveBeenCalledWith('session-a', {
      lastMessagePreview: 'old-human',
    });
  });

  it('does not refresh recency for an assistant maintenance result but preserves usage metadata', async () => {
    setExternalSessionMessages('session-a', [message('old-human')]);
    const runtimeUsageTotals = { inputTokens: 10, outputTokens: 2 };
    const contextUsage = {
      contextTokens: 10,
      contextWindow: 200_000,
      usedPercent: 0.005,
      source: 'codex' as const,
      windowSource: 'runtime' as const,
    };
    setLastPersistedRuntimeUsageTotals(runtimeUsageTotals);
    vi.mocked(saveSessionMessages).mockResolvedValueOnce(okSave(2));

    await appendAndPersistExternalAssistantTurn({
      sessionId: 'session-a',
      content: JSON.stringify([{ type: 'text', text: 'MEMORY_UPDATE_OK' }]),
      usage: null,
      toolCount: 0,
      contextUsage,
    });

    expect(updateSessionMetadata).toHaveBeenCalledWith('session-a', {
      lastMessagePreview: 'old-human',
      runtimeUsageTotals,
      lastContextUsage: contextUsage,
    });
  });
});
