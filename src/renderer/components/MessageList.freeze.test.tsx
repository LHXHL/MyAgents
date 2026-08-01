// Regression test for the "phantom repeated rows + blank viewport" Virtuoso
// corruption (2026-05-25, /cross-bugfix).
//
// Root cause: while a tab is inactive the host wraps the list in
// `content-visibility:hidden`; WebKit skips its layout, so any data/height churn
// Virtuoso processes in that state poisons its offset/range cache. The streaming
// reveal loop kept growing the last row while hidden. The fix freezes the
// `data`/`firstItemIndex` handed to Virtuoso while `!isActive`, so no measurement
// churn reaches it; on re-activation we swap back to the live array.
//
// This test pins that invariant at the Virtuoso boundary: it captures the `data`
// / `firstItemIndex` props Virtuoso receives and asserts they stay frozen while
// inactive and resume live on re-activation.
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { VirtuosoHandle } from 'react-virtuoso';

import type { Message as MessageType } from '@/types/chat';

// ── Capture the props handed to Virtuoso on every render ──
type Recorded = {
  data: MessageType[];
  firstItemIndex: number | undefined;
  heightEstimates: number[] | undefined;
  components?: unknown;
  atBottomStateChange?: (atBottom: boolean) => void;
  followOutput?: (isAtBottom: boolean) => false | 'smooth';
  startReached?: () => void;
};
const recorded: Recorded[] = [];
vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: {
    data: MessageType[];
    firstItemIndex?: number;
    heightEstimates?: number[];
    components?: unknown;
    atBottomStateChange?: (atBottom: boolean) => void;
    followOutput?: (isAtBottom: boolean) => false | 'smooth';
    startReached?: () => void;
  }) => {
    recorded.push({
      data: props.data,
      firstItemIndex: props.firstItemIndex,
      heightEstimates: props.heightEstimates,
      components: props.components,
      atBottomStateChange: props.atBottomStateChange,
      followOutput: props.followOutput,
      startReached: props.startReached,
    });
    return <div data-testid="virtuoso" data-count={props.data.length} />;
  },
}));

// Heavy children — stub so jsdom doesn't pull Markdown / tool / prompt trees.
vi.mock('@/components/Message', () => ({ default: () => <div data-testid="msg" /> }));
vi.mock('@/components/PermissionPrompt', () => ({ PermissionPrompt: () => null }));
vi.mock('@/components/AskUserQuestionPrompt', () => ({ AskUserQuestionPrompt: () => null }));
vi.mock('@/components/ExitPlanModePrompt', () => ({ ExitPlanModePrompt: () => null }));

import MessageList from './MessageList';

function msg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): MessageType {
  return { id, role, content, timestamp: new Date() } as MessageType;
}

function createFollowProps(initial: boolean | 'force' = true) {
  const followEnabledRef: React.MutableRefObject<boolean | 'force'> = { current: initial };
  return {
    followEnabledRef,
  };
}

function renderList(overrides: Partial<React.ComponentProps<typeof MessageList>>) {
  const props: React.ComponentProps<typeof MessageList> = {
    messages: [],
    streamingMessage: null,
    isLoading: false,
    sessionId: 's1',
    isActive: true,
    isWindowFocused: true,
    firstItemIndex: 1_000_000,
    virtuosoRef: { current: null },
    ...createFollowProps(),
    scrollToBottom: vi.fn(),
    handleAtBottomChange: vi.fn(),
    ...overrides,
  };
  return render(<MessageList {...props} />);
}

const lastData = () => recorded[recorded.length - 1];
const streamingText = (r: Recorded) => {
  const last = r.data[r.data.length - 1];
  return typeof last?.content === 'string' ? last.content : '';
};

