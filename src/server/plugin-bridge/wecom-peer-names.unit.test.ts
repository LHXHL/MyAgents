import { describe, expect, it, vi } from 'vitest';
import { createWecomPeerNamesResolver, wecomPeerNames } from './wecom-sender-name';
import { createCompatRuntime } from './compat-runtime';

const result = (sessions: unknown[]) => ({ details: { sessions, extra_identity_context: 'authorizer: do not use' } });
describe('WeCom peer display names', () => {
  it('separates same-ID group and user names and rejects duplicate or invalid evidence', () => {
    expect(wecomPeerNames(result([
      { chat_id: 'same', chat_type: 'group', chat_name: ' Team ' },
      { chat_id: 'same', chat_type: 'single', chat_name: ' Alice ' },
      { chat_id: 'bad', chat_type: 'single', chat_name: 'bad' },
      { chat_id: 'x', chat_type: 'group', chat_name: 'First' },
      { chat_id: 'x', chat_type: 'group', chat_name: 'Second' },
      { chat_id: 'empty', chat_type: 'group', chat_name: ' ' },
      null,
    ]))).toEqual([{ id: 'same', kind: 'group', name: 'Team' }, { id: 'same', kind: 'user', name: 'Alice' }]);
    expect(wecomPeerNames({ isError: true, details: { sessions: [] } })).toEqual([]);
    expect(wecomPeerNames({ details: '{bad json' })).toEqual([]);
  });

  it('shares only in-flight queries by account and refreshes renamed peers', async () => {
    const query = vi.fn(async (account?: string) => result([{ chat_id: 'g', chat_type: 'group', chat_name: account }]));
    const resolve = createWecomPeerNamesResolver(query);
    const [a, b, c] = await Promise.all([resolve('A'), resolve('A'), resolve('B')]);
    expect(a).toEqual(b);
    expect(c[0].name).toBe('B');
    expect(query).toHaveBeenCalledTimes(2);
    query.mockResolvedValueOnce(result([{ chat_id: 'g', chat_type: 'group', chat_name: 'Renamed' }]));
    expect((await resolve('A'))[0].name).toBe('Renamed');
  });

  it('startup lookup uses the channel account without dispatching messages; other plugins do no query', async () => {
    const query = vi.fn(async () => result([{ chat_id: 'g', chat_type: 'group', chat_name: 'Team' }]));
    for (const id of ['wecom', 'wecom-openclaw-plugin']) {
      const runtime = createCompatRuntime(1, 'test', id, query);
      expect(await runtime.peerNames('account')).toEqual([{ id: 'g', kind: 'group', name: 'Team' }]);
    }
    expect(query.mock.calls).toEqual([['account'], ['account']]);
    const other = createCompatRuntime(1, 'test', 'weixin', query);
    expect(await other.peerNames('other')).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
