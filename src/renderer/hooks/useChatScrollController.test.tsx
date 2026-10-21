import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatScrollController } from './useChatScrollController';
import { projectVisibleChatTimelineRows } from '@/utils/chatTimelineRows';
import type { Message } from '@/types/chat';
import type { MainWindowPresentation } from '@/utils/mainWindowPresentation';

const AVAILABLE_PRESENTATION: MainWindowPresentation = { surfaceAvailable: true, generation: 0 };
const SUSPENDED_PRESENTATION: MainWindowPresentation = { surfaceAvailable: false, generation: 1 };
const RESTORED_PRESENTATION: MainWindowPresentation = { surfaceAvailable: true, generation: 1 };

const controls = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollBy: vi.fn(),
  scrollToBottom: vi.fn(),
  pauseAutoScroll: vi.fn(),
  handleAtBottomChange: vi.fn(),
  attachScroller: vi.fn(),
  virtuosoRef: { current: null as null | { scrollToIndex: ReturnType<typeof vi.fn>; scrollBy: ReturnType<typeof vi.fn> } },
  scrollerRef: { current: null as HTMLElement | null },
  followEnabledRef: { current: true as boolean | 'force' },
  onUserScrollIntent: undefined as (() => void) | undefined,
}));

vi.mock('@/hooks/useVirtuosoScroll', () => ({
  useVirtuosoScroll: (options?: { onUserScrollIntent?: () => void }) => {
    controls.onUserScrollIntent = options?.onUserScrollIntent;
    return {
    virtuosoRef: controls.virtuosoRef,
    scrollerRef: controls.scrollerRef,
    followEnabledRef: controls.followEnabledRef,
    scrollToBottom: controls.scrollToBottom,
    pauseAutoScroll: controls.pauseAutoScroll,
    handleAtBottomChange: controls.handleAtBottomChange,
    attachScroller: controls.attachScroller,
    };
  },
}));

// Cancellation uses a zero-distance command; these assertions concern position.
const corrections = () => controls.scrollBy.mock.calls.filter(([location]) => location.top !== 0);

function msg(id: string, content = 'text'): Message {
  return { id, role: 'assistant', content, timestamp: new Date('2026-07-02T00:00:00Z') };
}

function setRect(el: Element, rect: Partial<DOMRect>) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: rect.top ?? 0,
      top: rect.top ?? 0,
      bottom: rect.bottom ?? 0,
      left: 0,
      right: 300,
      width: 300,
      height: (rect.bottom ?? 0) - (rect.top ?? 0),
      toJSON: () => ({}),
    } as DOMRect),
  });
}

