import { describe, it, expect, vi } from 'vitest';
import { createDirectoryPeerNamesResolver } from './directory-peer-names';

describe('plugin directory display metadata', () => {
  it('only accepts exact unique ID/kind and passes the channel account', async () => {
    const query = vi.fn(async (kind, id) => [
      { kind, id: `neighbor-${id}`, name: 'Wrong' },
      { kind, id, name: kind === 'group' ? ' Team ' : 'Alice' },
      { kind: 'other', id, name: 'Wrong kind' },
    ]);
    const resolve = createDirectoryPeerNamesResolver(query);
    expect(await resolve({ users: ['u'], groups: ['g'] }, 'account')).toEqual([
      { kind: 'group', id: 'g', name: 'Team' }, { kind: 'user', id: 'u', name: 'Alice' },
    ]);
    expect(query).toHaveBeenCalledWith('group', 'g', 'account');
    expect(await createDirectoryPeerNamesResolver(async () => [{kind:'group',id:'g',name:'A'},{kind:'group',id:'g',name:'B'}])({users:[],groups:['g']})).toEqual([]);
    expect(await createDirectoryPeerNamesResolver(async () => { throw new Error('denied'); })({users:['u'],groups:[]})).toEqual([]);
  });
  it('bounds waiting, deduplicates pending requests, and isolates accounts', async () => {
    const query = vi.fn(() => new Promise<unknown>(() => {}));
    const resolve = createDirectoryPeerNamesResolver(query, 5);
    const target = { users: ['u'], groups: [] };
    expect(await resolve(target, 'a')).toEqual([]);
    expect(await resolve(target, 'a')).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(await resolve(target, 'b')).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
