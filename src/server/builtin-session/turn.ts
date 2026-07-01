import type { ImEventType } from '../utils/im-event-bus';
import type {
  BuiltinInjectedTurnOutcome,
  BuiltinTurnStartContext,
  BuiltinTurnUsage,
  TurnProviderAnalytics,
} from './types';
import type { SessionOrigin } from '../../shared/session-origin';

type ImEmitter = (type: ImEventType, data?: unknown) => void;

function emptyUsage(): BuiltinTurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelUsage: undefined,
  };
}

let currentTurnUsage = emptyUsage();
let latestMainAssistantUsage: import('../types/session').MessageUsage | null = null;
let currentTurnStartTime: number | null = null;
let currentPlanFileMinMtimeMs: number | null = null;
let currentTurnToolCount = 0;
let currentTurnHasOutput = false;
let currentTurnHadAssistantMessageError = false;
let currentTurnLastAssistantMessageError: string | null = null;
let currentTurnAnalyticsSource: import('../types/session').TurnAnalyticsSource | null = null;
let currentTurnAnalyticsOrigin: SessionOrigin | null = null;
let currentTurnProviderAnalytics: TurnProviderAnalytics | null = null;
let currentTurnCompactResult: 'success' | 'failed' | null = null;
let currentTurnSawCompactBoundary = false;
let currentTurnAssistantMessagePresent = false;
let turnHadSubstantiveActivity = false;
let sessionBrowserToolUsed = false;
let sessionStorageStateSaved = false;
let currentTurnInboxMeta: import('../inbox/types').InboxTurnMeta | undefined = undefined;
const currentTurnTextBlocks: string[] = [];
const pendingRequestIds: string[] = [];
let currentTurnImTerminalEmitted = false;
const injectedTurnOutcomes = new Map<string, BuiltinInjectedTurnOutcome>();
const discardedInjectedTurnIds = new Set<string>();
let currentTurnInjectedTurnId: string | undefined = undefined;

