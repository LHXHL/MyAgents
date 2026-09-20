import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ managementApi: vi.fn() }));

vi.mock('./utils/management-api-client', () => ({
  managementApi: mocks.managementApi,
}));

import type { SessionMessage } from './types/session';
import {
  mergeSessionMessagesByIdentity,
  paginateSessionTextMessages,
  projectSessionTextMessage,
  readSessionTextPage,
  SessionTextProjectionError,
  strictAssistantText,
  type SessionTextMessage,
} from './session-text-projection';

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
    mocks.managementApi.mockReset();
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
