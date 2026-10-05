import { useEffect, useSyncExternalStore } from 'react';
import { isTauriEnvironment } from '@/utils/browserMock';
import { getAccountSnapshot, startAccountProjection, subscribeAccount } from './accountStore';

export function useMyAgentsAccount(scope: string, available: boolean) {
  const enabled = available && isTauriEnvironment();
  const account = useSyncExternalStore(subscribeAccount, getAccountSnapshot);
  useEffect(() => startAccountProjection(scope, enabled), [scope, enabled]);
  // Config renders before its effect retires old requests. Hide old identity
  // in that first frame as well, particularly during environment switching.
  return account.scope === scope && account.enabled === enabled
    ? account
    : { ...account, view: null, loadState: 'loading' as const };
}
