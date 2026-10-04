import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  managementApi: vi.fn(),
  history: vi.fn(),
  overlay: vi.fn(),
  liveState: vi.fn(),
}));

vi.mock('./SessionStore', () => ({
  getSessionData: mocks.history,
  isHistoryVisibleSession: () => true,
}));
vi.mock('./session-engine', () => ({
  getSessionEngine: () => ({
    getLiveSessionOverlay: mocks.overlay,
    getLiveSessionState: mocks.liveState,
  }),
}));

vi.mock('./utils/management-api-client', () => ({
  managementApi: mocks.managementApi,
}));

import type { SessionMessage } from './types/session';
import {
  mergeSessionMessagesByIdentity,
  paginateSessionTextMessages,
  projectSessionTextMessage,
  readLocalSessionTextPage,
  readSessionTextPage,
  SessionTextProjectionError,
  strictAssistantText,
  type SessionTextMessage,
} from './session-text-projection';
import { buildSessionEventPrompt } from './inbox/drain-handler';
import { renderSessionEventPrompt } from './inbox/session-event';

function message(
  id: string,
  role: SessionMessage['role'],
  content: string,
): SessionMessage {
  return {
    id,
    role,
    content,
    timestamp: `2026-09-19T00:00:0${id}.000Z`,
  } as SessionMessage;
}

