type QuerySessions = (accountId?: string) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export interface PeerDisplayName {
  id: string;
  kind: 'user' | 'group';
  name: string;
}

/** Only structured, unambiguous peer matches are identity evidence. Never
 * parse extra_identity_context prose: it describes an authorizer. */
export function wecomPeerNames(result: unknown): PeerDisplayName[] {
  const envelope = record(result);
  if (!envelope || envelope.isError) return [];
  let data: unknown = envelope.details;
  if (data === undefined && Array.isArray(envelope.content)) {
    data = envelope.content.map(record).find(block => block?.type === 'text')?.text;
  }
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return []; }
  }
  const body = record(data);
  if (!body || body.error || !Array.isArray(body.sessions)) return [];
  const peers = body.sessions.map(record);
  return peers.flatMap(peer => {
    if (!peer || (peer.chat_type !== 'single' && peer.chat_type !== 'group')
      || typeof peer.chat_id !== 'string' || !peer.chat_id) return [];
    if (peers.filter(other => other && other.chat_type === peer.chat_type && other.chat_id === peer.chat_id).length !== 1) return [];
    const name = typeof peer.chat_name === 'string' ? peer.chat_name.trim() : '';
    if (!name || name === peer.chat_id || name.length > 256) return [];
    return [{ id: peer.chat_id, kind: peer.chat_type === 'single' ? 'user' as const : 'group' as const, name }];
  });
}

export function wecomSenderName(result: unknown, senderId: string): string | null {
  return wecomPeerNames(result).find(peer => peer.kind === 'user' && peer.id === senderId)?.name ?? null;
}

/** Bridge-owned, account-scoped in-flight deduplication only. A slow lookup
 * must not hold inbound delivery; the plugin owns its eventual CLI timeout.
 * No historical identity cache or user data is persisted here. */
export function createWecomPeerNamesResolver(query: QuerySessions, budgetMs = 2_500) {
  const pending = new Map<string | undefined, Promise<unknown>>();
  return async (accountId?: string): Promise<PeerDisplayName[]> => {
    let request = pending.get(accountId);
    if (!request) {
      request = Promise.resolve().then(() => query(accountId)).catch(() => null);
      pending.set(accountId, request);
      void request.finally(() => { if (pending.get(accountId) === request) pending.delete(accountId); });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        request,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), budgetMs); }),
      ]);
      return wecomPeerNames(result);
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createWecomSenderNameResolver(query: QuerySessions, budgetMs = 2_500) {
  const resolve = createWecomPeerNamesResolver(query, budgetMs);
  return async (senderId: string, accountId?: string): Promise<string | null> =>
    (await resolve(accountId)).find(peer => peer.kind === 'user' && peer.id === senderId)?.name ?? null;
}
