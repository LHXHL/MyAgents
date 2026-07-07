export type InvalidResumeAnchorKind = 'rewind' | 'reload' | 'fork';

export function isSdkMissingResumeMessageError(errorMessage: string): boolean {
  return errorMessage.includes('No message found with message.uuid');
}

export function extractSdkMissingResumeMessageUuid(errorMessage: string): string | undefined {
  const match = errorMessage.match(/No message found with message\.uuid of:\s*([0-9a-fA-F-]{36})/);
  return match?.[1];
}

export function shouldSuppressRecoveredResumeAnchorError(params: {
  errorMessage: string;
  recoveredAnchors: readonly InvalidResumeAnchorKind[];
}): boolean {
  return isSdkMissingResumeMessageError(params.errorMessage)
    && params.recoveredAnchors.length > 0;
}

export function buildResumeAnchorReplayItem<T extends { resolve: () => void }>(
  source: T | null | undefined,
): T | null {
  if (!source) return null;
  return {
    ...source,
    resolve: () => {},
  };
}
