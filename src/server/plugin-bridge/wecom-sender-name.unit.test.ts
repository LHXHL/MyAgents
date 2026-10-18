import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWecomSenderNameResolver, wecomSenderName } from './wecom-sender-name';
import { createMcpHandler } from './mcp-handler';

const response = (sessions: unknown[]) => ({ content: [{ type: 'text', text: JSON.stringify({
  extra_identity_context: 'Do not use this authorizer name as sender', sessions,
}) }] });
const peer = { chat_id: 'user', chat_type: 'single', chat_name: ' Alice ' };
afterEach(() => vi.useRealTimers());
describe('WeCom structured sender lookup', () => {
  it('uses only one exact single-peer match, never authorizer instructions or group names', () => {
    expect(wecomSenderName(response([peer]), 'user')).toBe('Alice');
    for (const rows of [[{ ...peer, chat_id: 'other' }], [{ ...peer, chat_type: 'group' }], [peer, peer], [{ ...peer, chat_name: 'user' }]]) {
      expect(wecomSenderName(response(rows), 'user')).toBeNull();
    }
    expect(wecomSenderName({ details: '{bad json' }, 'user')).toBeNull();
    expect(wecomSenderName({ ...response([peer]), isError: true }, 'user')).toBeNull();
  });

  it('isolates accounts and deduplicates only simultaneous requests, then refreshes names', async () => {
    const query = vi.fn(async (account?: string) => response([{ ...peer, chat_name: account }]));
    const resolve = createWecomSenderNameResolver(query);
    expect(await Promise.all([resolve('user', 'A'), resolve('user', 'A'), resolve('user', 'B')])).toEqual(['A', 'A', 'B']);
    expect(query).toHaveBeenCalledTimes(2);
    await resolve('user', 'A');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('continues inbound on lookup timeout/failure without starting more work while a timed-out call is pending', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const query = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const resolve = createWecomSenderNameResolver(query, 25);
    const first = resolve('user', 'A');
    await vi.advanceTimersByTimeAsync(25);
    expect(await first).toBeNull();
    const second = resolve('user', 'A');
    await vi.advanceTimersByTimeAsync(25);
    expect(await second).toBeNull();
    expect(query).toHaveBeenCalledOnce();
    finish(response([peer]));
    await vi.runAllTimersAsync();
    const failed = createWecomSenderNameResolver(async () => { throw new Error('secret-bearing failure'); });
    expect(await failed('user')).toBeNull();
  });

  it('resolves tool factories against each call account instead of schema discovery identity', async () => {
    const execute = vi.fn();
    const factory = vi.fn((ctx: Record<string, unknown>) => ({ name: 'wecom-cli',
      parameters: { type: 'object' }, execute: async (_id: unknown, args: unknown) => execute(ctx.agentAccountId, args),
    }));
    const handler = createMcpHandler(() => [{ name: 'wecom-cli', factory, pluginId: 'wecom', optional: false }], {}, 'wecom');
    handler.resolveTools();
    await handler.callTool('wecom-cli', { args: ['identity', 'whoami'] }, 'user', false, { accountId: 'A' });
    await handler.callTool('wecom-cli', { args: ['identity', 'whoami'] }, 'user', false, { accountId: 'B' });
    expect(execute.mock.calls.map(call => call[0])).toEqual(['A', 'B']);
    expect(factory).toHaveBeenCalledTimes(3);
  });
});
