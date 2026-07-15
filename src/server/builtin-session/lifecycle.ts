import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { SystemInitInfo } from '../../shared/types/system';
import type { BuiltinLifecycleSnapshot, MessageQueueItem } from './types';

const PRE_WARM_MAX_RETRIES = 3;

let querySession: Query | null = null;
let isProcessing = false;
let abortRequested = false;
let sessionTerminationPromise: Promise<void> | null = null;
let messageResolver: ((item: MessageQueueItem | null) => void) | null = null;
let isPreWarming = false;
let preWarmTimer: ReturnType<typeof setTimeout> | null = null;
let preWarmFailCount = 0;
let preWarmDisabled = false;
let systemInitInfo: SystemInitInfo | null = null;
let sdkControlReady = false;
let liveRevision = 0;

export const lifecycleState = {
  get query(): Query | null {
    return querySession;
  },
  set query(session: Query | null) {
    querySession = session;
  },
  get processing(): boolean {
    return isProcessing;
  },
  set processing(value: boolean) {
    isProcessing = value;
  },
  get abortRequested(): boolean {
    return abortRequested;
  },
  set abortRequested(value: boolean) {
    abortRequested = value;
  },
  get termination(): Promise<void> | null {
    return sessionTerminationPromise;
  },
  set termination(promise: Promise<void> | null) {
    sessionTerminationPromise = promise;
  },
  get preWarming(): boolean {
    return isPreWarming;
  },
  set preWarming(value: boolean) {
    isPreWarming = value;
  },
  get preWarmTimer(): ReturnType<typeof setTimeout> | null {
    return preWarmTimer;
  },
  set preWarmTimer(timer: ReturnType<typeof setTimeout> | null) {
    preWarmTimer = timer;
  },
  get preWarmFailCount(): number {
    return preWarmFailCount;
  },
  set preWarmFailCount(value: number) {
    preWarmFailCount = value;
  },
  get preWarmDisabled(): boolean {
    return preWarmDisabled;
  },
  set preWarmDisabled(value: boolean) {
    preWarmDisabled = value;
  },
  get systemInitInfo(): SystemInitInfo | null {
    return systemInitInfo;
  },
  set systemInitInfo(info: SystemInitInfo | null) {
    systemInitInfo = info;
  },
  get sdkControlReady(): boolean {
    return sdkControlReady;
  },
  set sdkControlReady(value: boolean) {
    sdkControlReady = value;
  },
  get messageResolver(): ((item: MessageQueueItem | null) => void) | null {
    return messageResolver;
  },
  set messageResolver(resolve: ((item: MessageQueueItem | null) => void) | null) {
    messageResolver = resolve;
  },
};

export function getQuerySession(): Query | null {
  return querySession;
}

export function hasQuerySession(): boolean {
  return querySession !== null;
}

export function setQuerySession(session: Query | null): void {
  querySession = session;
}

export function clearQuerySession(): Query | null {
  const session = querySession;
  querySession = null;
  return session;
}

export function isSessionProcessing(): boolean {
  return isProcessing;
}

export function setSessionProcessing(value: boolean): void {
  isProcessing = value;
}

export function isAbortRequested(): boolean {
  return abortRequested;
}

export function requestAbort(): void {
  abortRequested = true;
}

export function clearAbortFlag(): void {
  abortRequested = false;
}

export function getSessionTerminationPromise(): Promise<void> | null {
  return sessionTerminationPromise;
}

export function setSessionTerminationPromise(promise: Promise<void> | null): void {
  sessionTerminationPromise = promise;
}

export function isPreWarmInProgress(): boolean {
  return isPreWarming;
}

export function setPreWarmInProgress(value: boolean): void {
  isPreWarming = value;
}

export function getPreWarmTimer(): ReturnType<typeof setTimeout> | null {
  return preWarmTimer;
}

export function setPreWarmTimer(timer: ReturnType<typeof setTimeout> | null): void {
  preWarmTimer = timer;
}

