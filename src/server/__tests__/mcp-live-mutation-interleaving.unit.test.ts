import { beforeEach, describe, expect, it, vi } from 'vitest';

const oauth = vi.hoisted(() => {
  let release!: (headers: Record<string, string>) => void;
  return {
    resolveAuthHeaders: vi.fn(() => new Promise<Record<string, string>>((resolve) => {
      release = resolve;
    })),
    release: (headers: Record<string, string> = {}) => release(headers),
  };
});

vi.mock('../mcp-oauth', () => ({
  resolveAuthHeaders: oauth.resolveAuthHeaders,
  onTokenChange: vi.fn(),
  startTokenRefreshScheduler: vi.fn(),
}));

import {
  ensureSdkMcpInSync,
  initializeAgent,
} from '../agent-session';
import {
  getQueryMcpMutation,
  getQueryMcpReadinessOwner,
  resetLifecycleForTest,
  setQueryMcpReadinessOwner,
  setQuerySession,
} from '../builtin-session/lifecycle';
import {
  resetConfigForTest,
  setCurrentMcpServers,
  setFrozenSdkMcpFingerprint,
  snapshotConfig,
} from '../builtin-session/config';
import {
  beginPromotedItem,
  resetQueueForTest,
} from '../builtin-session/queue';

describe('live Query MCP mutation/promotion ordering', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetLifecycleForTest();
    resetQueueForTest();
    resetConfigForTest();
    await initializeAgent('/tmp/myagents-mcp-live-mutation-interleaving', null, undefined, {
      preWarmDisabled: true,
    });
  });

  it('publishes the mutation owner before async map build so later promotion is rejected', async () => {
    const setMcpServers = vi.fn();
    const query = {
      setMcpServers,
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(),
    } as never;
    setQuerySession(query);
    setFrozenSdkMcpFingerprint('old');
    setQueryMcpReadinessOwner({
      query,
      fingerprint: 'old',
      requiredServerIds: ['old'],
    });
    setCurrentMcpServers([{
      id: 'delayed-http',
      name: 'delayed-http',
      isBuiltin: false,
      type: 'http',
      url: 'https://example.com/mcp',
      command: '',
      args: [],
    }]);

    const synchronization = ensureSdkMcpInSync();
    await vi.waitFor(() => {
      expect(oauth.resolveAuthHeaders).toHaveBeenCalledOnce();
      expect(getQueryMcpMutation()).not.toBeNull();
    });

    beginPromotedItem({
      id: 'promotion-after-mutation-claim',
      message: { role: 'user', content: [{ type: 'text', text: 'run task' }] },
      messageText: 'run task',
      wasQueued: false,
      resolve: () => undefined,
    });
    oauth.release();

    await expect(getQueryMcpMutation()!.promise).resolves.toMatchObject({
      ok: false,
      reason: 'deferred',
    });
    await synchronization;

    expect(setMcpServers).not.toHaveBeenCalled();
    expect(getQueryMcpReadinessOwner()).toBeNull();
    expect(snapshotConfig().deferredRestartReasons).toContain('mcp');
  });
});