describe('session text projection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.history.mockResolvedValue({ id: 'target-session', messages: [] });
    mocks.overlay.mockReturnValue({ isActive: false });
    mocks.liveState.mockReturnValue({ sessionState: 'idle', isBusy: false });
  });

  it.each([true, false])('reads the visible Inbox request for replyBack=%s without its control envelope', replyBack => {
    const prompt = buildSessionEventPrompt({
      messageId: 'request-1', kind: 'request', fromSessionId: 'source',
      fromLabel: 'Agent@Example-Win', toSessionId: 'target',
      text: 'Please inspect\nthe workspace.', replyBack, timestampMs: 1,
    });
    const projected = projectSessionTextMessage(message('1', 'user', prompt));
    expect(projected?.content).toBe('Please inspect\nthe workspace.');
    expect(projected?.content).not.toContain('event-summary');
    expect(projected?.content).not.toContain('source_session_id');
  });

  it('prefers the visible tail and keeps result/watch/internal reminders hidden', () => {
    const prompt = buildSessionEventPrompt({
      messageId: 'request-1', kind: 'request', fromSessionId: 'source',
      fromLabel: 'Agent', toSessionId: 'target', text: 'inside payload',
      replyBack: false, timestampMs: 1,
    });
    expect(projectSessionTextMessage(message('1', 'user', `${prompt}\nVisible tail`)))
      .toMatchObject({ content: 'Visible tail' });
    const result = renderSessionEventPrompt({
      version: 1, type: 'send.result', eventId: 'result', requestEventId: 'request',
      sourceSessionId: 'source', sourceLabel: 'Agent', targetSessionId: 'target',
      createdAt: 'now', status: 'ok', terminalReason: 'completed', payload: 'hidden result',
    });
    const watch = renderSessionEventPrompt({
      version: 1, type: 'watch.completed', eventId: 'watch-event', watchId: 'watch',
      sourceSessionId: 'source', sourceLabel: 'Agent', targetSessionId: 'target',
      createdAt: 'now', targetStateAtRegistration: 'running', finalState: 'idle',
      terminalReason: 'completed', latestResult: 'hidden watch result',
    });
    for (const content of [result, watch, '<system-reminder><MEMORY_UPDATE>private</MEMORY_UPDATE></system-reminder>']) {
      expect(projectSessionTextMessage(message('1', 'user', content))).toBeNull();
    }
  });

  it.each(['builtin', 'dsh', 'codex'])('uses the authoritative three-state projection for an active %s owner', async runtime => {
    mocks.overlay.mockReturnValue({ isActive: true, runtime, liveSessionState: 'running', inMemoryMessages: [] });
    for (const [state, expected] of [
      [{ sessionState: 'running', isBusy: true, waitingForUser: true }, 'waiting_user'],
      [{ sessionState: 'starting', isBusy: false }, 'running'],
      [{ sessionState: 'running', isBusy: true }, 'running'],
      [{ sessionState: 'idle', isBusy: false }, 'idle'],
      [{ sessionState: 'error', isBusy: false }, 'idle'],
    ]) {
      mocks.liveState.mockReturnValue(state);
      expect(await readLocalSessionTextPage({ sessionId: 'target-session' }))
        .toMatchObject({ session: { isLive: true, liveSessionState: expected } });
    }
  });

  it('reads an authenticated external request and live V2 request text through the same display projection', async () => {
    const prompt = buildSessionEventPrompt({
      messageId: 'external-request', kind: 'request', sourceKind: 'external-cli',
      fromLabel: 'External CLI', toSessionId: 'target-session', text: 'one-way work',
      replyBack: false, timestampMs: 1,
    });
    mocks.history.mockResolvedValue({ id: 'target-session', transcriptFormat: 2, messages: [message('old', 'assistant', 'stale disk')] });
    mocks.overlay.mockReturnValue({
      isActive: true, liveSessionState: 'running',
      inMemoryMessages: [message('1', 'user', prompt)],
      liveStreamingMessage: message('2', 'assistant', 'live answer'),
    });
    expect(await readLocalSessionTextPage({ sessionId: 'target-session' }))
      .toMatchObject({ session: { messages: [
        { id: '1', role: 'user', content: 'one-way work' },
        { id: '2', role: 'assistant', content: 'live answer' },
      ] } });
  });

  it('reads persisted request/answer pairs and keeps cold live-state absence without sampling the caller', async () => {
    const prompt = buildSessionEventPrompt({
      messageId: 'request-1', kind: 'request', fromSessionId: 'source',
      fromLabel: 'Agent', toSessionId: 'target', text: 'stored request',
      replyBack: true, timestampMs: 1,
    });
    mocks.history.mockResolvedValue({ id: 'target-session', messages: [
      message('1', 'user', prompt), message('2', 'assistant', 'stored answer'),
    ] });
    expect(await readLocalSessionTextPage({ sessionId: 'target-session', limit: 1, before: '2' }))
      .toMatchObject({ session: { isLive: false, liveSessionState: null, messages: [{ id: '1', content: 'stored request' }] } });
    expect(mocks.liveState).not.toHaveBeenCalled();
  });

  it('joins only top-level assistant text blocks and never falls back to tool JSON', () => {
    expect(
      strictAssistantText(
        JSON.stringify([
          { type: 'thinking', thinking: 'private chain' },
          { type: 'text', text: 'first' },
          { type: 'tool_use', id: 'tool-1', input: { secret: 'nope' } },
          { type: 'text', text: 'second' },
        ]),
      ),
    ).toBe('first\n\nsecond');

    expect(
      projectSessionTextMessage(
        message(
          '1',
          'assistant',
          JSON.stringify([
            { type: 'tool_use', id: 'tool-1', input: { secret: 'nope' } },
          ]),
        ),
      ),
    ).toBeNull();
  });

  it('fails closed for malformed structured content', () => {
    expect(() =>
      strictAssistantText('[{"type":"text","text":"cut off"}'),
    ).toThrowError(SessionTextProjectionError);
    expect(() =>
      strictAssistantText(JSON.stringify([
        { type: 'tool_use', input: { secret: 'must-not-leak' } },
        {},
      ])),
    ).toThrowError(SessionTextProjectionError);
    expect(() =>
      strictAssistantText(JSON.stringify([{ type: 'text', text: 42 }])),
    ).toThrowError(SessionTextProjectionError);
  });

  it('preserves ordinary user JSON even when it resembles assistant blocks', () => {
    const content = JSON.stringify([
      {
        type: 'text',
        text: 'This is user-authored JSON, not a transcript envelope.',
      },
      { type: 'tool_use', input: { keep: true } },
    ]);

    expect(
      projectSessionTextMessage(message('1', 'user', content)),
    ).toMatchObject({ content });
  });

  it('uses the active target Session owner projection instead of the caller overlay', async () => {
    const ownerProjection = {
      success: true,
      session: { id: 'target-session', messages: [], isLive: true },
    };
    mocks.managementApi.mockResolvedValue({
      ok: true,
      active: true,
      result: ownerProjection,
    });

    await expect(
      readSessionTextPage({ sessionId: 'target-session', limit: 5 }),
    ).resolves.toEqual(ownerProjection);
    expect(mocks.managementApi).toHaveBeenCalledWith(
      '/api/session/text-page',
      'POST',
      {
        sessionId: 'target-session',
        limit: 5,
      },
      { timeoutMs: 18_000 },
    );
  });

  it('preserves precise owner error codes', async () => {
    mocks.managementApi.mockResolvedValue({
      ok: false,
      code: 'session_owner_invalid_response',
      error: 'invalid JSON',
    });
    await expect(readSessionTextPage({ sessionId: 'target-session' }))
      .rejects.toMatchObject({ code: 'SESSION_OWNER_INVALID_RESPONSE' });
  });

  it('preserves a target owner content verdict without retry-layer relabeling', async () => {
    mocks.managementApi.mockResolvedValue({
      ok: false,
      code: 'SESSION_CONTENT_UNREADABLE',
      error: 'invalid assistant content blocks',
    });

    await expect(readSessionTextPage({ sessionId: 'target-session' }))
      .rejects.toMatchObject({ code: 'SESSION_CONTENT_UNREADABLE' });
  });

  it('overlays in-memory and streaming messages by stable identity without duplicates', () => {
    const disk = [
      message('1', 'user', 'old'),
      message('2', 'assistant', 'partial'),
    ];
    const memory = [
      message('2', 'assistant', 'complete'),
      message('3', 'user', 'next'),
    ];
    const merged = mergeSessionMessagesByIdentity(
      disk,
      memory,
      message('3', 'user', 'newest'),
    );

    expect(merged.map((item) => [item.id, item.content])).toEqual([
      ['1', 'old'],
      ['2', 'complete'],
      ['3', 'newest'],
    ]);
  });

  it('paginates after filtering, returns chronological order, and excludes the anchor', () => {
    const projected: SessionTextMessage[] = ['1', '2', '3', '4'].map((id) => ({
      id,
      role: 'assistant',
      timestamp: id,
      content: id,
    }));

    expect(paginateSessionTextMessages(projected, { limit: 2 })).toEqual({
      messages: projected.slice(2),
      hasMoreBefore: true,
    });
    expect(
      paginateSessionTextMessages(projected, { limit: 2, before: '3' }),
    ).toEqual({
      messages: projected.slice(0, 2),
      hasMoreBefore: false,
    });
    expect(() =>
      paginateSessionTextMessages(projected, { limit: 2, before: 'gone' }),
    ).toThrowError(/no longer exists/);
  });
});
