import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types/chat';
import { useChatStartupOverlay } from './useChatStartupOverlay';

const base = {
  hasInitialMessage: true,
  isConnected: false,
  isSessionLoading: false,
  agentError: null as string | null,
  hasPendingInteraction: false,
};
function row(requestId: string, overrides: Partial<Message> = {}): Message {
  return { id: 'server-user', role: 'user', content: 'query', timestamp: new Date(),
    metadata: { source: 'desktop', clientRequestId: requestId }, ...overrides };
}

describe('Chat startup handoff', () => {
  afterEach(() => vi.useRealTimers());

  it('waits through connection and optimistic rendering until its accepted query is committed', () => {
    const { result, rerender } = renderHook(useChatStartupOverlay, { initialProps: base });
    const requestId = result.current.startupClientRequestId;
    rerender({ ...base, isConnected: true });
    expect(result.current.showStartupOverlay).toBe(true);
    act(() => result.current.onStartupItemsRendered([row(requestId, { deliveryStatus: 'sending' })]));
    expect(result.current.showStartupOverlay).toBe(true);
    // Backend adoption alone does not fire the committed-row callback.
    rerender({ ...base, isConnected: true });
    expect(result.current.showStartupOverlay).toBe(true);
    act(() => result.current.onStartupItemsRendered([row(requestId)]));
    expect(result.current.showStartupOverlay).toBe(false);
  });

  it('ignores copied fork history, other requests, assistant rows and failed local sends', () => {
    const { result } = renderHook(() => useChatStartupOverlay(base));
    const requestId = result.current.startupClientRequestId;
    act(() => result.current.onStartupItemsRendered([
      row('old-fork-request'), row('another-send'),
      row(requestId, { role: 'assistant' }), row(requestId, { deliveryStatus: 'failed' }),
    ]));
    expect(result.current.showStartupOverlay).toBe(true);
  });

  it('accepts an image-only query without waiting for text or an assistant response', () => {
    const { result } = renderHook(() => useChatStartupOverlay(base));
    act(() => result.current.onStartupItemsRendered([row(result.current.startupClientRequestId, {
      content: '', attachments: [{ id: 'img', name: 'query.png', size: 1, mimeType: 'image/png', isImage: true }],
    })]));
    expect(result.current.showStartupOverlay).toBe(false);
  });

  it('keeps empty/history entries covered until connection and restore are ready', () => {
    const { result, rerender } = renderHook(useChatStartupOverlay, {
      initialProps: { ...base, hasInitialMessage: false, isSessionLoading: true },
    });
    rerender({ ...base, hasInitialMessage: false, isConnected: true, isSessionLoading: true });
    expect(result.current.showStartupOverlay).toBe(true);
    rerender({ ...base, hasInitialMessage: false, isConnected: true, isSessionLoading: false });
    expect(result.current.showStartupOverlay).toBe(false);
  });

  it.each(['error', 'interaction'] as const)('reveals a pending %s without requiring a query row', reason => {
    const { result, rerender } = renderHook(useChatStartupOverlay, { initialProps: base });
    rerender({ ...base, agentError: reason === 'error' ? 'send failed' : null,
      hasPendingInteraction: reason === 'interaction' });
    expect(result.current.showStartupOverlay).toBe(false);
  });

  it('reveals startup failure before a first query or SSE connection exists', () => {
    const { result, rerender } = renderHook(useChatStartupOverlay, { initialProps: { ...base, startupError: null as string | null } });
    expect(result.current.showStartupOverlay).toBe(true);
    rerender({ ...base, startupError: 'Sidecar failed' });
    expect(result.current.showStartupOverlay).toBe(false);
  });

  it('can finish a cron handoff which creates no desktop query', () => {
    const { result } = renderHook(() => useChatStartupOverlay(base));
    act(() => result.current.dismissStartupOverlay());
    expect(result.current.showStartupOverlay).toBe(false);
  });

  it('preserves the safety timeout and cleans it up across StrictMode and unmount', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useChatStartupOverlay(base), { wrapper: StrictMode });
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(29_999));
    expect(result.current.showStartupOverlay).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.showStartupOverlay).toBe(false);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
