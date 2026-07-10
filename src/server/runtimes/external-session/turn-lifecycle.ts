import { TurnFinalizationGate } from '../external-turn-finalization';
import { decideSessionCompleteErrorAction } from '../external-abort-policy';
import type { ExternalTurnUsage } from './types';
import type { UnifiedEvent } from '../types';
import type { ContextUsage } from '../../../shared/types/context-usage';

let turnCompleted = false;
let lastTurnSucceeded = false;
let currentTurnStartTime = 0;
let currentTurnUsage: ExternalTurnUsage | null = null;
let currentTurnContextUsage: ContextUsage | null = null;
let currentTurnEstimatedInputTokens = 0;
let turnPromotionGeneration = 0;
let activeTurnPromotion: ExternalTurnPromotionToken | null = null;

const turnFinalization = new TurnFinalizationGate();

export function resetExternalTurnLifecycleState(): void {
  turnCompleted = false;
  lastTurnSucceeded = false;
  currentTurnStartTime = 0;
  currentTurnUsage = null;
  currentTurnContextUsage = null;
  currentTurnEstimatedInputTokens = 0;
  turnPromotionGeneration += 1;
  activeTurnPromotion = null;
}

export type ExternalTurnPromotionToken = Readonly<{ generation: number }>;

export function beginExternalTurnPromotion(): ExternalTurnPromotionToken | null {
  if (activeTurnPromotion) return null;
  const token = { generation: ++turnPromotionGeneration };
  activeTurnPromotion = token;
  return token;
}

export function isExternalTurnPromotionCurrent(token: ExternalTurnPromotionToken): boolean {
  return activeTurnPromotion?.generation === token.generation;
}

export function finishExternalTurnPromotion(token: ExternalTurnPromotionToken): void {
  if (isExternalTurnPromotionCurrent(token)) activeTurnPromotion = null;
}

export function cancelExternalTurnPromotion(): boolean {
  if (!activeTurnPromotion) return false;
  turnPromotionGeneration += 1;
  activeTurnPromotion = null;
  return true;
}

export function isExternalTurnPromotionInFlight(): boolean {
  return activeTurnPromotion !== null;
}

export function resetExternalTurnAccumulators(): void {
  currentTurnUsage = null;
  currentTurnContextUsage = null;
  currentTurnEstimatedInputTokens = 0;
}

export function setExternalTurnCompleted(value: boolean): void {
  turnCompleted = value;
}

export function isExternalTurnCompleted(): boolean {
  return turnCompleted;
}

export function setExternalLastTurnSucceeded(value: boolean): void {
  lastTurnSucceeded = value;
}

export function didExternalLastTurnSucceed(): boolean {
  return lastTurnSucceeded;
}

export function setExternalTurnStartTime(value: number): void {
  currentTurnStartTime = value;
}

export function markExternalTurnStarted(now = Date.now()): void {
  currentTurnStartTime = now;
}

export function clearExternalTurnStartTime(): void {
  currentTurnStartTime = 0;
}

export function getExternalTurnStartTime(): number {
  return currentTurnStartTime;
}

export function setExternalCurrentTurnUsage(usage: ExternalTurnUsage | null): void {
  currentTurnUsage = usage;
}

export function getExternalCurrentTurnUsage(): ExternalTurnUsage | null {
  return currentTurnUsage;
}

export function updateExternalCurrentTurnUsageModel(model: string): void {
  if (currentTurnUsage) {
    currentTurnUsage.model = model;
  }
}

export function setExternalCurrentTurnContextUsage(usage: ContextUsage | null): void {
  currentTurnContextUsage = usage;
}

export function getExternalCurrentTurnContextUsage(): ContextUsage | null {
  return currentTurnContextUsage;
}

export function setExternalCurrentTurnEstimatedInputTokens(tokens: number): void {
  currentTurnEstimatedInputTokens = tokens;
}

export function getExternalCurrentTurnEstimatedInputTokens(): number {
  return currentTurnEstimatedInputTokens;
}

