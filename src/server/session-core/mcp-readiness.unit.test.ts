import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitRequiredMcpReadiness,
  classifyRequiredMcpStatuses,
  isMcpReadinessLeaseCurrent,
  type McpReadinessOwner,
  type McpServerStatusSnapshot,
} from './mcp-readiness';

describe('MCP readiness policy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      name: 'connected',
      statuses: [{ name: 'fs', status: 'connected' }],
      expected: { state: 'ready' },
    },
    {
      name: 'pending',
      statuses: [{ name: 'fs', status: 'pending' }],
      expected: { state: 'pending', servers: [{ id: 'fs', status: 'pending' }] },
    },
    {
      name: 'failed',
      statuses: [{ name: 'fs', status: 'failed', error: 'spawn failed' }],
      expected: { state: 'failure', failure: { code: 'mcp_failed', servers: [{ id: 'fs', status: 'failed', error: 'spawn failed' }] } },
    },
    {
      name: 'needs auth',
      statuses: [{ name: 'fs', status: 'needs-auth' }],
      expected: { state: 'failure', failure: { code: 'mcp_auth_required', servers: [{ id: 'fs', status: 'needs-auth' }] } },
    },
    {
      name: 'disabled',
      statuses: [{ name: 'fs', status: 'disabled' }],
      expected: { state: 'failure', failure: { code: 'mcp_disabled', servers: [{ id: 'fs', status: 'disabled' }] } },
    },
    {
      name: 'missing',
      statuses: [],
      expected: { state: 'failure', failure: { code: 'mcp_missing', servers: [{ id: 'fs' }] } },
    },
    {
      name: 'extra unrelated status',
      statuses: [
        { name: 'fs', status: 'connected' },
        { name: 'unrelated', status: 'failed', error: 'ignored' },
      ],
      expected: { state: 'ready' },
    },
  ] satisfies Array<{
    name: string;
    statuses: McpServerStatusSnapshot[];
    expected: unknown;
  }>)('classifies $name required-server state', ({ statuses, expected }) => {
    expect(classifyRequiredMcpStatuses(['fs'], statuses)).toEqual(expected);
  });

  it('treats an explicitly empty Query MCP set as ready', () => {
    expect(classifyRequiredMcpStatuses([], [
      { name: 'unrelated', status: 'failed' },
    ])).toEqual({ state: 'ready' });
  });

  function owner(params: {
    identity?: object;
    generation?: number;
    revision?: number;
    fingerprint?: string;
    statuses: () => Promise<readonly McpServerStatusSnapshot[]>;
  }): McpReadinessOwner {
    return {
      identity: params.identity ?? {},
      generation: params.generation ?? 1,
      revision: params.revision ?? 1,
      fingerprint: params.fingerprint ?? 'fs',
      requiredServerIds: ['fs'],
      readStatuses: params.statuses,
    };
  }

  it('polls a pending server until it connects', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const current = owner({
      statuses: async () => [{ name: 'fs', status: ++calls === 1 ? 'pending' : 'connected' }],
    });
    const result = awaitRequiredMcpReadiness({
      deadlineAt: Date.now() + 1_000,
      getOwner: () => current,
      ensureOwner: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(result).resolves.toMatchObject({
      ready: true,
      lease: { identity: current.identity, generation: 1, fingerprint: 'fs' },
    });
    expect(calls).toBe(2);
  });

  it('asks the owner boundary to create the final persistent Query when none is live', async () => {
    vi.useFakeTimers();
    const installed = owner({
      statuses: async () => [{ name: 'fs', status: 'connected' }],
    });
    let current: McpReadinessOwner | null = null;
    const ensureOwner = vi.fn(() => {
      current = installed;
    });
    const result = awaitRequiredMcpReadiness({
      deadlineAt: Date.now() + 1_000,
      getOwner: () => current,
      ensureOwner,
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(result).resolves.toMatchObject({
      ready: true,
      lease: { identity: installed.identity, generation: 1, fingerprint: 'fs' },
    });
    expect(ensureOwner).toHaveBeenCalledTimes(1);
  });

  it('caps readiness waiting at 30 seconds even when the turn deadline is longer', async () => {
    let clock = 0;
    const current = owner({
      statuses: async () => [{ name: 'fs', status: 'pending' }],
    });
    const result = await awaitRequiredMcpReadiness({
      deadlineAt: 60_000,
      getOwner: () => current,
      ensureOwner: vi.fn(),
      now: () => clock,
      sleep: async ms => { clock += ms; },
    });

    expect(clock).toBe(30_000);
    expect(result).toMatchObject({
      ready: false,
      failure: { code: 'mcp_timeout' },
    });
  });

  it('returns a terminal failure reached after pending', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const current = owner({
      statuses: async () => ++calls === 1
        ? [{ name: 'fs', status: 'pending' }]
        : [{ name: 'fs', status: 'failed', error: 'stdio exited' }],
    });
    const result = awaitRequiredMcpReadiness({
      deadlineAt: Date.now() + 1_000,
      getOwner: () => current,
      ensureOwner: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(result).resolves.toEqual({
      ready: false,
      failure: {
        code: 'mcp_failed',
        servers: [{ id: 'fs', status: 'failed', error: 'stdio exited' }],
      },
    });
  });

  it('times out a permanently pending server with its last observed status', async () => {
    vi.useFakeTimers();
    const current = owner({
      statuses: async () => [{ name: 'fs', status: 'pending' }],
    });
    const result = awaitRequiredMcpReadiness({
      deadlineAt: Date.now() + 900,
      getOwner: () => current,
      ensureOwner: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(900);
    await expect(result).resolves.toEqual({
      ready: false,
      failure: {
        code: 'mcp_timeout',
        servers: [{ id: 'fs', status: 'pending' }],
      },
    });
  });

  it('discards connected status returned by a stale Query owner', async () => {
    let releaseOld!: (statuses: McpServerStatusSnapshot[]) => void;
    const oldIdentity = {};
    const oldOwner = owner({
      identity: oldIdentity,
      generation: 1,
      statuses: () => new Promise(resolve => { releaseOld = resolve; }),
    });
    const newOwner = owner({
      generation: 2,
      statuses: async () => [{ name: 'fs', status: 'failed', error: 'new query failed' }],
    });
    let current: McpReadinessOwner | null = oldOwner;
    const result = awaitRequiredMcpReadiness({
      deadlineAt: Date.now() + 1_000,
      getOwner: () => current,
      ensureOwner: vi.fn(),
    });
    await Promise.resolve();
    current = newOwner;
    releaseOld([{ name: 'fs', status: 'connected' }]);

    await expect(result).resolves.toEqual({
      ready: false,
      failure: {
        code: 'mcp_failed',
        servers: [{ id: 'fs', status: 'failed', error: 'new query failed' }],
      },
    });
  });

  it('invalidates a same-Query same-fingerprint lease after an installed-set ABA revision', () => {
    const identity = {};
    const installed = owner({
      identity,
      generation: 1,
      revision: 3,
      fingerprint: 'fs',
      statuses: async () => [{ name: 'fs', status: 'connected' }],
    });

    expect(isMcpReadinessLeaseCurrent({
      identity,
      generation: 1,
      revision: 1,
      fingerprint: 'fs',
      requiredServerIds: ['fs'],
    }, installed)).toBe(false);
  });

  it('discards status from the same Query when its installed MCP fingerprint changes', async () => {
    let releaseOld!: (statuses: McpServerStatusSnapshot[]) => void;
    const identity = {};
    const oldOwner = owner({
      identity,
      fingerprint: 'fs',
      statuses: () => new Promise(resolve => { releaseOld = resolve; }),
    });
    const newOwner = owner({
      identity,
      fingerprint: 'fs,search',
      statuses: async () => [{ name: 'fs', status: 'failed', error: 'new set failed' }],
    });
    let current = oldOwner;
    const result = awaitRequiredMcpReadiness({
      deadlineAt: Date.now() + 1_000,
      getOwner: () => current,
      ensureOwner: vi.fn(),
    });
    await Promise.resolve();
    current = newOwner;
    releaseOld([{ name: 'fs', status: 'connected' }]);

    await expect(result).resolves.toMatchObject({
      ready: false,
      failure: { code: 'mcp_failed' },
    });
  });

  it('does not report stale pending servers after their Query owner disappears', async () => {
    let clock = 0;
    const oldOwner = owner({
      statuses: async () => [{ name: 'fs', status: 'pending' }],
    });
    let current: McpReadinessOwner | null = oldOwner;

    const result = await awaitRequiredMcpReadiness({
      deadlineAt: 500,
      getOwner: () => current,
      ensureOwner: vi.fn(),
      now: () => clock,
      sleep: async ms => {
        clock += ms;
        current = null;
      },
    });

    expect(result).toEqual({
      ready: false,
      failure: {
        code: 'query_replaced',
        servers: [{ id: 'fs' }],
      },
    });
  });

  it('cancels an in-flight SDK status read without waiting for its deadline', async () => {
    const controller = new AbortController();
    const current = owner({
      statuses: () => new Promise(() => undefined),
    });
    const result = awaitRequiredMcpReadiness({
      deadlineAt: Date.now() + 30_000,
      getOwner: () => current,
      ensureOwner: vi.fn(),
      signal: controller.signal,
    });
    await Promise.resolve();

    controller.abort();

    await expect(result).rejects.toThrow('MCP readiness wait cancelled');
  });

  it('shares one absolute 30 second budget across persistence and promotion fences', async () => {
    let clock = 0;
    let firstReads = 0;
    const persistenceOwner = owner({
      generation: 1,
      statuses: async () => [{
        name: 'fs',
        status: ++firstReads < 120 ? 'pending' : 'connected',
      }],
    });
    const sharedDeadline = 30_000;
    const sleep = async (ms: number) => { clock += ms; };

    await expect(awaitRequiredMcpReadiness({
      deadlineAt: sharedDeadline,
      getOwner: () => persistenceOwner,
      ensureOwner: vi.fn(),
      now: () => clock,
      sleep,
    })).resolves.toMatchObject({ ready: true });
    expect(clock).toBe(29_750);

    const promotedOwner = owner({
      generation: 2,
      statuses: async () => [{ name: 'fs', status: 'pending' }],
    });
    await expect(awaitRequiredMcpReadiness({
      deadlineAt: sharedDeadline,
      getOwner: () => promotedOwner,
      ensureOwner: vi.fn(),
      now: () => clock,
      sleep,
    })).resolves.toMatchObject({
      ready: false,
      failure: { code: 'mcp_timeout', servers: [{ id: 'fs' }] },
    });
    expect(clock).toBe(30_000);
  });
});
