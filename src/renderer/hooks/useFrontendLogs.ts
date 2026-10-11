import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import {
  getFrontendLogSequence,
  matchesFrontendLogScope,
  snapshotFrontendLogs,
  subscribeFrontendLogs,
  type FrontendLogScope,
} from '@/utils/frontendLogger';
import type { LogEntry } from '@/types/log';

const EMPTY_LOGS: LogEntry[] = [];

/** Logs are a panel projection, not part of the Chat/Settings state lifecycle. */
export function useFrontendLogs(enabled: boolean, { tabId, sessionId }: FrontendLogScope = {}) {
  const [clearedThrough, setClearedThrough] = useState(0);
  const subscribe = useCallback((notify: () => void) => {
    if (!enabled) return () => {};
    return subscribeFrontendLogs(entry => {
      if (matchesFrontendLogScope(entry, { tabId, sessionId })) notify();
    });
  }, [enabled, tabId, sessionId]);
  const getSnapshot = useCallback(() => enabled ? getFrontendLogSequence() : 0, [enabled]);
  const sequence = useSyncExternalStore(subscribe, getSnapshot);
  const logs = useMemo(() => enabled
    ? snapshotFrontendLogs({ tabId, sessionId }, clearedThrough, sequence)
    : EMPTY_LOGS, [enabled, tabId, sessionId, clearedThrough, sequence]);
  // Clearing this view must not erase another panel's global diagnostics or
  // touch persisted logs. A monotonic cursor still works after buffer eviction.
  const clear = useCallback(() => setClearedThrough(getFrontendLogSequence()), []);
  return { logs, clear };
}