export function isExternalTurnFinalizationInFlight(): boolean {
  return turnFinalization.inFlight;
}

export function trackExternalTurnFinalization(promise: Promise<unknown>): void {
  turnFinalization.track(promise);
}

export function waitExternalTurnFinalization(timeoutMs: number): Promise<boolean> {
  return turnFinalization.settled(timeoutMs);
}

export type ExternalTurnFailureCleanup = 'defer-to-stop' | 'stopped' | 'error';

export type ExternalTurnCompletePlan =
  | { kind: 'persist-success' }
  | { kind: 'defer-to-stop'; message: string }
  | { kind: 'failure'; cleanup: 'stopped' | 'error'; message: string };

export type ExternalSessionCompletePlan =
  | { kind: 'ignore-prewarm-exit'; subtype: string }
  | { kind: 'success'; shouldFinalize: boolean }
  | { kind: 'ignore-idle'; message: string }
  | { kind: 'suppress-user-stop'; message: string }
  | { kind: 'failure'; message: string };

export function isSuccessfulExternalTurnCompletion(
  event: Pick<Extract<UnifiedEvent, { kind: 'turn_complete' }>, 'status'>,
): boolean {
  return !event.status
    || event.status === 'completed'
    || event.status === 'success'
    || event.status === 'succeeded';
}

function isInterruptedExternalTurnStatus(status: string | undefined): boolean {
  return status === 'interrupted' || status === 'cancelled' || status === 'canceled';
}

export function classifyExternalTurnFailureCleanup(
  event: Pick<Extract<UnifiedEvent, { kind: 'turn_complete' }>, 'status'>,
  intentionalStopInProgress: boolean,
): ExternalTurnFailureCleanup {
  if (intentionalStopInProgress) return 'defer-to-stop';
  if (isInterruptedExternalTurnStatus(event.status)) return 'stopped';
  return 'error';
}

export function externalTurnFailureMessage(event: Extract<UnifiedEvent, { kind: 'turn_complete' }>): string {
  return event.error
    || event.result
    || (event.status ? `External runtime turn ended with status ${event.status}` : 'External runtime turn failed');
}

export function markExternalTurnComplete(
  event: Extract<UnifiedEvent, { kind: 'turn_complete' }>,
  input: { intentionalStopInProgress: boolean },
): ExternalTurnCompletePlan {
  turnCompleted = true;
  const turnSucceeded = isSuccessfulExternalTurnCompletion(event);
  lastTurnSucceeded = turnSucceeded;
  if (turnSucceeded) return { kind: 'persist-success' };

  const message = externalTurnFailureMessage(event);
  const cleanup = classifyExternalTurnFailureCleanup(event, input.intentionalStopInProgress);
  if (cleanup === 'defer-to-stop') {
    return { kind: 'defer-to-stop', message };
  }
  return { kind: 'failure', cleanup, message };
}

export function markExternalSessionComplete(
  event: Extract<UnifiedEvent, { kind: 'session_complete' }>,
  input: {
    hasAssistantText: boolean;
    consumeUserRequestedStop: () => boolean;
  },
): ExternalSessionCompletePlan {
  if (!turnCompleted && currentTurnStartTime === 0) {
    return { kind: 'ignore-prewarm-exit', subtype: event.subtype };
  }

  if (event.subtype === 'success') {
    if (!turnCompleted) {
      lastTurnSucceeded = true;
      return { kind: 'success', shouldFinalize: true };
    }
    return { kind: 'success', shouldFinalize: false };
  }

  const message = event.result || 'Session ended with error';
  const errorAction = decideSessionCompleteErrorAction({
    turnCompleted,
    hasAssistantText: input.hasAssistantText,
    userRequestedStop: input.consumeUserRequestedStop(),
    finalizationInFlight: turnFinalization.inFlight,
  });

  if (errorAction === 'ignore-idle') {
    return { kind: 'ignore-idle', message };
  }
  if (errorAction === 'suppress-user-stop') {
    return { kind: 'suppress-user-stop', message };
  }
  return { kind: 'failure', message };
}