export const turnState = {
  get currentTurnUsage(): BuiltinTurnUsage {
    return currentTurnUsage;
  },
  set currentTurnUsage(usage: BuiltinTurnUsage) {
    currentTurnUsage = usage;
  },
  get latestMainAssistantUsage(): import('../types/session').MessageUsage | null {
    return latestMainAssistantUsage;
  },
  set latestMainAssistantUsage(usage: import('../types/session').MessageUsage | null) {
    latestMainAssistantUsage = usage;
  },
  get currentTurnStartTime(): number | null {
    return currentTurnStartTime;
  },
  set currentTurnStartTime(value: number | null) {
    currentTurnStartTime = value;
  },
  get currentPlanFileMinMtimeMs(): number | null {
    return currentPlanFileMinMtimeMs;
  },
  set currentPlanFileMinMtimeMs(value: number | null) {
    currentPlanFileMinMtimeMs = value;
  },
  get currentTurnToolCount(): number {
    return currentTurnToolCount;
  },
  set currentTurnToolCount(value: number) {
    currentTurnToolCount = value;
  },
  get currentTurnHasOutput(): boolean {
    return currentTurnHasOutput;
  },
  set currentTurnHasOutput(value: boolean) {
    currentTurnHasOutput = value;
  },
  get currentTurnHadAssistantMessageError(): boolean {
    return currentTurnHadAssistantMessageError;
  },
  set currentTurnHadAssistantMessageError(value: boolean) {
    currentTurnHadAssistantMessageError = value;
  },
  get currentTurnLastAssistantMessageError(): string | null {
    return currentTurnLastAssistantMessageError;
  },
  set currentTurnLastAssistantMessageError(value: string | null) {
    currentTurnLastAssistantMessageError = value;
  },
  get currentTurnAnalyticsSource(): import('../types/session').TurnAnalyticsSource | null {
    return currentTurnAnalyticsSource;
  },
  set currentTurnAnalyticsSource(source: import('../types/session').TurnAnalyticsSource | null) {
    currentTurnAnalyticsSource = source;
  },
  get currentTurnAnalyticsOrigin(): SessionOrigin | null {
    return currentTurnAnalyticsOrigin;
  },
  set currentTurnAnalyticsOrigin(origin: SessionOrigin | null) {
    currentTurnAnalyticsOrigin = origin;
  },
  get currentTurnProviderAnalytics(): TurnProviderAnalytics | null {
    return currentTurnProviderAnalytics;
  },
  set currentTurnProviderAnalytics(analytics: TurnProviderAnalytics | null) {
    currentTurnProviderAnalytics = analytics;
  },
  get currentTurnCompactResult(): 'success' | 'failed' | null {
    return currentTurnCompactResult;
  },
  set currentTurnCompactResult(value: 'success' | 'failed' | null) {
    currentTurnCompactResult = value;
  },
  get currentTurnSawCompactBoundary(): boolean {
    return currentTurnSawCompactBoundary;
  },
  set currentTurnSawCompactBoundary(value: boolean) {
    currentTurnSawCompactBoundary = value;
  },
  get currentTurnAssistantMessagePresent(): boolean {
    return currentTurnAssistantMessagePresent;
  },
  set currentTurnAssistantMessagePresent(value: boolean) {
    currentTurnAssistantMessagePresent = value;
  },
  get turnHadSubstantiveActivity(): boolean {
    return turnHadSubstantiveActivity;
  },
  set turnHadSubstantiveActivity(value: boolean) {
    turnHadSubstantiveActivity = value;
  },
  get sessionBrowserToolUsed(): boolean {
    return sessionBrowserToolUsed;
  },
  set sessionBrowserToolUsed(value: boolean) {
    sessionBrowserToolUsed = value;
  },
  get sessionStorageStateSaved(): boolean {
    return sessionStorageStateSaved;
  },
  set sessionStorageStateSaved(value: boolean) {
    sessionStorageStateSaved = value;
  },
  get currentTurnInboxMeta(): import('../inbox/types').InboxTurnMeta | undefined {
    return currentTurnInboxMeta;
  },
  set currentTurnInboxMeta(meta: import('../inbox/types').InboxTurnMeta | undefined) {
    currentTurnInboxMeta = meta;
  },
  currentTurnTextBlocks,
  pendingRequestIds,
  get currentTurnImTerminalEmitted(): boolean {
    return currentTurnImTerminalEmitted;
  },
  set currentTurnImTerminalEmitted(value: boolean) {
    currentTurnImTerminalEmitted = value;
  },
  injectedTurnOutcomes,
  discardedInjectedTurnIds,
  get currentTurnInjectedTurnId(): string | undefined {
    return currentTurnInjectedTurnId;
  },
  set currentTurnInjectedTurnId(value: string | undefined) {
    currentTurnInjectedTurnId = value;
  },
};

export function beginTurn(context: BuiltinTurnStartContext): void {
  currentTurnStartTime = context.startedAt;
  currentTurnInjectedTurnId = context.injectedTurnId;
  currentTurnInboxMeta = context.inboxMeta;
  currentTurnProviderAnalytics = context.providerAnalytics ?? null;
}

export function resetTurnUsage(): void {
  currentTurnUsage = emptyUsage();
  latestMainAssistantUsage = null;
  currentTurnStartTime = null;
  currentPlanFileMinMtimeMs = null;
  currentTurnToolCount = 0;
  currentTurnHasOutput = false;
  currentTurnHadAssistantMessageError = false;
  currentTurnLastAssistantMessageError = null;
  currentTurnAnalyticsSource = null;
  currentTurnAnalyticsOrigin = null;
  currentTurnProviderAnalytics = null;
  currentTurnCompactResult = null;
  currentTurnSawCompactBoundary = false;
  currentTurnAssistantMessagePresent = false;
  turnHadSubstantiveActivity = false;
  currentTurnImTerminalEmitted = false;
  currentTurnTextBlocks.length = 0;
  currentTurnInjectedTurnId = undefined;
}

