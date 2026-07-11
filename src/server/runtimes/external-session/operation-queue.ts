import type { ImagePayload } from '../types';
import type { ExternalRuntimeConfigPatch, ExternalRuntimeConfigSnapshot } from '../types';
import { canDrainExternalQueue, shouldQueueExternalSend } from '../external-queue-policy';
import { mergeRuntimeConfigPatches } from '../../session-core/runtime-config-policy';
import type { ChatQueueResponseMode } from '../../../shared/config-types';
import type { TurnOwner } from '../../session-core/turn-queue';
import type {
  ExternalConfigSource,
  ExternalQueuedConfigOperation,
  ExternalQueuedMessageOperation,
  ExternalSendContext,
  ExternalSessionState,
  ExternalTurnOperation,
} from './types';

const externalOperationQueue: ExternalTurnOperation[] = [];
let externalReservedDrainOperation: ExternalTurnOperation | null = null;
let externalQueueSeq = 0;
let externalConfigSeq = 0;
let externalOperationDrainInFlight = false;
let externalUserMsgSeq = 0;
let externalDesktopSendTail: Promise<unknown> = Promise.resolve();
let externalOperationGeneration = 0;

const EXTERNAL_MAX_QUEUE_SIZE = 50;

export class ExternalQueueGenerationStaleError extends Error {
  constructor() {
    super('External operation queue generation is stale');
    this.name = 'ExternalQueueGenerationStaleError';
  }
}

export function isExternalQueueGenerationStaleError(err: unknown): err is ExternalQueueGenerationStaleError {
  return err instanceof ExternalQueueGenerationStaleError;
}

export function getExternalOperationGeneration(): number {
  return externalOperationGeneration;
}

export function isCurrentExternalOperationGeneration(generation: number): boolean {
  return externalOperationGeneration === generation;
}

export function getExternalOperationQueueLength(): number {
  return externalOperationQueue.length;
}

export function hasExternalQueuedOperations(): boolean {
  return externalOperationQueue.length > 0;
}

export function isExternalOperationDrainInFlight(): boolean {
  return externalOperationDrainInFlight;
}

export function setExternalOperationDrainInFlight(value: boolean): void {
  externalOperationDrainInFlight = value;
}

export function queuedExternalMessageCount(): number {
  return externalOperationQueue.reduce((count, item) => count + (item.kind === 'message' ? 1 : 0), 0);
}

export function hasQueuedExternalConfigOperation(): boolean {
  return externalOperationQueue.some((item) => item.kind === 'config');
}

export function shouldQueueExternalDesktopSend(
  state: ExternalSessionState,
  options?: {
    responseMode?: ChatQueueResponseMode;
    canSteerActiveTurn?: boolean;
  },
): boolean {
  return shouldQueueExternalSend({
    state,
    queueLength: externalOperationQueue.length,
    responseMode: options?.responseMode ?? 'turn',
    canSteerActiveTurn: options?.canSteerActiveTurn === true,
  }) || externalOperationDrainInFlight;
}

export function canDrainExternalOperations(state: ExternalSessionState): boolean {
  return canDrainExternalQueue(state, externalOperationQueue.length) && !externalOperationDrainInFlight;
}

export function nextExternalUserMessageId(): string {
  return `user-${Date.now()}-${externalUserMsgSeq++}`;
}

export function nextExternalQueueId(): string {
  return `xq-${Date.now()}-${externalQueueSeq++}`;
}

export function enqueueExternalMessageOperation(input: {
  text: string;
  images?: ImagePayload[];
  context: ExternalSendContext;
  runtimeConfig: ExternalRuntimeConfigSnapshot;
  queueId?: string;
}): {
  queued: true;
  queueId: string;
  dispatchAcceptance: Promise<{ queued: boolean; error?: string }>;
} | { queued: false; error: string } {
  if (queuedExternalMessageCount() >= EXTERNAL_MAX_QUEUE_SIZE) {
    return { queued: false, error: '排队消息已达上限，请稍后再发' };
  }
  const queueId = input.queueId ?? nextExternalQueueId();
  let settleDispatchAcceptance!: (result: { queued: boolean; error?: string }) => void;
  const dispatchAcceptance = new Promise<{ queued: boolean; error?: string }>((resolve) => {
    settleDispatchAcceptance = resolve;
  });
  externalOperationQueue.push({
    kind: 'message',
    queueId,
    text: input.text,
    images: input.images,
    context: { ...input.context, queueId },
    runtimeConfig: input.runtimeConfig,
    dispatchAcceptance,
    settleDispatchAcceptance,
  });
  return { queued: true, queueId, dispatchAcceptance };
}

export function enqueueExternalConfigOperation(
  patch: ExternalRuntimeConfigPatch,
  source: ExternalConfigSource,
): number {
  const tail = externalOperationQueue[externalOperationQueue.length - 1];
  if (tail?.kind === 'config') {
    tail.patch = mergeRuntimeConfigPatches(tail.patch, patch);
    tail.source = source;
    return externalOperationQueue.length;
  }
  externalOperationQueue.push({
    kind: 'config',
    opId: `xcfg-${Date.now()}-${externalConfigSeq++}`,
    patch,
    source,
  });
  return externalOperationQueue.length;
}