describe('MessageList — freeze data while inactive (Virtuoso cache-poisoning regression)', () => {
  beforeEach(() => {
    recorded.length = 0;
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(1_000);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reveals restored history without resetting the visible list opacity on the next frame', () => {
    const { rerender } = renderList({
      messages: [],
    });

    rerender(
      <MessageList
        messages={[msg('restored', 'already restored')]}
        streamingMessage={null}
        isLoading={false}
        isActive
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId('virtuoso').parentElement).not.toHaveStyle({
      animation: 'message-list-fade-in 600ms ease-out both',
    });
  });

  it('does not mount a second restore spinner beneath the boot overlay', () => {
    const { container } = renderList({
      messages: [],
    });

    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
  });

  it('does NOT forward streaming growth to Virtuoso while inactive, and resumes live on re-activation', () => {
    const history = [msg('h1', 'hello', 'user'), msg('h2', 'hi there')];

    // 1. Active, streaming "a".
    const { rerender } = renderList({
      messages: [...history, msg('stream', 'a')],
      streamingMessage: msg('stream', 'a'),
      isLoading: true,
      isActive: true,
    });
    expect(streamingText(lastData())).toBe('a');

    // 2. Go inactive (content-visibility:hidden). The reveal loop keeps growing the
    //    streaming row — emulate by re-rendering with a longer streaming message.
    rerender(
      <MessageList
        messages={[...history, msg('stream', 'abc')]}
        streamingMessage={msg('stream', 'abc')}
        isLoading isActive={false}
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    // FROZEN: Virtuoso must still see the pre-hidden snapshot ("a"), not "abc".
    expect(streamingText(lastData())).toBe('a');

    // 3. More growth while still hidden → still frozen.
    rerender(
      <MessageList
        messages={[...history, msg('stream', 'abcdef')]}
        streamingMessage={msg('stream', 'abcdef')}
        isLoading isActive={false}
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    expect(streamingText(lastData())).toBe('a');

    // 4. Re-activate → Virtuoso swaps to the live (grown) array.
    rerender(
      <MessageList
        messages={[...history, msg('stream', 'abcdefghi')]}
        streamingMessage={msg('stream', 'abcdefghi')}
        isLoading isActive
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    expect(streamingText(lastData())).toBe('abcdefghi');
  });

  it('freezes all Virtuoso inputs and geometry callbacks while the active Tab window is unfocused', () => {
    const history = [msg('h1', 'hello', 'user'), msg('h2', 'hi there')];
    const handleAtBottomChange = vi.fn();
    const onLoadOlder = vi.fn();
    const scrollToBottom = vi.fn();
    const followProps = createFollowProps();
    const { rerender } = renderList({
      messages: [...history, msg('stream', 'a')],
      streamingMessage: msg('stream', 'a'),
      isLoading: true,
      isActive: true,
      isWindowFocused: true,
      firstItemIndex: 1_000_000,
      heightEstimateSeed: [120, 240, 360],
      onLoadOlder,
      handleAtBottomChange,
      scrollToBottom,
      ...followProps,
    });
    const focusedComponents = lastData().components;
    scrollToBottom.mockClear();

    rerender(
      <MessageList
        messages={[...history, msg('assistant-final', 'final hidden result')]}
        streamingMessage={null}
        isLoading={false}
        isActive
        isWindowFocused={false}
        firstItemIndex={999_995}
        heightEstimateSeed={[150, 270, 900]}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...followProps}
        scrollToBottom={scrollToBottom}
        handleAtBottomChange={handleAtBottomChange}
        onLoadOlder={onLoadOlder}
      />,
    );

    const unfocused = lastData();
    expect(streamingText(unfocused)).toBe('a');
    expect(unfocused.firstItemIndex).toBe(1_000_000);
    expect(unfocused.heightEstimates).toEqual([120, 240, 360]);
    expect(unfocused.components).toBe(focusedComponents);

    unfocused.atBottomStateChange?.(false);
    expect(handleAtBottomChange).not.toHaveBeenCalled();
    expect(unfocused.followOutput?.(true)).toBe(false);
    unfocused.startReached?.();
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(scrollToBottom).not.toHaveBeenCalled();

    rerender(
      <MessageList
        messages={[...history, msg('assistant-final', 'final hidden result')]}
        streamingMessage={null}
        isLoading={false}
        isActive
        isWindowFocused
        firstItemIndex={999_995}
        heightEstimateSeed={[150, 270, 900]}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...followProps}
        scrollToBottom={scrollToBottom}
        handleAtBottomChange={handleAtBottomChange}
        onLoadOlder={onLoadOlder}
      />,
    );

    expect(lastData().data.at(-1)?.id).toBe('assistant-final');
    expect(lastData().firstItemIndex).toBe(999_995);
    expect(lastData().heightEstimates).toEqual([150, 270, 900]);
    expect(lastData().components).not.toBe(focusedComponents);
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('does NOT carry a stale "scrolled-up" follow snapshot across a session switch made while hidden', () => {
    // Repro: user scrolls up in session s1, switches tab away (snapshot=false@s1),
    // the tab's session is switched to s2 while hidden, then user returns. The old
    // s1 "don't follow" intent must NOT disable follow for the fresh s2 — otherwise
    // s2 loads at bottom but never auto-scrolls new streaming.
    const followRef: React.MutableRefObject<boolean | 'force'> = { current: true };
    const followProps = () => ({
      followEnabledRef: followRef,
    });
    // Realistic scrollToBottom: mirrors the hook by flipping the ref to 'force'.
    const scrollToBottom = vi.fn(() => {
      followRef.current = 'force';
    });

    const s1 = [msg('a1', 'x', 'user'), msg('a2', 'y')];
    const { rerender } = renderList({
      sessionId: 's1', messages: s1, isActive: true,
      ...followProps(), scrollToBottom,
    });

    // User scrolls up in s1 → follow disabled.
    followRef.current = false;

    // Switch tab away → inactive snapshot captures (false @ s1).
    rerender(
      <MessageList
        sessionId="s1" messages={s1} streamingMessage={null}
        isLoading={false} isActive={false} firstItemIndex={1_000_000}
        virtuosoRef={{ current: null }} {...followProps()}
        scrollToBottom={scrollToBottom} handleAtBottomChange={vi.fn()}
      />,
    );

    // Session switched to s2 while still hidden, then user returns (isActive=true).
    const s2 = [msg('b1', 'p', 'user'), msg('b2', 'q')];
    rerender(
      <MessageList
        sessionId="s2" messages={s2} streamingMessage={null}
        isLoading={false} isActive firstItemIndex={1_000_000}
        virtuosoRef={{ current: null }} {...followProps()}
        scrollToBottom={scrollToBottom} handleAtBottomChange={vi.fn()}
      />,
    );

    // The stale s1 "false" must have been dropped: s2 ends up following, not disabled.
    expect(followRef.current).not.toBe(false);
  });

  it('defers internal Tab recovery until the desktop window is focused', () => {
    const followRef: React.MutableRefObject<boolean | 'force'> = { current: true };
    const scrollToBottom = vi.fn();
    const history = [msg('h1', 'x', 'user'), msg('h2', 'y')];
    const baseProps = {
      messages: history,
      streamingMessage: null,
      isLoading: false,
      firstItemIndex: 1_000_000,
      sessionId: 's1',
      virtuosoRef: { current: null },
      followEnabledRef: followRef,
      scrollToBottom,
      handleAtBottomChange: vi.fn(),
    };
    const { rerender } = renderList({ ...baseProps, isActive: true, isWindowFocused: true });
    scrollToBottom.mockClear();

    rerender(<MessageList {...baseProps} isActive={false} isWindowFocused={false} />);
    rerender(<MessageList {...baseProps} isActive isWindowFocused={false} />);
    expect(scrollToBottom).not.toHaveBeenCalled();

    rerender(<MessageList {...baseProps} isActive isWindowFocused />);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(scrollToBottom).toHaveBeenCalledWith('auto');
  });

  it('freezes firstItemIndex while inactive (no prepend anchor drift mid-hide)', () => {
    const history = [msg('h1', 'a', 'user'), msg('h2', 'b')];
    const { rerender } = renderList({
      messages: history,
      isActive: true,
      firstItemIndex: 1_000_000,
    });
    expect(lastData().firstItemIndex).toBe(1_000_000);

    // Inactive: even if a stray prepend decrements firstItemIndex, Virtuoso keeps the snapshot.
    rerender(
      <MessageList
        messages={history}
        streamingMessage={null}
        isLoading={false} isActive={false}
        firstItemIndex={999_995}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    expect(lastData().firstItemIndex).toBe(1_000_000);
  });

  it('freezes heightEstimateSeed while inactive', () => {
    const history = [msg('h1', 'a', 'user'), msg('h2', 'b')];
    const { rerender } = renderList({
      messages: history,
      isActive: true,
      heightEstimateSeed: [120, 480],
    });
    expect(lastData().heightEstimates).toEqual([120, 480]);

    rerender(
      <MessageList
        messages={[...history, msg('stream', 'hidden growth')]}
        streamingMessage={msg('stream', 'hidden growth')}
        isLoading isActive={false}
        firstItemIndex={1_000_000}
        heightEstimateSeed={[120, 480, 900]}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        {...createFollowProps()}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );

    expect(lastData().heightEstimates).toEqual([120, 480]);
  });

  it('keeps active streaming pinned before paint through Virtuoso LAST/end alignment while following', () => {
    const scrollToIndex = vi.fn();
    const autoscrollToBottom = vi.fn();
    renderList({
      messages: [msg('h1', 'hello', 'user'), msg('stream', 'partial')],
      streamingMessage: msg('stream', 'partial'),
      isLoading: true,
      isActive: true,
      ...createFollowProps(),
      virtuosoRef: {
        current: { scrollToIndex, autoscrollToBottom },
      } as unknown as React.RefObject<VirtuosoHandle | null>,
    });

    expect(scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end', behavior: 'auto' });
    expect(autoscrollToBottom).not.toHaveBeenCalled();
  });

  it('pins to bottom once when a turn completes while follow is enabled', () => {
    const followRef: React.MutableRefObject<boolean | 'force'> = { current: true };
    const scrollToBottom = vi.fn();
    const history = [msg('h1', 'hello', 'user')];
    const baseProps = {
      firstItemIndex: 1_000_000,
      sessionId: 's1',
      virtuosoRef: { current: null },
      followEnabledRef: followRef,
      scrollToBottom,
      handleAtBottomChange: vi.fn(),
    };
    const { rerender } = renderList({
      ...baseProps,
      messages: [...history, msg('stream', 'partial')],
      streamingMessage: msg('stream', 'partial'),
      isLoading: true,
      isActive: true,
    });
    scrollToBottom.mockClear();

    rerender(
      <MessageList
        {...baseProps}
        messages={[...history, msg('assistant-1', 'final')]}
        streamingMessage={null}
        isLoading={false}
        isActive
      />,
    );

    expect(scrollToBottom).toHaveBeenCalledWith('auto');
  });
});
