import type { Message } from '@/types/chat';
import { parseBackgroundTaskNotificationMessage } from '@/utils/backgroundTaskStatus';

/** Pending sends are a presentation overlay, never a V2 content baseline. */
export function projectOptimisticUserMessages(
  history: readonly Message[],
  pending: readonly Message[],
): Message[] {
  if (pending.length === 0) return history as Message[];
  const adopted = new Set<string>();
  const rows = history.map(message => {
    const requestId = message.role === 'user' ? message.metadata?.clientRequestId : undefined;
    const preview = requestId ? pending.find(row => row.metadata?.clientRequestId === requestId) : undefined;
    if (!preview || !requestId) return message;
    adopted.add(requestId);
    // Canonical create may precede its text operation. Keep the user's text
    // visible in that interval without modifying transcript offsets/content.
    return message.content === '' && preview.content !== ''
      ? { ...message, content: preview.content }
      : message;
  });
  return [...rows, ...pending.filter(message => !adopted.has(message.metadata?.clientRequestId ?? ''))];
}

/**
 * Persisted background-task notifications are session state, not visual chat rows.
 * Keep the parser as the authority so malformed or merely similarly-named user
 * messages are never silently removed from the timeline.
 */
export function isVisibleChatTimelineRow(message: Message): boolean {
  return parseBackgroundTaskNotificationMessage(message) === null;
}

export function projectVisibleChatTimelineRows(
  historyMessages: readonly Message[],
  streamingMessage: Message | null = null,
): Message[] {
  const messages = streamingMessage
    ? [...historyMessages, streamingMessage]
    : historyMessages;
  return messages.filter(isVisibleChatTimelineRow);
}

export function countVisibleChatTimelineRows(messages: readonly Message[]): number {
  let count = 0;
  for (const message of messages) {
    if (isVisibleChatTimelineRow(message)) count += 1;
  }
  return count;
}

export function shiftFirstItemIndexForVisiblePrepend(
  firstItemIndex: number,
  prependedMessages: readonly Message[],
): number {
  return firstItemIndex - countVisibleChatTimelineRows(prependedMessages);
}
