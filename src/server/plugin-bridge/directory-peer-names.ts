import type { PeerDisplayName } from './wecom-sender-name';

export interface PeerNameTargets { users: string[]; groups: string[] }
export type QueryDirectory = (kind: 'user' | 'group', id: string, accountId?: string) => Promise<unknown>;

/** Standard plugin directory reads only. The plugin owns credentials and API
 * pagination; exact kind+ID matching prevents search matches becoming identity.
 * Share slow requests until they settle, but never block inbound on a directory. */
export function createDirectoryPeerNamesResolver(query: QueryDirectory, budgetMs = 2500) {
  const pending = new Map<string, Promise<PeerDisplayName[]>>();
  return async (targets: PeerNameTargets, accountId?: string): Promise<PeerDisplayName[]> => {
    const results: PeerDisplayName[] = [];
    const lookups = (['group', 'user'] as const).flatMap(kind =>
      [...new Set(kind === 'group' ? targets.groups : targets.users)].filter(Boolean).map(id => ({ kind, id })));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let cursor = 0;
    try {
      await Promise.race([
        Promise.all(Array.from({ length: Math.min(4, lookups.length) }, async () => {
          while (!expired && cursor < lookups.length) {
            const { kind, id } = lookups[cursor++];
            const key = JSON.stringify([accountId, kind, id]);
            let request = pending.get(key);
            if (!request) {
              request = Promise.resolve().then(() => query(kind, id, accountId)).then(value => {
                if (!Array.isArray(value)) return [];
                const matches = value.filter(peer => peer && peer.kind === kind && peer.id === id);
                if (matches.length !== 1) return [];
                const name = typeof matches[0].name === 'string' ? matches[0].name.trim() : '';
                return name && name !== id && name.length <= 256 ? [{ kind, id, name }] : [];
              }).catch(() => []);
              pending.set(key, request);
              void request.finally(() => { if (pending.get(key) === request) pending.delete(key); });
            }
            const names = await request;
            if (!expired) results.push(...names);
          }
        })),
        new Promise<void>(resolve => { timer = setTimeout(() => { expired = true; resolve(); }, budgetMs); }),
      ]);
      return results;
    } finally { clearTimeout(timer); }
  };
}