describe('useChatScrollController', () => {
  beforeEach(() => {
    controls.scrollToIndex.mockReset();
    controls.scrollBy.mockReset();
    controls.scrollToBottom.mockReset();
    controls.pauseAutoScroll.mockReset();
    controls.handleAtBottomChange.mockReset();
    controls.attachScroller.mockReset();
    controls.virtuosoRef.current = {
      scrollToIndex: controls.scrollToIndex,
      scrollBy: controls.scrollBy,
    };
    controls.scrollerRef.current = null;
    controls.followEnabledRef.current = true;
    controls.onUserScrollIntent = undefined;
  });

  it.each([true, false] as const)('revokes library motion on suspension without changing follow=%s', follow => {
    const { result } = renderHook(() => useChatScrollController({ messages: [msg('m1')], isActive: true, sessionId: 'one' }));
    controls.followEnabledRef.current = follow;
    act(() => result.current.onViewportAdmissionChanged(true, 0));
    act(() => result.current.onViewportAdmissionChanged(false, 0));
    expect(controls.scrollBy).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'auto' });
    expect(controls.followEnabledRef.current).toBe(follow);
    act(() => result.current.onViewportAdmissionChanged(false, 0));
    expect(controls.scrollBy).toHaveBeenCalledTimes(1);
  });

  it('retires the captured virtualizer on Session replacement and unmount', () => {
    const { rerender, unmount } = renderHook(({ sessionId }) => useChatScrollController({ messages: [], isActive: true, sessionId }), {
      initialProps: { sessionId: 'one' },
    });
    const replacementScrollBy = vi.fn();
    controls.virtuosoRef.current = { scrollToIndex: vi.fn(), scrollBy: replacementScrollBy };
    rerender({ sessionId: 'two' });
    expect(controls.scrollBy).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'auto' });
    expect(replacementScrollBy).not.toHaveBeenCalled();
    controls.virtuosoRef.current = null;
    unmount();
    expect(replacementScrollBy).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'auto' });
  });

  it('scrollToMessage pauses follow and delegates to Virtuoso inside the controller', () => {
    const messages = [msg('m1'), msg('m2'), msg('m3')];
    const { result } = renderHook(() => useChatScrollController({ messages, isActive: true }));

    act(() => {
      result.current.scrollToMessage('m2', { align: 'center', behavior: 'auto' });
    });

    expect(controls.pauseAutoScroll).toHaveBeenCalledWith();
    expect(controls.scrollToIndex).toHaveBeenCalledWith({
      index: 1,
      align: 'center',
      behavior: 'auto',
    });
  });

  it('invalidates a navigation refinement on newer viewport input and navigation', () => {
    const { result } = renderHook(() => useChatScrollController({ messages: [msg('m1')], isActive: true }));
    act(() => result.current.onViewportAdmissionChanged(true, 0));
    let isCurrent: (() => boolean) | undefined;
    act(() => { isCurrent = result.current.scrollToMessage('m1'); });
    expect(isCurrent?.()).toBe(true);
    act(() => controls.onUserScrollIntent?.());
    expect(isCurrent?.()).toBe(false);
    act(() => { isCurrent = result.current.scrollToMessage('m1'); });
    expect(isCurrent?.()).toBe(true);
    act(() => result.current.scrollToBottom());
    expect(isCurrent?.()).toBe(false);
  });

  it('does not run a queued tool refinement after newer user input', () => {
    const scroller = document.createElement('div');
    const tool = document.createElement('div');
    tool.dataset.toolId = 't1';
    tool.scrollIntoView = vi.fn();
    scroller.appendChild(tool);
    controls.scrollerRef.current = scroller;
    const { result } = renderHook(() => useChatScrollController({ messages: [msg('m1')], isActive: true }));
    act(() => result.current.onViewportAdmissionChanged(true, 0));
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frames.push(callback);
      return frames.length;
    });
    try {
      act(() => result.current.scrollToTool('t1', 'm1'));
      act(() => frames.shift()?.(0));
      act(() => controls.onUserScrollIntent?.());
      act(() => frames.shift()?.(0));
      expect(tool.scrollIntoView).not.toHaveBeenCalled();
    } finally { raf.mockRestore(); }
  });

  it('does not assign a navigation index to hidden task notification records', () => {
    const messages = projectVisibleChatTimelineRows([
      msg('m1'),
      {
        ...msg('task-notification-bg-1'),
        role: 'user',
        content: '<task-notification>{"taskId":"bg-1","status":"completed"}</task-notification>',
      },
      msg('m2'),
      msg('m3'),
    ]);
    const { result } = renderHook(() => useChatScrollController({ messages, isActive: true }));

    act(() => {
      result.current.scrollToMessage('m3', { align: 'center', behavior: 'auto' });
    });

    expect(messages.map(message => message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(controls.scrollToIndex).toHaveBeenCalledWith({
      index: 2,
      align: 'center',
      behavior: 'auto',
    });
  });

  it('retires index mounting before precise tool positioning', () => {
    const scroller = document.createElement('div');
    const tool = document.createElement('div');
    tool.dataset.toolId = 't1';
    tool.scrollIntoView = vi.fn(() => expect(controls.pauseAutoScroll).toHaveBeenCalledTimes(2));
    scroller.appendChild(tool);
    controls.scrollerRef.current = scroller;
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
    const { result } = renderHook(() => useChatScrollController({ messages: [msg('m1')], isActive: true }));
    act(() => result.current.onViewportAdmissionChanged(true, 0));
    act(() => result.current.scrollToTool('t1', 'm1'));
    expect(controls.scrollToIndex).toHaveBeenCalledTimes(1);
    act(() => { frames.shift()?.(0); frames.shift()?.(16); });
    expect(tool.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    raf.mockRestore();
  });

  it('scrollToTool resolves server_tool_use hosts inside the controller', () => {
    const messages: Message[] = [
      msg('m1'),
      {
        id: 'm2',
        role: 'assistant',
        timestamp: new Date('2026-07-02T00:00:00Z'),
        content: [
          {
            type: 'server_tool_use',
            tool: {
              id: 'server-tool-1',
              name: 'web_search',
              input: {},
              streamIndex: 0,
            },
          },
        ],
      },
    ];
    const { result } = renderHook(() => useChatScrollController({ messages, isActive: true }));

    act(() => {
      result.current.scrollToTool('server-tool-1');
    });

    expect(controls.pauseAutoScroll).toHaveBeenCalledWith();
    expect(controls.scrollToIndex).toHaveBeenCalledWith({
      index: 1,
      align: 'center',
      behavior: 'smooth',
    });
  });

  it('leaves following tool completion to measured list geometry', () => {
    controls.followEnabledRef.current = true;
    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
    }));

    act(() => {
      result.current.onViewportAdmissionChanged(true, 0);
      result.current.onRowLayoutChanged('m1', 'tool-complete');
    });

    expect(controls.scrollToBottom).not.toHaveBeenCalled();
    expect(corrections()).toHaveLength(0);
    expect(controls.scrollToIndex).not.toHaveBeenCalled();
  });

  it.each(['attachment-settle', 'widget-resize'] as const)(
    'leaves following %s growth to measured list geometry',
    (reason) => {
      controls.followEnabledRef.current = true;
      const { result } = renderHook(() => useChatScrollController({
        messages: [msg('m1')],
        isActive: true,
      }));

      act(() => {
        result.current.onViewportAdmissionChanged(true, 0);
        result.current.onRowLayoutChanged('m1', reason);
      });

      expect(controls.scrollToBottom).not.toHaveBeenCalled();
      expect(corrections()).toHaveLength(0);
      expect(controls.scrollToIndex).not.toHaveBeenCalled();
    },
  );

  it('does not bottom-pin late layout growth after follow is disabled', () => {
    controls.followEnabledRef.current = false;
    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
    }));

    act(() => {
      result.current.onViewportAdmissionChanged(true, 0);
      result.current.onRowLayoutChanged('m1', 'attachment-settle');
    });

    expect(controls.scrollToBottom).not.toHaveBeenCalled();
  });

  it.each([
    'process-row-expand',
    'process-row-collapse',
    'user-message-expand',
    'block-group-expand',
    'expandable-container-expand',
    'expandable-container-collapse',
  ] as const)('leaves %s in natural document flow instead of restoring a later message anchor', (reason) => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;

    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
    }));

    act(() => {
      result.current.onViewportAdmissionChanged(true, 0);
      result.current.onRowLayoutChanged('m1', reason);
      expect(controls.pauseAutoScroll).toHaveBeenCalled();
      // Emulate the same React commit growing or shrinking the virtualized row.
      setRect(row, { top: 80, bottom: 150 });
    });

    expect(corrections()).toHaveLength(0);
    expect(controls.scrollToIndex).not.toHaveBeenCalled();
    expect(controls.scrollToBottom).not.toHaveBeenCalled();
  });

  it('captures and restores an anchor with one offset correction', () => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;

    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
    }));

    act(() => result.current.onViewportAdmissionChanged(true, 0));
    const anchor = result.current.captureAnchor('test');
    expect(anchor).toMatchObject({ messageId: 'm1', offsetFromViewportTop: 20 });

    setRect(row, { top: 80, bottom: 150 });
    act(() => {
      result.current.restoreAnchorAfterNextCommit(anchor!);
    });

    expect(controls.scrollBy).toHaveBeenCalledWith({ top: 50, behavior: 'auto' });
  });

  it.each([true, 'force'] as const)(
    'restores %s follow intent once after a suspended viewport becomes renderable',
    (followMode) => {
      controls.followEnabledRef.current = followMode;
      const initial = [msg('m1')];
      const { result, rerender } = renderHook(
        ({ messages, presentation }: {
          messages: Message[];
          presentation: MainWindowPresentation;
        }) => useChatScrollController({
          messages,
          isActive: true,
          windowPresentation: presentation,
          sessionId: 's1',
        }),
        { initialProps: { messages: initial, presentation: AVAILABLE_PRESENTATION } },
      );

      act(() => result.current.onViewportAdmissionChanged(true, 0));
      rerender({ messages: initial, presentation: SUSPENDED_PRESENTATION });
      act(() => result.current.onViewportAdmissionChanged(false, 1));
      rerender({
        messages: [...initial, msg('m2', 'finished while minimized')],
        presentation: SUSPENDED_PRESENTATION,
      });
      controls.scrollToBottom.mockClear();

      rerender({
        messages: [...initial, msg('m2', 'finished while minimized')],
        presentation: RESTORED_PRESENTATION,
      });
      act(() => result.current.onViewportAdmissionChanged(true, 1));

      expect(controls.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(controls.scrollToBottom).toHaveBeenCalledWith('auto');
      expect(corrections()).toHaveLength(0);
      expect(result.current.isViewportRecoveryFenced).toBe(false);
    },
  );

  it('restores the same message anchor when a scrolled-up reader returns from suspension', () => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;
    controls.followEnabledRef.current = false;

    const initial = [msg('m1')];
    const { result, rerender } = renderHook(
      ({ messages, presentation }: {
        messages: Message[];
        presentation: MainWindowPresentation;
      }) => useChatScrollController({
        messages,
        isActive: true,
        windowPresentation: presentation,
        sessionId: 's1',
      }),
      { initialProps: { messages: initial, presentation: AVAILABLE_PRESENTATION } },
    );

    act(() => result.current.onViewportAdmissionChanged(true, 0));
    rerender({ messages: initial, presentation: SUSPENDED_PRESENTATION });
    act(() => result.current.onViewportAdmissionChanged(false, 1));
    setRect(row, { top: 80, bottom: 150 });
    rerender({
      messages: [...initial, msg('m2', 'new output below')],
      presentation: SUSPENDED_PRESENTATION,
    });

    rerender({
      messages: [...initial, msg('m2', 'new output below')],
      presentation: RESTORED_PRESENTATION,
    });
    act(() => result.current.onViewportAdmissionChanged(true, 1));

    expect(controls.scrollToBottom).not.toHaveBeenCalled();
    expect(corrections()).toHaveLength(1);
    expect(controls.scrollBy).toHaveBeenCalledWith({ top: 50, behavior: 'auto' });
    expect(controls.followEnabledRef.current).toBe(false);
    expect(result.current.isViewportRecoveryFenced).toBe(false);
  });

  it('preserves a negative intra-message offset for one long assistant row', () => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'long');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: -300, bottom: 900 });
    controls.scrollerRef.current = scroller;
    controls.followEnabledRef.current = false;
    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('long')],
      isActive: true,
      sessionId: 's1',
    }));

    act(() => result.current.onViewportAdmissionChanged(true, 0));
    act(() => result.current.onViewportAdmissionChanged(false, 0));
    setRect(row, { top: -250, bottom: 950 });
    act(() => result.current.onViewportAdmissionChanged(true, 0));

    expect(controls.scrollBy).toHaveBeenCalledWith({ top: 50, behavior: 'auto' });
    expect(result.current.isViewportRecoveryFenced).toBe(false);
  });

  it.each([0, 2])('compensates reading layout only after generation %s is admitted', (generation) => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;
    controls.followEnabledRef.current = false;
    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
      windowPresentation: { surfaceAvailable: true, generation },
      sessionId: 's1',
    }));
    act(() => {
      result.current.onViewportAdmissionChanged(true, generation - 1);
      result.current.onRowLayoutChanged('m1', 'attachment-settle');
    });
    expect(corrections()).toHaveLength(0);
    act(() => {
      result.current.onViewportAdmissionChanged(true, generation);
      result.current.onRowLayoutChanged('m1', 'attachment-settle');
      setRect(row, { top: 80, bottom: 150 });
    });
    expect(controls.scrollBy).toHaveBeenCalledWith({ top: 50, behavior: 'auto' });
    expect(controls.scrollToBottom).not.toHaveBeenCalled();
  });

  it('fences stale geometry callbacks as soon as the presentation generation advances', () => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;
    controls.followEnabledRef.current = false;

    const { result, rerender } = renderHook(
      ({ presentation }: { presentation: MainWindowPresentation }) => useChatScrollController({
        messages: [msg('m1')],
        isActive: true,
        windowPresentation: presentation,
        sessionId: 's1',
      }),
      { initialProps: { presentation: AVAILABLE_PRESENTATION } },
    );

    act(() => {
      result.current.attachScroller(scroller);
      result.current.onViewportAdmissionChanged(true, 0);
      result.current.onViewportAdmissionChanged(false, 0);
    });
    row.remove();
    act(() => result.current.onViewportAdmissionChanged(true, 0));
    expect(result.current.isViewportRecoveryFenced).toBe(true);
    expect(controls.scrollToIndex).toHaveBeenCalledTimes(1);

    // App has committed generation 1, but the MessageList layout effect has
    // not published false admission yet. Every old-generation geometry path
    // must already fail closed in this parent/child effect gap.
    rerender({ presentation: SUSPENDED_PRESENTATION });
    setRect(row, { top: 130, bottom: 200 });
    scroller.appendChild(row);
    controls.scrollBy.mockClear();
    controls.scrollToBottom.mockClear();
    controls.handleAtBottomChange.mockClear();
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
      result.current.handleAtBottomChange(false);
      result.current.onRowLayoutChanged('m1', 'tool-complete');
      result.current.onItemsRendered();
    });

    expect(corrections()).toHaveLength(0);
    expect(controls.scrollToBottom).not.toHaveBeenCalled();
    expect(controls.handleAtBottomChange).not.toHaveBeenCalled();
    expect(result.current.isViewportRecoveryFenced).toBe(true);

    act(() => result.current.onViewportAdmissionChanged(false, 1));
    setRect(row, { top: 80, bottom: 150 });
    rerender({ presentation: RESTORED_PRESENTATION });
    act(() => result.current.onViewportAdmissionChanged(true, 1));

    expect(corrections()).toHaveLength(1);
    expect(controls.scrollBy).toHaveBeenCalledWith({ top: 50, behavior: 'auto' });
    expect(result.current.isViewportRecoveryFenced).toBe(false);
  });

  it('invalidates a suspended continuity transaction when the Session changes', () => {
    controls.followEnabledRef.current = true;
    const { result, rerender } = renderHook(
      ({ sessionId }) => useChatScrollController({
        messages: [msg('m1')],
        isActive: true,
        sessionId,
      }),
      { initialProps: { sessionId: 's1' } },
    );

    act(() => result.current.onViewportAdmissionChanged(true, 0));
    act(() => result.current.onViewportAdmissionChanged(false, 0));
    controls.scrollToBottom.mockClear();
    rerender({ sessionId: 's2' });
    act(() => result.current.onViewportAdmissionChanged(true, 0));

    expect(controls.scrollToBottom).not.toHaveBeenCalled();
    expect(corrections()).toHaveLength(0);
    expect(controls.scrollToIndex).not.toHaveBeenCalled();
    expect(result.current.isViewportRecoveryFenced).toBe(false);
  });

  it('drops a pending recovery callback when the Tab becomes inactive', () => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;
    controls.followEnabledRef.current = false;
    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
      sessionId: 's1',
    }));

    act(() => result.current.onViewportAdmissionChanged(true, 0));
    act(() => result.current.onViewportAdmissionChanged(false, 0));
    row.remove();
    act(() => result.current.onViewportAdmissionChanged(true, 0));
    expect(result.current.isViewportRecoveryFenced).toBe(true);

    act(() => result.current.onViewportAdmissionChanged(false, 0));
    setRect(row, { top: 80, bottom: 150 });
    scroller.appendChild(row);
    act(() => result.current.onItemsRendered());
    expect(corrections()).toHaveLength(0);
  });

  it('coalesces inactive-Tab and native-surface suspension into one recovery', () => {
    controls.followEnabledRef.current = true;
    const { result, rerender } = renderHook(
      ({ presentation }: { presentation: MainWindowPresentation }) => useChatScrollController({
        messages: [msg('m1')],
        isActive: true,
        windowPresentation: presentation,
        sessionId: 's1',
      }),
      { initialProps: { presentation: AVAILABLE_PRESENTATION } },
    );

    act(() => result.current.onViewportAdmissionChanged(true, 0));
    act(() => result.current.onViewportAdmissionChanged(false, 0));
    rerender({ presentation: SUSPENDED_PRESENTATION });
    act(() => result.current.onViewportAdmissionChanged(false, 1));
    rerender({ presentation: RESTORED_PRESENTATION });
    act(() => result.current.onViewportAdmissionChanged(false, 1));
    controls.scrollToBottom.mockClear();
    act(() => result.current.onViewportAdmissionChanged(true, 1));

    expect(controls.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('keeps the first suspended intent authoritative across duplicate unavailable signals', () => {
    controls.followEnabledRef.current = true;
    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
      sessionId: 's1',
    }));

    act(() => result.current.onViewportAdmissionChanged(true, 0));
    act(() => result.current.onViewportAdmissionChanged(false, 0));
    controls.followEnabledRef.current = false;
    act(() => result.current.onViewportAdmissionChanged(false, 0));
    controls.scrollToBottom.mockClear();
    act(() => result.current.onViewportAdmissionChanged(true, 0));

    expect(controls.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(controls.followEnabledRef.current).toBe(true);
  });

  it.each([0, 50])('settles an unmounted continuity anchor with offset %s and retires its index stage', delta => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;
    controls.followEnabledRef.current = false;

    const { result } = renderHook(() => useChatScrollController({
        messages: [msg('m1')],
        isActive: true,
        sessionId: 's1',
      }));

    act(() => result.current.onViewportAdmissionChanged(true, 0));
    act(() => result.current.onViewportAdmissionChanged(false, 0));
    row.remove();
    act(() => result.current.onViewportAdmissionChanged(true, 0));

    expect(controls.scrollToIndex).toHaveBeenCalledWith({
      index: 0,
      align: 'start',
      behavior: 'auto',
    });
    expect(result.current.isViewportRecoveryFenced).toBe(true);

    controls.scrollBy.mockClear();
    setRect(row, { top: 30 + delta, bottom: 100 + delta });
    scroller.appendChild(row);
    act(() => result.current.onItemsRendered());

    expect(controls.scrollBy).toHaveBeenCalledExactlyOnceWith({ top: delta, behavior: 'auto' });
    expect(result.current.isViewportRecoveryFenced).toBe(false);
  });

  it('lets explicit navigation cancel an in-flight continuity recovery', () => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;
    controls.followEnabledRef.current = false;

    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
      sessionId: 's1',
    }));

    act(() => result.current.onViewportAdmissionChanged(true, 0));
    act(() => result.current.onViewportAdmissionChanged(false, 0));
    row.remove();
    act(() => result.current.onViewportAdmissionChanged(true, 0));
    expect(result.current.isViewportRecoveryFenced).toBe(true);

    controls.scrollToIndex.mockClear();
    act(() => result.current.scrollToMessage('m1', { behavior: 'auto' }));
    expect(result.current.isViewportRecoveryFenced).toBe(false);
    expect(controls.scrollToIndex).toHaveBeenCalledTimes(1);

    setRect(row, { top: 80, bottom: 150 });
    scroller.appendChild(row);
    act(() => result.current.onItemsRendered());
    expect(corrections()).toHaveLength(0);
  });

  it('lets explicit bottom navigation cancel an in-flight continuity recovery', () => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;
    controls.followEnabledRef.current = false;
    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
      sessionId: 's1',
    }));

    act(() => result.current.onViewportAdmissionChanged(true, 0));
    act(() => result.current.onViewportAdmissionChanged(false, 0));
    row.remove();
    act(() => result.current.onViewportAdmissionChanged(true, 0));
    expect(result.current.isViewportRecoveryFenced).toBe(true);

    controls.scrollToIndex.mockClear();
    act(() => result.current.scrollToBottom('auto'));
    expect(result.current.isViewportRecoveryFenced).toBe(false);
    expect(controls.scrollToBottom).toHaveBeenCalledWith('auto');

    setRect(row, { top: 80, bottom: 150 });
    scroller.appendChild(row);
    act(() => result.current.onItemsRendered());
    expect(corrections()).toHaveLength(0);
  });

  it('lets newer direct viewport input cancel an in-flight continuity recovery', () => {
    const scroller = document.createElement('div');
    const row = document.createElement('div');
    row.setAttribute('data-chat-search-scope', '');
    row.setAttribute('data-message-id', 'm1');
    scroller.appendChild(row);
    setRect(scroller, { top: 10, bottom: 410 });
    setRect(row, { top: 30, bottom: 100 });
    controls.scrollerRef.current = scroller;
    controls.followEnabledRef.current = false;
    const { result } = renderHook(() => useChatScrollController({
      messages: [msg('m1')],
      isActive: true,
      sessionId: 's1',
    }));

    act(() => result.current.onViewportAdmissionChanged(true, 0));
    act(() => result.current.onViewportAdmissionChanged(false, 0));
    row.remove();
    act(() => result.current.onViewportAdmissionChanged(true, 0));
    expect(result.current.isViewportRecoveryFenced).toBe(true);

    act(() => controls.onUserScrollIntent?.());
    expect(result.current.isViewportRecoveryFenced).toBe(false);

    setRect(row, { top: 80, bottom: 150 });
    scroller.appendChild(row);
    act(() => result.current.onItemsRendered());
    expect(corrections()).toHaveLength(0);
  });
});
