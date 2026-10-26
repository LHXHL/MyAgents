import { getExternalExecutionTurnId } from './turn-lifecycle';
import type { InboxTurnMeta } from '../../inbox/types';
import { imEventBus, type ImEventType } from '../../utils/im-event-bus';
import { imRequestRegistry } from '../../utils/im-request-registry';
import type { ExternalPendingInteractiveRequest } from './types';
import type { ChannelInbound } from '../../session-core/channel-context';
import type { ChannelDeliveryMode } from '../../../shared/channelContext';

let activeRequestId: string | null = null;
// Native-consumed IM inputs share one turn and one visible answer. The first
// request keeps response transport; every joined request still needs a terminal.
const activeRequestIds = new Set<string>();
const currentTurnInboxMetas: InboxTurnMeta[] = [];

const currentTurnAttachmentHints: string[] = [];
const pendingPermissionSuggestions = new Map<string, unknown[] | undefined>();
const pendingExternalAskUserQuestions = new Map<string, { input: Record<string, unknown> }>();
const pendingExternalInteractiveRequests = new Map<string, ExternalPendingInteractiveRequest>();

export function resetExternalInteractiveState(): void {
  activeRequestId = null;
  activeRequestIds.clear();
  currentTurnInboxMetas.length = 0;
  currentTurnAttachmentHints.length = 0;
  pendingPermissionSuggestions.clear();
  pendingExternalAskUserQuestions.clear();
  pendingExternalInteractiveRequests.clear();
}

export function getExternalActiveRequestId(): string | null {
  return activeRequestId;
}

/** Admission uses the incoming request's identity, which may differ from the active turn. */
export function getExternalChannelInbound(requestId: string | undefined): ChannelInbound | undefined {
  return requestId ? imRequestRegistry.get(requestId)?.channelInbound : undefined;
}

export function publishExternalChannelDeliveryPolicy(
  requestId: string | undefined,
  mode: ChannelDeliveryMode | undefined,
): void {
  if (!requestId) return;
  const request = imRequestRegistry.get(requestId);
  if (request) request.channelDeliveryMode = mode ?? 'auto';
  // Publish after the write: the bus stamps each event from this request's policy.
  imEventBus.emit(requestId, 'delivery-policy');
}

export function getExternalImBridgeTurnContext(): import('../../session-core/im-bridge-types').ImBridgeTurnContext | null {
  return activeRequestId
    ? imRequestRegistry.get(activeRequestId)?.imBridgeTurnContext ?? null
    : null;
}

export function setExternalActiveRequestId(requestId: string | null | undefined): void {
  activeRequestIds.clear();
  activeRequestId = requestId ?? null;
  if (activeRequestId) activeRequestIds.add(activeRequestId);
}

export function appendExternalActiveRequest(requestId: string | undefined): void {
  if (!requestId) return;
  activeRequestId ??= requestId;
  activeRequestIds.add(requestId);
  imRequestRegistry.setStatus(requestId, 'running');
}

export function hasExternalActiveRequest(requestId: string): boolean {
  return activeRequestIds.has(requestId);
}

export function clearExternalActiveRequestId(): void {
  activeRequestId = null;
  activeRequestIds.clear();
}

/** Pattern B — emit per-request IM event. Subscribers in /api/im/chat filter
 *  by matching requestId. No-op when no active IM trace (desktop / cron). */
export function fireExternalImCallback(type: ImEventType, data: unknown): void {
  if (activeRequestId !== null) {
    imEventBus.emit(activeRequestId, type, data);
  }
  if (type === 'complete' || type === 'error' || type === 'cancelled' || type === 'activity') {
    for (const requestId of activeRequestIds) {
      if (requestId !== activeRequestId) {
        imEventBus.emit(requestId, type, type === 'activity' ? data : { finalPayloads: [] });
      }
    }
  }
}

export function finalizeExternalActiveRequest(status: 'completed' | 'failed'): void {
  for (const requestId of activeRequestIds) {
    imRequestRegistry.setStatus(requestId, status);
    imRequestRegistry.unregister(requestId);
  }
  clearExternalActiveRequestId();
}

/** Settle one admitted-but-not-yet-running IM request by its own trace id. */
export function finalizeExternalQueuedImRequest(
  requestId: string,
  terminal: 'cancelled' | 'failed',
  eventData: unknown,
): void {
  imEventBus.emit(requestId, terminal === 'cancelled' ? 'cancelled' : 'error', eventData);
  imRequestRegistry.setStatus(requestId, terminal);
  imRequestRegistry.unregister(requestId);
}

export function setExternalTurnInboxMeta(meta: InboxTurnMeta | null): void {
  currentTurnInboxMetas.length = 0;
  appendExternalTurnInboxMeta(meta);
}

/** Join only after the native input consumption receipt, never at HTTP admission. */
export function appendExternalTurnInboxMeta(meta: InboxTurnMeta | null | undefined): void {
  if (meta && !currentTurnInboxMetas.some(item => item.originalMessageId === meta.originalMessageId && item.fromSessionId === meta.fromSessionId))
    currentTurnInboxMetas.push(meta);
}

export function getExternalTurnInboxMeta(): InboxTurnMeta | null {
  return currentTurnInboxMetas[0] ?? null;
}

export function clearExternalTurnInboxMeta(): void {
  currentTurnInboxMetas.length = 0;
}