export function clearPreWarmTimer(): void {
  if (preWarmTimer) clearTimeout(preWarmTimer);
  preWarmTimer = null;
}

export function getPreWarmFailCount(): number {
  return preWarmFailCount;
}

export function resetPreWarmFailCount(): void {
  preWarmFailCount = 0;
}

export function incrementPreWarmFailCount(): number {
  preWarmFailCount += 1;
  return preWarmFailCount;
}

export function getPreWarmMaxRetries(): number {
  return PRE_WARM_MAX_RETRIES;
}

export function isPreWarmDisabled(): boolean {
  return preWarmDisabled;
}

export function setPreWarmDisabled(value: boolean): void {
  preWarmDisabled = value;
}

export function getSystemInitInfo(): SystemInitInfo | null {
  return systemInitInfo;
}

export function setSystemInitInfo(info: SystemInitInfo | null): void {
  systemInitInfo = info;
}

export function isSdkControlReady(): boolean {
  return sdkControlReady;
}

export function setSdkControlReady(value: boolean): void {
  sdkControlReady = value;
}

export function hasMessageResolver(): boolean {
  return messageResolver !== null;
}

export function wakeGenerator(item: MessageQueueItem | null): void {
  if (!messageResolver) return;
  const resolve = messageResolver;
  messageResolver = null;
  resolve(item);
}

export function waitForMessage(dequeue: () => MessageQueueItem | undefined): Promise<MessageQueueItem | null> {
  if (abortRequested) return Promise.resolve(null);
  const queued = dequeue();
  if (queued) return Promise.resolve(queued);
  return new Promise(resolve => { messageResolver = resolve; });
}

export function resetControlPlaneState(): void {
  systemInitInfo = null;
  sdkControlReady = false;
}

export function nextBuiltinLiveRevision(): number {
  liveRevision += 1;
  return liveRevision;
}

export function getBuiltinLiveRevision(): number {
  return liveRevision;
}

export function resetBuiltinLiveRevision(): void {
  liveRevision = 0;
}

export function resetPreWarmState(): void {
  isPreWarming = false;
  preWarmFailCount = 0;
  clearPreWarmTimer();
}

export function clearGeneratorResolver(): void {
  messageResolver = null;
}

export function forceWakeGeneratorWithNull(): void {
  wakeGenerator(null);
}

export async function awaitSessionTermination(params: {
  timeoutMs?: number;
  label?: string;
  onTimeoutForceCleanup?: (session: Query | null) => void;
} = {}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const label = params.label ?? '';
  if (!sessionTerminationPromise) return;
  let timerId: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      sessionTerminationPromise,
      new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new Error(`sessionTermination timeout (${label})`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes('timeout');
    console.warn(`[agent] ${label}: sessionTerminationPromise ${isTimeout ? 'timed out' : 'rejected'} after ${timeoutMs}ms, force-cleaning:`, error);
    const session = clearQuerySession();
    isProcessing = false;
    isPreWarming = false;
    forceWakeGeneratorWithNull();
    params.onTimeoutForceCleanup?.(session);
    try { void session?.close(); } catch { /* subprocess may already be dead */ }
  } finally {
    clearTimeout(timerId!);
  }
}

export function snapshotLifecycle(): BuiltinLifecycleSnapshot {
  return {
    querySession,
    isProcessing,
    abortRequested,
    sessionTerminationPromise,
    isPreWarming,
    preWarmTimer,
    preWarmFailCount,
    preWarmDisabled,
    systemInitInfo,
    sdkControlReady,
    hasMessageResolver: messageResolver !== null,
  };
}

export function resetLifecycleForTest(): void {
  querySession = null;
  isProcessing = false;
  abortRequested = false;
  sessionTerminationPromise = null;
  clearGeneratorResolver();
  isPreWarming = false;
  preWarmTimer = null;
  preWarmFailCount = 0;
  preWarmDisabled = false;
  systemInitInfo = null;
  sdkControlReady = false;
}