export function getCurrentTurnUsage(): BuiltinTurnUsage {
  return currentTurnUsage;
}

export function replaceCurrentTurnUsage(next: BuiltinTurnUsage): void {
  currentTurnUsage = next;
}

export function getLatestMainAssistantUsage(): import('../types/session').MessageUsage | null {
  return latestMainAssistantUsage;
}

export function setLatestMainAssistantUsage(usage: import('../types/session').MessageUsage | null): void {
  latestMainAssistantUsage = usage;
}

export function getCurrentTurnStartTime(): number | null {
  return currentTurnStartTime;
}

export function setCurrentTurnStartTime(value: number | null): void {
  currentTurnStartTime = value;
}

export function getCurrentPlanFileMinMtimeMs(): number | null {
  return currentPlanFileMinMtimeMs;
}

export function setCurrentPlanFileMinMtimeMs(value: number | null): void {
  currentPlanFileMinMtimeMs = value;
}

export function getCurrentTurnToolCount(): number {
  return currentTurnToolCount;
}

export function setCurrentTurnToolCount(value: number): void {
  currentTurnToolCount = value;
}

export function incrementCurrentTurnToolCount(): number {
  currentTurnToolCount += 1;
  return currentTurnToolCount;
}

export function hasCurrentTurnOutput(): boolean {
  return currentTurnHasOutput;
}

export function markCurrentTurnHasOutput(): void {
  currentTurnHasOutput = true;
}

export function setCurrentTurnHasOutput(value: boolean): void {
  currentTurnHasOutput = value;
}

export function markAssistantMessageError(error: string): void {
  currentTurnHadAssistantMessageError = true;
  currentTurnLastAssistantMessageError = error;
}

export function hadAssistantMessageError(): boolean {
  return currentTurnHadAssistantMessageError;
}

export function getLastAssistantMessageError(): string | null {
  return currentTurnLastAssistantMessageError;
}

export function clearAssistantMessageError(): void {
  currentTurnHadAssistantMessageError = false;
  currentTurnLastAssistantMessageError = null;
}

export function getCurrentTurnAnalyticsSource(): import('../types/session').TurnAnalyticsSource | null {
  return currentTurnAnalyticsSource;
}

export function setCurrentTurnAnalyticsSource(source: import('../types/session').TurnAnalyticsSource | null): void {
  currentTurnAnalyticsSource = source;
}

export function getCurrentTurnAnalyticsOrigin(): SessionOrigin | null {
  return currentTurnAnalyticsOrigin;
}

export function setCurrentTurnAnalyticsOrigin(origin: SessionOrigin | null): void {
  currentTurnAnalyticsOrigin = origin;
}

export function getCurrentTurnProviderAnalytics(): TurnProviderAnalytics | null {
  return currentTurnProviderAnalytics;
}

export function setCurrentTurnProviderAnalytics(analytics: TurnProviderAnalytics | null): void {
  currentTurnProviderAnalytics = analytics;
}

export function getCurrentTurnCompactResult(): 'success' | 'failed' | null {
  return currentTurnCompactResult;
}

export function setCurrentTurnCompactResult(value: 'success' | 'failed' | null): void {
  currentTurnCompactResult = value;
}

export function sawCompactBoundary(): boolean {
  return currentTurnSawCompactBoundary;
}

export function setSawCompactBoundary(value: boolean): void {
  currentTurnSawCompactBoundary = value;
}

export function isAssistantMessagePresent(): boolean {
  return currentTurnAssistantMessagePresent;
}

export function setAssistantMessagePresent(value: boolean): void {
  currentTurnAssistantMessagePresent = value;
}

export function hasSubstantiveActivity(): boolean {
  return turnHadSubstantiveActivity;
}