export function resetExternalTurnAttachmentHints(): void {
  currentTurnAttachmentHints.length = 0;
}

export function addExternalTurnAttachmentHint(hint: string): void {
  currentTurnAttachmentHints.push(hint);
}

export function getExternalTurnAttachmentHintsSnapshot(): string[] {
  return [...currentTurnAttachmentHints];
}

export function snapshotExternalTurnReplyState(): {
  inboxMetas: InboxTurnMeta[];
  attachmentHints: string[];
} {
  const inboxMetas = currentTurnInboxMetas.splice(0);
  const attachmentHints = currentTurnAttachmentHints.splice(0);
  return { inboxMetas, attachmentHints };
}

export function deliverExternalWatchError(input: {
  sessionId: string | null | undefined;
  turnId?: string;
  text: string;
  errorCode: string;
  errorMessage: string;
}): void {
  if (!input.sessionId) return;
  const turnId = input.turnId ?? getExternalExecutionTurnId() ?? undefined;
  const inboxMetas = currentTurnInboxMetas.splice(0);
  const requestEventIds = inboxMetas.map(meta => meta.originalMessageId);
  const attachmentHintSnapshot = getExternalTurnAttachmentHintsSnapshot();
  const attachmentHints = attachmentHintSnapshot.length > 0
    ? attachmentHintSnapshot
    : undefined;
  void import('../../inbox/watch-deliver').then(({ deliverSessionWatchEvents }) =>
    deliverSessionWatchEvents(input.sessionId!, {
      text: input.text,
      turnId, requestEventIds,
      terminalStatus: input.errorCode === 'session_aborted' ? 'stopped' : 'error',
      error: { code: input.errorCode, message: input.errorMessage },
      attachmentHints,
    }, inboxMetas),
  ).catch((err) =>
    console.error('[session-watch] external failure watch push failed:', err),
  );
}

/**
 * PRD 0.2.18 — clear inbox meta + push error reply if needed when
 * sendExternalMessage rejects BEFORE persistTurnResult ever runs (Case 1/2/3
 * throw paths). Without this helper the meta would leak to the next turn and
 * a stale reply would be pushed to the wrong caller.
 */
export function clearExternalInboxMetaOnRejection(input: {
  sessionId: string | null | undefined;
  turnId?: string;
  errorCode: string;
  errorMessage: string;
}): void {
  const metas = currentTurnInboxMetas.splice(0);
  resetExternalTurnAttachmentHints();
  if (metas.length === 0 || !input.sessionId) return;
  void import('../../inbox/watch-deliver').then(({ deliverSessionWatchEvents }) =>
    deliverSessionWatchEvents(input.sessionId!, {
      text: '', turnId: input.turnId,
      requestEventIds: metas.map(meta => meta.originalMessageId),
      terminalStatus: input.errorCode === 'session_aborted' ? 'stopped' : 'error',
      error: { code: input.errorCode, message: input.errorMessage },
    }, metas),
  ).catch(err => console.error('[inbox] external rejection reply pushback failed:', err));
}

export function setExternalPermissionSuggestions(requestId: string, suggestions: unknown[] | undefined): void {
  pendingPermissionSuggestions.set(requestId, suggestions);
}

export function consumeExternalPermissionSuggestions(requestId: string): unknown[] | undefined {
  const suggestions = pendingPermissionSuggestions.get(requestId);
  pendingPermissionSuggestions.delete(requestId);
  return suggestions;
}

export function getExternalPermissionSuggestions(requestId: string): unknown[] | undefined {
  return pendingPermissionSuggestions.get(requestId);
}

export function clearExternalPermissionSuggestions(): void {
  pendingPermissionSuggestions.clear();
}

export function setExternalAskUserQuestion(
  requestId: string,
  value: { input: Record<string, unknown> },
): void {
  pendingExternalAskUserQuestions.set(requestId, value);
}

export function getExternalAskUserQuestion(
  requestId: string,
): { input: Record<string, unknown> } | undefined {
  return pendingExternalAskUserQuestions.get(requestId);
}

export function hasExternalAskUserQuestion(requestId: string): boolean {
  return pendingExternalAskUserQuestions.has(requestId);
}

export function deleteExternalAskUserQuestion(requestId: string): void {
  pendingExternalAskUserQuestions.delete(requestId);
}

export function clearExternalAskUserQuestions(): void {
  pendingExternalAskUserQuestions.clear();
}

export function setExternalInteractiveRequest(
  requestId: string,
  request: ExternalPendingInteractiveRequest,
): void {
  pendingExternalInteractiveRequests.set(requestId, request);
}

export function getExternalInteractiveRequest(requestId: string): ExternalPendingInteractiveRequest | undefined {
  return pendingExternalInteractiveRequests.get(requestId);
}

export function deleteExternalInteractiveRequest(requestId: string): void {
  pendingExternalInteractiveRequests.delete(requestId);
}

export function getExternalInteractiveRequestEntries(): IterableIterator<[string, ExternalPendingInteractiveRequest]> {
  return pendingExternalInteractiveRequests.entries();
}

export function getExternalInteractiveRequestsSnapshot(): ExternalPendingInteractiveRequest[] {
  return Array.from(pendingExternalInteractiveRequests.values());
}

export function hasExternalInteractiveRequests(): boolean {
  return pendingExternalInteractiveRequests.size > 0;
}

export function clearExternalInteractiveRequests(): void {
  pendingExternalInteractiveRequests.clear();
}
