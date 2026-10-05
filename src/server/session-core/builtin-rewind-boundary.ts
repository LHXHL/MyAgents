import type { SessionMessage } from '../../shared/types/session-message';

type BoundaryMessage = Pick<SessionMessage,
  'role' | 'sdkUuid' | 'messageKind' | 'runtimeTurnAnchor' | 'runtimeOperationAnchor'>;

/** Product diagnostics do not extend native history. Real content must have
 * its own exact boundary; searching past unknown content would discard it.
 * Native Query startup remains the authority for whether that UUID resumes. */
export function selectBuiltinRewindBoundary(prefix: readonly BoundaryMessage[]):
  | { kind: 'empty' }
  | { kind: 'exact'; sdkUuid: string }
  | { kind: 'unavailable' } {
  for (let index = prefix.length - 1; index >= 0; index--) {
    const message = prefix[index];
    if (message.messageKind === 'diagnostic') {
      if (message.role !== 'assistant' || message.sdkUuid !== undefined
        || message.runtimeTurnAnchor !== undefined || message.runtimeOperationAnchor !== undefined) {
        return { kind: 'unavailable' };
      }
      continue;
    }
    return message.sdkUuid ? { kind: 'exact', sdkUuid: message.sdkUuid } : { kind: 'unavailable' };
  }
  return { kind: 'empty' };
}
