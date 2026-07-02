import { useEffect, useMemo, useState } from 'react';

import type { Message as MessageType } from '@/types/chat';
import {
  buildHeightEstimateSeed,
  buildMessageLayoutFingerprint,
  estimateMessageRowHeight,
  type RowLayoutContract,
} from '@/utils/chatRowLayout';

export interface ChatScrollModel {
  data: readonly MessageType[];
  firstItemIndex?: number;
  heightEstimateSeed: number[];
  layoutByMessageId: ReadonlyMap<string, RowLayoutContract>;
}

export interface UseChatScrollModelOptions {
  historyMessages: readonly MessageType[];
  streamingMessage: MessageType | null;
  firstItemIndex?: number;
  sessionId?: string | null;
}

function getViewportHeight(): number {
  if (typeof window === 'undefined') return 800;
  return window.innerHeight || 800;
}

export function useChatScrollModel({
  historyMessages,
  streamingMessage,
  firstItemIndex,
  sessionId,
}: UseChatScrollModelOptions): ChatScrollModel {
  const [viewportHeight, setViewportHeight] = useState(getViewportHeight);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      const next = getViewportHeight();
      setViewportHeight(prev => (Math.abs(prev - next) < 80 ? prev : next));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const data = useMemo(
    () => (streamingMessage ? [...historyMessages, streamingMessage] : historyMessages),
    [historyMessages, streamingMessage],
  );

  const layoutFingerprint = useMemo(
    () => [
      sessionId ?? '',
      data.map(message => buildMessageLayoutFingerprint(message, viewportHeight)).join('\u001f'),
    ].join('\u001e'),
    [data, sessionId, viewportHeight],
  );

  const { layoutByMessageId, heightEstimateSeed } = useMemo(() => {
    const nextLayout = new Map<string, RowLayoutContract>();

    for (const message of data) {
      const contract = estimateMessageRowHeight(message, viewportHeight);
      nextLayout.set(message.id, contract);
    }

    const nextEstimates = buildHeightEstimateSeed(data, nextLayout);

    return {
      layoutByMessageId: nextLayout,
      heightEstimateSeed: nextEstimates,
    };
    // `layoutFingerprint` is the semantic dependency: token-level streaming
    // changes that stay inside the same line/code/attachment bucket keep the
    // previous estimates while `data` below remains live for rendering/search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutFingerprint]);

  return {
    data,
    firstItemIndex,
    heightEstimateSeed,
    layoutByMessageId,
  };
}