export function setSubstantiveActivity(value: boolean): void {
  turnHadSubstantiveActivity = value;
}

export function wasBrowserToolUsed(): boolean {
  return sessionBrowserToolUsed;
}

export function setBrowserToolUsed(value: boolean): void {
  sessionBrowserToolUsed = value;
}

export function wasStorageStateSaved(): boolean {
  return sessionStorageStateSaved;
}

export function setStorageStateSaved(value: boolean): void {
  sessionStorageStateSaved = value;
}

export function getCurrentTurnInboxMeta(): import('../inbox/types').InboxTurnMeta | undefined {
  return currentTurnInboxMeta;
}

export function setCurrentTurnInboxMeta(meta: import('../inbox/types').InboxTurnMeta | undefined): void {
  currentTurnInboxMeta = meta;
}

export function clearCurrentTurnInboxMeta(): void {
  currentTurnInboxMeta = undefined;
}

export function takeCurrentTurnInboxMeta(): import('../inbox/types').InboxTurnMeta | undefined {
  const meta = currentTurnInboxMeta;
  currentTurnInboxMeta = undefined;
  return meta;
}

export function appendCurrentTurnTextBlock(chunk: string): void {
  currentTurnTextBlocks.push(chunk);
}

export function getCurrentTurnText(): string {
  return currentTurnTextBlocks.join('').trim();
}

export function clearCurrentTurnTextBlocks(): void {
  currentTurnTextBlocks.length = 0;
}

export function pushPendingRequest(requestId: string | null | undefined): void {
  if (!requestId) return;
  pendingRequestIds.push(requestId);
}

export function popPendingRequest(): string | null {
  return pendingRequestIds.shift() ?? null;
}

export function peekPendingRequest(): string | null {
  return pendingRequestIds[0] ?? null;
}

export function removePendingRequest(requestId: string | null | undefined): boolean {
  if (!requestId) return false;
  const idx = pendingRequestIds.indexOf(requestId);
  if (idx < 0) return false;
  pendingRequestIds.splice(idx, 1);
  return true;
}

export function clearPendingRequests(): string[] {
  const drained = pendingRequestIds.slice();
  pendingRequestIds.length = 0;
  currentTurnImTerminalEmitted = false;
  return drained;
}

export function getPendingRequestIds(): readonly string[] {
  return pendingRequestIds;
}

export function hasCurrentTurnImTerminalEmitted(): boolean {
  return currentTurnImTerminalEmitted;
}

export function setCurrentTurnImTerminalEmitted(value: boolean): void {
  currentTurnImTerminalEmitted = value;
}

export function completeCurrentImRequest(emit: ImEmitter, data?: unknown): void {
  const requestId = popPendingRequest();
  if (!requestId || currentTurnImTerminalEmitted) return;
  currentTurnImTerminalEmitted = true;
  emit('complete', { requestId, ...(typeof data === 'object' && data ? data : {}) });
}

export function failCurrentImRequest(emit: ImEmitter, data?: unknown): void {
  const requestId = popPendingRequest();
  if (!requestId || currentTurnImTerminalEmitted) return;
  currentTurnImTerminalEmitted = true;
  emit('error', { requestId, ...(typeof data === 'object' && data ? data : {}) });
}

export function recordInjectedTurnOutcome(
  status: BuiltinInjectedTurnOutcome['status'],
  error?: string,
): void {
  if (!currentTurnInjectedTurnId) return;
  if (discardedInjectedTurnIds.delete(currentTurnInjectedTurnId)) {
    currentTurnInjectedTurnId = undefined;
    return;
  }
  injectedTurnOutcomes.set(currentTurnInjectedTurnId, {
    status,
    text: getCurrentTurnText(),
    assistantMessagePresent: currentTurnAssistantMessagePresent,
    ...(error ? { error } : {}),
  });
  currentTurnInjectedTurnId = undefined;
}

