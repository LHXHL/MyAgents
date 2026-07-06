import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

async function loadSpaceCloud() {
  vi.resetModules();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: {} },
  });
  const mod = await import('./spaceCloud');
  const { i18n } = await import('@/i18n');
  await i18n.changeLanguage('zh-CN');
  return mod;
}

beforeEach(() => {
  mocks.invoke.mockReset();
});

describe('spaceCloud API errors', () => {
  it('normalizes issue comment transport errors without leaking the raw URL', async () => {
    const { spaceCommentIssue, spaceErrorMessage } = await loadSpaceCloud();
    mocks.invoke.mockRejectedValueOnce(
      new Error(
        'Space API request failed: error sending request for url (https://space.myagents.io/api/issues/iss_123/comments)',
      ),
    );

    let thrown: unknown;
    try {
      await spaceCommentIssue('iss_123', 'hello');
    } catch (error) {
      thrown = error;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toBe('评论发送失败，请检查网络或稍后重试');
    expect(spaceErrorMessage(thrown)).toBe('评论发送失败，请检查网络或稍后重试');
    expect(message).not.toContain('https://space.myagents.io');
  });

  it('redacts URLs, bearer tokens, and local paths from debug details', async () => {
    const { normalizeSpaceError } = await loadSpaceCloud();
    const normalized = normalizeSpaceError(
      new Error(
        'Space API request failed: Bearer secret.token /Users/ethan/.myagents/space/session.json https://space.myagents.io/api/issues',
      ),
      { method: 'POST', path: '/api/issues/iss_123/comments' },
    );

    expect(normalized.userMessage).toBe('评论发送失败，请检查网络或稍后重试');
    expect(normalized.debugMessage).not.toContain('secret.token');
    expect(normalized.debugMessage).not.toContain('/Users/ethan');
    expect(normalized.debugMessage).not.toContain('https://space.myagents.io');
  });

  it('normalizes issue comment business errors from the Space envelope', async () => {
    const { spaceCommentIssue } = await loadSpaceCloud();
    mocks.invoke.mockResolvedValueOnce({ success: false, error: 'permission denied' });

    await expect(spaceCommentIssue('iss_123', 'hello')).rejects.toThrow('评论发送失败：permission denied');
  });

  it('uses structured Space error envelopes when available', async () => {
    const { spaceCommentIssue, normalizeSpaceError } = await loadSpaceCloud();
    const envelope = {
      success: false,
      error: 'Not authenticated',
      code: 'NOT_AUTHENTICATED',
      requestId: 'req_123',
      recoveryHint: { message: 'Login with Google from MyAgents Cloud Space.' },
    };
    mocks.invoke.mockResolvedValueOnce(envelope);

    await expect(spaceCommentIssue('iss_123', 'hello')).rejects.toThrow('评论发送失败：请重新登录 MyAgents 社区');

    const normalized = normalizeSpaceError(envelope, { method: 'POST', path: '/api/issues/iss_123/comments' });
    expect(normalized.userMessage).toBe('评论发送失败：请重新登录 MyAgents 社区');
    expect(normalized.debugMessage).toContain('NOT_AUTHENTICATED');
    expect(normalized.debugMessage).toContain('req_123');
  });

  it('preserves Space business error codes for field-level handling', async () => {
    const { spaceCreateSpace, spaceErrorCode, spaceErrorMessage } = await loadSpaceCloud();
    mocks.invoke.mockResolvedValueOnce({
      success: false,
      error: 'Space slug already exists',
      code: 'SPACE_SLUG_CONFLICT',
      requestId: 'req_slug',
    });

    let thrown: unknown;
    try {
      await spaceCreateSpace({ name: 'Duplicate Lab', slug: 'duplicate-lab' });
    } catch (error) {
      thrown = error;
    }

    expect(spaceErrorCode(thrown)).toBe('SPACE_SLUG_CONFLICT');
    expect(spaceErrorMessage(thrown)).toBe('Space 创建失败：这个 Space slug 已被占用，请换一个');
  });

  it('returns Space data from successful envelopes', async () => {
    const { spaceCommentIssue } = await loadSpaceCloud();
    const comment = {
      id: 'cmt_1',
      author: { id: 'user-1', type: 'user' },
      body: 'hello',
      createdAt: '2026-06-24T00:00:00.000Z',
    };
    mocks.invoke.mockResolvedValueOnce({ success: true, data: { comment } });

    await expect(spaceCommentIssue('iss_123', 'hello')).resolves.toEqual({ comment });
  });
});
