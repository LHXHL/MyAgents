import { useCallback, useEffect, useRef, useState } from 'react';
import { getSessions, type SessionMetadata } from '@/api/sessionClient';
import { listenWithCleanup } from '@/utils/tauriListen';
import type { TeamChannel, TeamSessionState } from '@/../shared/teamAi';
import { teamChannels, teamStates } from './client';
import { observationTargets, unobserved } from './model';

/** One read owner per Agent workspace. Notifications coalesce into a trailing
 * read; they never invalidate a slow, otherwise valid snapshot. */
export function useTeamAiData(agentId: string | undefined, path: string | undefined, isActive: boolean) {
  const [channels, setChannels] = useState<TeamChannel[]>([]);
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [states, setStates] = useState<TeamSessionState[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writeRevision = useRef(0);
  // A successful Channel command is authoritative even if its follow-up read
  // fails. Keep that acknowledged result; reads begun before it cannot undo it.
  const reflectGroupReview = useCallback((channelId: string, groupId: string, decision: 'approve' | 'reject') => {
    writeRevision.current += 1;
    setChannels(current => current.map(channel => channel.channelId !== channelId ? channel : {
      ...channel,
      peers: channel.peers.flatMap(peer => {
        if (peer.sourceType !== 'group' || peer.sourceId !== groupId || peer.access !== 'pending') return [peer];
        if (decision === 'reject' && !peer.sessionKey) return [];
        return [{ ...peer, access: decision === 'approve' ? 'approved' as const : null }];
      }),
    }));
  }, []);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let disposed = false;
    let running: Promise<void> | null = null;
    let queued: Promise<void> | null = null;
    let observation = 0;
    setChannels([]); setSessions([]); setStates([]); setLoaded(false); setError(null);
    const read = (): Promise<void> => {
      if (disposed || !agentId || !path) return Promise.resolve();
      if (running) {
        queued ??= running.then(() => { queued = null; return read(); });
        return queued;
      }
      running = (async () => {
        const revision = writeRevision.current;
        // Membership does not wait for Session metadata (nor for state probes).
        const [membership, metadata] = await Promise.allSettled([
          teamChannels(agentId).then(result => {
            if (!disposed && revision === writeRevision.current) { setChannels(result.channels); setLoaded(true); }
            return result.channels;
          }),
          getSessions(path).then(result => { if (!disposed) setSessions(result); return result; }),
        ]);
        if (disposed) return;
        setLoaded(true);
        const failures = [membership, metadata].flatMap(result => result.status === 'rejected'
          ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
        setError(failures.length ? failures.join('\n') : null);
        if (membership.status === 'fulfilled' && metadata.status === 'fulfilled') {
          const targets = observationTargets(membership.value, metadata.value);
          const version = ++observation;
          void teamStates(agentId, targets).then(result => {
            if (!disposed && version === observation) setStates(result.states);
          }).catch(() => {
            if (!disposed && version === observation) setStates(unobserved(targets));
          });
        }
      })().finally(() => { running = null; });
      return running;
    };
    refreshRef.current = read;
    return () => { disposed = true; refreshRef.current = async () => {}; };
  }, [agentId, path]);

  useEffect(() => {
    if (!isActive || !agentId) return;
    const controller = new AbortController();
    const update = () => { void refresh(); };
    for (const event of ['agent:status-changed', 'session:metadata-changed', 'im:bot-config-changed', 'im:user-bound', 'im:group-permission-changed']) {
      void listenWithCleanup(event, update, controller.signal)
        .catch(failure => console.warn('[team-ai] listener unavailable', failure));
    }
    update();
    const interval = setInterval(update, 8000);
    const visible = () => { if (document.visibilityState === 'visible') update(); };
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.abort(); clearInterval(interval);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [agentId, path, isActive, refresh]);

  return { channels, sessions, states, loaded, error, setError, refresh, reflectGroupReview };
}
