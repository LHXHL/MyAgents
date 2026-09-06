import type { UnifiedEventCallback } from '../../runtimes/types';

export function reconcileExpiredDshInteractionResponse(
  responseState: unknown,
  requestId: string,
  deletePendingInteraction: (requestId: string) => void,
  onEvent: UnifiedEventCallback,
): boolean {
  if (responseState !== 'expired') return false;

  deletePendingInteraction(requestId);
  onEvent({ kind: 'interactive_request_resolved', requestId, status: 'expired' });
  return true;
}
