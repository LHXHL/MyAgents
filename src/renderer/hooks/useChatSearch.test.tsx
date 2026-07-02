import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatSearch } from './useChatSearch';
import type { Message } from '@/types/chat';

class TestHighlight {
  private ranges: Range[];

  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }

  clear(): void {
    this.ranges = [];
  }

  add(range: Range): void {
    this.ranges.push(range);
  }

  get size(): number {
    return this.ranges.length;
  }
}

describe('useChatSearch', () => {
  const originalCss = globalThis.CSS;
  const originalHighlight = (globalThis as unknown as { Highlight?: unknown }).Highlight;
  const originalRangeGetBoundingClientRect = Range.prototype.getBoundingClientRect;
  const rect = {
    x: 0,
    y: 40,
    top: 40,
    right: 100,
    bottom: 60,
    left: 0,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  } as DOMRect;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: vi.fn(() => rect),
    });
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: {
        escape: (value: string) => value.replace(/"/g, '\\"'),
        highlights: {
          set: vi.fn(),
          delete: vi.fn(),
        },
      },
    });
    Object.defineProperty(globalThis, 'Highlight', {
      configurable: true,
      value: TestHighlight,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalRangeGetBoundingClientRect) {
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: originalRangeGetBoundingClientRect,
      });
    } else {
      Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    }
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: originalCss,
    });
    Object.defineProperty(globalThis, 'Highlight', {
      configurable: true,
      value: originalHighlight,
    });
  });

  it('routes virtualized matches through the chat scroll controller', () => {
    const scrollToMessage = vi.fn();
    const scroller = document.createElement('div');
    const messages: Message[] = [
      { id: 'm1', role: 'user', content: 'first needle', timestamp: new Date(0) },
      { id: 'm2', role: 'assistant', content: 'second needle', timestamp: new Date(1) },
    ];

    const { result } = renderHook(() => useChatSearch({
      active: true,
      messages,
      scrollerRef: { current: scroller },
      scrollToMessage,
    }));

    act(() => {
      result.current.setQuery('needle');
    });
    act(() => {
      vi.advanceTimersByTime(151);
    });

    expect(result.current.matchCount).toBe(2);

    act(() => {
      result.current.next();
    });

    expect(scrollToMessage).toHaveBeenCalledWith('m2', {
      behavior: 'auto',
      align: 'center',
      pauseMs: 2000,
    });
  });

  it('keeps retrying until a virtualized target message mounts', () => {
    const scrollToMessage = vi.fn();
    const scrollBy = vi.fn();
    const scroller = document.createElement('div');
    Object.defineProperty(scroller, 'scrollBy', {
      configurable: true,
      value: scrollBy,
    });
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        ...rect,
        top: 0,
        bottom: 200,
        height: 200,
      }),
    });
    const messages: Message[] = [
      { id: 'm1', role: 'user', content: 'first needle', timestamp: new Date(0) },
      { id: 'm2', role: 'assistant', content: 'second needle', timestamp: new Date(1) },
    ];

    const { result } = renderHook(() => useChatSearch({
      active: true,
      messages,
      scrollerRef: { current: scroller },
      scrollToMessage,
    }));

    act(() => {
      result.current.setQuery('needle');
    });
    act(() => {
      vi.advanceTimersByTime(151);
    });
    act(() => {
      result.current.next();
    });

    // Old behavior gave up after two rAFs. Keep the target unmounted long
    // enough to cross that boundary, then mount it inside the bounded retry
    // window.
    act(() => {
      vi.advanceTimersByTime(80);
    });
    const scope = document.createElement('div');
    scope.setAttribute('data-chat-search-scope', '');
    scope.setAttribute('data-message-id', 'm2');
    scope.textContent = 'second needle';
    scroller.appendChild(scope);
    act(() => {
      vi.advanceTimersByTime(80);
    });

    expect(scrollToMessage).toHaveBeenCalledWith('m2', {
      behavior: 'auto',
      align: 'center',
      pauseMs: 2000,
    });
    expect(scrollBy).toHaveBeenCalled();
    expect(scope.classList.contains('chat-search-msg-pulse')).toBe(true);
  });
});
