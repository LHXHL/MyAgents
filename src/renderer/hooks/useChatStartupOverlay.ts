import { useCallback, useEffect, useState } from 'react';
import type { Message } from '@/types/chat';

/** Chat owns the boot shell; committed MessageList rows own the query handoff. */
export function useChatStartupOverlay({
  hasInitialMessage,
  initialClientRequestId,
  isConnected,
  isSessionLoading,
  agentError,
  startupError,
  hasPendingInteraction,
}: {
  hasInitialMessage: boolean;
  initialClientRequestId?: string;
  isConnected: boolean;
  isSessionLoading: boolean;
  agentError: string | null;
  startupError?: string | null;
  hasPendingInteraction: boolean;
}) {
  const [showStartupOverlay, setShowStartupOverlay] = useState(true);
  // Reuse the send/adoption identity. Old fork history and optimistic rows must
  // never qualify as the committed response to this launch request.
  const [startupClientRequestId] = useState(() => initialClientRequestId ?? crypto.randomUUID());
  const dismissStartupOverlay = useCallback(() => setShowStartupOverlay(false), []);
  const onStartupItemsRendered = useCallback((messages: readonly Message[]) => {
    if (hasInitialMessage && messages.some(message =>
      message.role === 'user' &&
      message.metadata?.clientRequestId === startupClientRequestId &&
      message.deliveryStatus === undefined,
    )) dismissStartupOverlay();
  }, [hasInitialMessage, startupClientRequestId, dismissStartupOverlay]);

  // Derive these one-way transitions from the current projection before paint,
  // rather than committing a stale shell and then correcting it in an effect.
  // Errors/human decisions must be reachable even without a query row; empty
  // entries have no launch request to wait for.
  if (showStartupOverlay && (agentError || startupError || hasPendingInteraction ||
    (!hasInitialMessage && isConnected && !isSessionLoading))) {
    setShowStartupOverlay(false);
  }

  useEffect(() => {
    if (!showStartupOverlay) return;
    // Preserve the existing escape hatch for an unresponsive backend.
    const timeout = setTimeout(dismissStartupOverlay, 30_000);
    return () => clearTimeout(timeout);
  }, [showStartupOverlay, dismissStartupOverlay]);

  return { showStartupOverlay, startupClientRequestId, dismissStartupOverlay, onStartupItemsRendered };
}