export function consumeInjectedTurnOutcome(injectedTurnId: string): BuiltinInjectedTurnOutcome | undefined {
  discardedInjectedTurnIds.delete(injectedTurnId);
  const outcome = injectedTurnOutcomes.get(injectedTurnId);
  injectedTurnOutcomes.delete(injectedTurnId);
  return outcome;
}

export function discardInjectedTurnOutcome(injectedTurnId: string): void {
  discardInjectedTurnOutcomeWithOptions(injectedTurnId);
}

export function discardInjectedTurnOutcomeWithOptions(
  injectedTurnId: string,
  options?: { retainForLateTerminal?: boolean },
): void {
  if (!injectedTurnId) return;
  injectedTurnOutcomes.delete(injectedTurnId);
  if (options?.retainForLateTerminal === false) {
    discardedInjectedTurnIds.delete(injectedTurnId);
  } else {
    discardedInjectedTurnIds.add(injectedTurnId);
  }
}

export function clearInjectedTurnOutcomes(): void {
  injectedTurnOutcomes.clear();
  discardedInjectedTurnIds.clear();
  currentTurnInjectedTurnId = undefined;
}

export function clearCurrentTurnInjectedTurnId(): void {
  currentTurnInjectedTurnId = undefined;
}

export function setCurrentTurnInjectedTurnId(injectedTurnId: string | undefined): void {
  currentTurnInjectedTurnId = injectedTurnId;
}

export function terminalCleanup(): {
  inboxMeta?: import('../inbox/types').InboxTurnMeta;
  replyText: string;
} {
  const inboxMeta = takeCurrentTurnInboxMeta();
  const replyText = getCurrentTurnText();
  clearCurrentTurnTextBlocks();
  currentTurnImTerminalEmitted = false;
  return { inboxMeta, replyText };
}

export function snapshotTurn() {
  return {
    currentTurnUsage,
    latestMainAssistantUsage,
    currentTurnStartTime,
    currentPlanFileMinMtimeMs,
    currentTurnToolCount,
    currentTurnHasOutput,
    currentTurnHadAssistantMessageError,
    currentTurnLastAssistantMessageError,
    currentTurnAnalyticsSource,
    currentTurnAnalyticsOrigin,
    currentTurnProviderAnalytics,
    currentTurnCompactResult,
    currentTurnSawCompactBoundary,
    currentTurnAssistantMessagePresent,
    turnHadSubstantiveActivity,
    sessionBrowserToolUsed,
    sessionStorageStateSaved,
    currentTurnInboxMeta,
    currentTurnTextBlocks: [...currentTurnTextBlocks],
    pendingRequestIds: [...pendingRequestIds],
    currentTurnImTerminalEmitted,
    injectedTurnOutcomes: new Map(injectedTurnOutcomes),
    discardedInjectedTurnIds: new Set(discardedInjectedTurnIds),
    currentTurnInjectedTurnId,
  };
}

export function resetTurnForTest(): void {
  currentTurnUsage = emptyUsage();
  latestMainAssistantUsage = null;
  currentTurnStartTime = null;
  currentPlanFileMinMtimeMs = null;
  currentTurnToolCount = 0;
  currentTurnHasOutput = false;
  currentTurnHadAssistantMessageError = false;
  currentTurnLastAssistantMessageError = null;
  currentTurnAnalyticsSource = null;
  currentTurnAnalyticsOrigin = null;
  currentTurnProviderAnalytics = null;
  currentTurnCompactResult = null;
  currentTurnSawCompactBoundary = false;
  currentTurnAssistantMessagePresent = false;
  turnHadSubstantiveActivity = false;
  sessionBrowserToolUsed = false;
  sessionStorageStateSaved = false;
  currentTurnInboxMeta = undefined;
  currentTurnTextBlocks.length = 0;
  pendingRequestIds.length = 0;
  currentTurnImTerminalEmitted = false;
  clearInjectedTurnOutcomes();
}
