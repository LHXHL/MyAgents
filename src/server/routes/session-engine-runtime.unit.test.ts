import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {
    kind: 'builtin' as 'builtin' | 'external',
    runtime: 'codex',
  },
  engine: {
    updateRuntimeConfig: vi.fn(async () => ({ success: true })),
    prewarm: vi.fn(async () => ({ prewarmed: true })),
    respondPermission: vi.fn(async () => true),
  },
}));

vi.mock('../session-engine', () => ({
  getSessionEngine: () => mocks.engine,
  getSessionEngineKind: () => mocks.state.kind,
  getSessionRuntimeType: () => mocks.state.runtime,
  getPermissionResponseEngine: () => mocks.engine,
}));

import { handleSessionEngineRuntimeRoute } from './session-engine-runtime';

const deps = {
  workspacePath: '/workspace',
  resolvePrewarmSessionId: vi.fn((requested?: string) => requested ?? 'resolved-session'),
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('handleSessionEngineRuntimeRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.kind = 'builtin';
    mocks.state.runtime = 'codex';
  });

  it('returns null for unrelated routes', async () => {
    await expect(handleSessionEngineRuntimeRoute('/api/runtime/type', new Request('http://local/api/runtime/type'), deps))
      .resolves.toBeNull();
  });

  it('rejects runtime config when the active engine is builtin', async () => {
    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/config',
      new Request('http://local/api/runtime/config', {
        method: 'POST',
        body: JSON.stringify({ runtime: 'codex', runtimeConfig: { model: 'gpt-5' } }),
      }),
      deps,
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response!)).toMatchObject({
      success: false,
      error: 'Runtime config endpoint is only for external runtimes',
    });
    expect(mocks.engine.updateRuntimeConfig).not.toHaveBeenCalled();
  });

  it('applies external runtime config patches through the active engine', async () => {
    mocks.state.kind = 'external';

    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/config',
      new Request('http://local/api/runtime/config', {
        method: 'POST',
        body: JSON.stringify({
          runtime: 'codex',
          runtimeConfig: {
            model: 'gpt-5',
            permissionMode: null,
            reasoningEffort: 'high',
          },
        }),
      }),
      deps,
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response!)).toEqual({ success: true });
    expect(mocks.engine.updateRuntimeConfig).toHaveBeenCalledWith(
      { model: 'gpt-5', permissionMode: '', reasoningEffort: 'high' },
      { source: 'runtime-config' },
    );
  });

  it('preserves IM sync source on external runtime config patches', async () => {
    mocks.state.kind = 'external';

    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/config',
      new Request('http://local/api/runtime/config', {
        method: 'POST',
        body: JSON.stringify({
          runtime: 'codex',
          runtimeConfig: { model: 'channel-model' },
          source: 'im-sync',
        }),
      }),
      deps,
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response!)).toEqual({ success: true });
    expect(mocks.engine.updateRuntimeConfig).toHaveBeenCalledWith(
      { model: 'channel-model' },
      { source: 'im-sync' },
    );
  });

  it('prewarms external runtime sessions with resolved session id and workspace', async () => {
    mocks.state.kind = 'external';

    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/prewarm',
      new Request('http://local/api/runtime/prewarm', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5', permissionMode: 'no-restrictions' }),
      }),
      deps,
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response!)).toEqual({ success: true, prewarmed: true });
    expect(deps.resolvePrewarmSessionId).toHaveBeenCalledWith(undefined);
    expect(mocks.engine.prewarm).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      workspacePath: '/workspace',
      model: 'gpt-5',
      permissionMode: 'no-restrictions',
    });
  });

  it('routes runtime permission-response through the active session engine for legacy approved payloads', async () => {
    const response = await handleSessionEngineRuntimeRoute(
      '/api/runtime/permission-response',
      new Request('http://local/api/runtime/permission-response', {
        method: 'POST',
        body: JSON.stringify({ requestId: 'perm-1', approved: true, reason: 'ok' }),
      }),
      deps,
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response!)).toEqual({ success: true });
    expect(mocks.engine.respondPermission).toHaveBeenCalledWith('perm-1', 'allow_once', 'ok');
  });
});