export function clearExternalQueueWithCancellation(): string[] {
  const queuedMessages = externalOperationQueue
    .filter((item): item is ExternalQueuedMessageOperation => item.kind === 'message');
  const cancelledQueueIds = queuedMessages.map((item) => item.queueId);
  for (const item of queuedMessages) {
    item.settleDispatchAcceptance({ queued: false });
  }
  if (externalReservedDrainOperation?.kind === 'message') {
    cancelledQueueIds.push(externalReservedDrainOperation.queueId);
    externalReservedDrainOperation.settleDispatchAcceptance({
      queued: false,
    });
  }
  externalOperationQueue.length = 0;
  externalReservedDrainOperation = null;
  externalOperationDrainInFlight = false;
  externalDesktopSendTail = Promise.resolve();
  externalOperationGeneration += 1;
  return cancelledQueueIds;
}

export function cancelExternalQueuedMessagesByOwner(owner: TurnOwner): string[] {
  const matches = (item: ExternalQueuedMessageOperation) =>
    item.context.turnOwner?.kind === owner.kind
      && item.context.turnOwner.id === owner.id;
  const canceled: string[] = [];
  for (let index = externalOperationQueue.length - 1; index >= 0; index -= 1) {
    const item = externalOperationQueue[index];
    if (item.kind !== 'message' || !matches(item)) continue;
    externalOperationQueue.splice(index, 1);
    item.context.beforeDispatch?.cancel?.();
    item.settleDispatchAcceptance({ queued: false });
    canceled.push(item.queueId);
  }
  if (externalReservedDrainOperation?.kind === 'message' && matches(externalReservedDrainOperation)) {
    const item = externalReservedDrainOperation;
    externalReservedDrainOperation = null;
    externalOperationDrainInFlight = false;
    item.context.beforeDispatch?.cancel?.();
    item.settleDispatchAcceptance({ queued: false });
    canceled.push(item.queueId);
  }
  return canceled;
}

export function hasExternalQueuedMessageByOwner(owner: TurnOwner): boolean {
  const matches = (item: ExternalQueuedMessageOperation) =>
    item.context.turnOwner?.kind === owner.kind
      && item.context.turnOwner.id === owner.id;
  return externalOperationQueue.some(
    (item) => item.kind === 'message' && matches(item),
  ) || (
    externalReservedDrainOperation?.kind === 'message'
    && matches(externalReservedDrainOperation)
  );
}

export function consumeLeadingExternalConfigOps(): { patch: ExternalRuntimeConfigPatch; source: ExternalConfigSource } | null {
  let patch: ExternalRuntimeConfigPatch | null = null;
  let source: ExternalConfigSource = 'runtime-config';
  while (externalOperationQueue[0]?.kind === 'config') {
    const op = externalOperationQueue.shift() as ExternalQueuedConfigOperation;
    patch = mergeRuntimeConfigPatches(patch ?? {}, op.patch);
    source = op.source;
  }
  return patch ? { patch, source } : null;
}

export function shiftExternalOperation(): ExternalTurnOperation | undefined {
  return externalOperationQueue.shift();
}

export function reserveExternalOperationForDrain(): ExternalTurnOperation | undefined {
  externalReservedDrainOperation = externalOperationQueue.shift() ?? null;
  return externalReservedDrainOperation ?? undefined;
}

export function releaseExternalDrainReservation(item: ExternalTurnOperation | undefined): void {
  if (!item) return;
  if (externalReservedDrainOperation === item) {
    externalReservedDrainOperation = null;
  }
}

export function unshiftExternalOperation(item: ExternalTurnOperation): void {
  externalOperationQueue.unshift(item);
}

export function moveExternalQueuedMessageToFront(queueId: string): boolean {
  const idx = externalOperationQueue.findIndex(q => q.kind === 'message' && q.queueId === queueId);
  if (idx < 0) return false;
  if (idx > 0) {
    const [item] = externalOperationQueue.splice(idx, 1);
    externalOperationQueue.unshift(item);
  }
  return true;
}

export function cancelExternalQueuedMessage(queueId: string): string | null {
  const idx = externalOperationQueue.findIndex(q => q.kind === 'message' && q.queueId === queueId);
  if (idx < 0) return null;
  const [item] = externalOperationQueue.splice(idx, 1) as ExternalQueuedMessageOperation[];
  item.settleDispatchAcceptance({ queued: false });
  return item.text;
}

export function settleExternalMessageOperation(
  item: ExternalQueuedMessageOperation,
  result: { queued: boolean; error?: string },
): void {
  item.settleDispatchAcceptance(result);
}

export function getExternalQueueStatusSnapshot(): Array<{ id: string; messagePreview: string }> {
  return externalOperationQueue
    .filter((q): q is ExternalQueuedMessageOperation => q.kind === 'message')
    .map(q => ({ id: q.queueId, messagePreview: q.text.slice(0, 100) }));
}

export function chainExternalDesktopSend<T>(
  dispatch: () => Promise<T>,
  generation = externalOperationGeneration,
): Promise<T> {
  const task = externalDesktopSendTail.then(() => {
    if (!isCurrentExternalOperationGeneration(generation)) {
      throw new ExternalQueueGenerationStaleError();
    }
    return dispatch();
  });
  externalDesktopSendTail = task.catch(() => undefined);
  return task;
}
