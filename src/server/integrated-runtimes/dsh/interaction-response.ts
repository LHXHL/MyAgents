import type { UnifiedEventCallback } from '../../runtimes/types';

/** Keep free text separate from option identity, including commas inside either. */
export function buildDshQuestionAnswer(id: string, value: unknown, labels: readonly string[], multiSelect: boolean) {
  if (typeof value === 'string') {
    if (labels.includes(value)) return { id, selected: [value] };
    const parts = value.split(',').map(part => part.trim()).filter(Boolean);
    if (multiSelect && parts.length > 0 && parts.every(part => labels.includes(part))) return { id, selected: parts };
    return { id, selected: [], custom: value };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DSH question answer is missing');
  const answer = value as { selected?: unknown; custom?: unknown };
  if (!Array.isArray(answer.selected) || !answer.selected.every(label => typeof label === 'string')
    || (answer.custom !== undefined && typeof answer.custom !== 'string')) throw new Error('DSH question answer has an invalid shape');
  return { id, selected: answer.selected as string[], ...(answer.custom === undefined ? {} : { custom: answer.custom as string }) };
}

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
