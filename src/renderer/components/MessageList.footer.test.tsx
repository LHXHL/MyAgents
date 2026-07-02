import { act, render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';
import type { FollowState } from '@/hooks/useVirtuosoScroll';

type VirtuosoMockProps = {
  components?: {
    Footer?: React.ComponentType<{ context?: unknown }>;
  };
  atBottomStateChange?: (atBottom: boolean) => void;
};

let lastVirtuosoProps: VirtuosoMockProps | null = null;

vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: VirtuosoMockProps) => {
    lastVirtuosoProps = props;
    const Footer = props.components?.Footer;
    return (
      <div data-testid="virtuoso">
        {Footer ? <Footer context={undefined} /> : null}
      </div>
    );
  },
}));

vi.mock('@/components/Message', () => ({ default: () => <div data-testid="msg" /> }));
vi.mock('@/components/PermissionPrompt', () => ({ PermissionPrompt: () => null }));
vi.mock('@/components/AskUserQuestionPrompt', () => ({ AskUserQuestionPrompt: () => null }));
vi.mock('@/components/ExitPlanModePrompt', () => ({ ExitPlanModePrompt: () => null }));

import MessageList from './MessageList';

function msg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): MessageType {
  return { id, role, content, timestamp: new Date() } as MessageType;
}

function createBaseProps(overrides: Partial<React.ComponentProps<typeof MessageList>> = {}) {
  const followEnabledRef: React.MutableRefObject<FollowState> = { current: true };
  const setFollowState = vi.fn((next: FollowState) => {
    followEnabledRef.current = next;
  });
  return {
    historyMessages: [msg('h1', 'hello', 'user')],
    streamingMessage: null,
    isLoading: false,
    sessionId: 's1',
    isActive: true,
    firstItemIndex: 1_000_000,
    virtuosoRef: { current: null },
    followEnabledRef,
    followState: followEnabledRef.current,
    setFollowState,
    scrollToBottom: vi.fn(),
    handleAtBottomChange: vi.fn(),
    ...overrides,
  };
}

function renderList(overrides: Partial<React.ComponentProps<typeof MessageList>> = {}) {
  const props: React.ComponentProps<typeof MessageList> = createBaseProps(overrides);
  return render(<MessageList {...props} />);
}

function renderStatefulList({
  initialFollowState = true,
  handleAtBottomChange,
  ...overrides
}: Partial<React.ComponentProps<typeof MessageList>> & {
  initialFollowState?: FollowState;
  handleAtBottomChange?: (
    atBottom: boolean,
    followRef: React.MutableRefObject<FollowState>,
    setFollowState: (next: FollowState) => void,
  ) => void;
} = {}) {
  const handleSpy = vi.fn();
  const baseProps = createBaseProps(overrides);
  function Wrapper() {
    const [followState, setFollowStateValue] = React.useState<FollowState>(initialFollowState);
    const followRef = React.useRef<FollowState>(initialFollowState);
    const setFollowState = React.useCallback((next: FollowState) => {
      followRef.current = next;
      setFollowStateValue(next);
    }, []);
    const onAtBottomChange = React.useCallback((atBottom: boolean) => {
      handleSpy(atBottom);
      if (handleAtBottomChange) {
        handleAtBottomChange(atBottom, followRef, setFollowState);
        return;
      }
      if (atBottom) {
        setFollowState(true);
      } else if (followRef.current === true) {
        setFollowState(false);
      }
    }, [setFollowState]);

    return (
      <MessageList
        {...baseProps}
        followEnabledRef={followRef}
        followState={followState}
        setFollowState={setFollowState}
        handleAtBottomChange={onAtBottomChange}
      />
    );
  }

  return { handleSpy, ...render(<Wrapper />) };
}

describe('MessageList footer status positioning', () => {
  it('paints loading status outside the Virtuoso footer flow and reserves its footer space', () => {
    renderList({
      isLoading: true,
      bottomSpacerPx: 152.2,
    });

    const overlay = document.querySelector<HTMLElement>('[data-chat-status-overlay]');
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveClass('absolute');
    expect(overlay).toHaveStyle({ bottom: '193px' });

    const row = document.querySelector<HTMLElement>('[data-chat-status-row]');
    expect(row).toBeInTheDocument();
    expect(row).toHaveStyle({ height: '30px' });

    const placeholder = document.querySelector<HTMLElement>('[data-chat-footer-status-placeholder]');
    expect(placeholder).toBeInTheDocument();
    expect(placeholder).toHaveStyle({ height: '30px' });
  });

  it('hides the viewport overlay after the user scrolls away from bottom', () => {
    const { handleSpy } = renderStatefulList({
      isLoading: true,
    });

    expect(document.querySelector('[data-chat-status-overlay]')).toBeInTheDocument();

    act(() => {
      lastVirtuosoProps?.atBottomStateChange?.(false);
    });

    expect(handleSpy).toHaveBeenCalledWith(false);
    expect(document.querySelector('[data-chat-status-overlay]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-chat-footer-status-placeholder]')).toBeInTheDocument();
  });

  it('keeps the overlay visible while Virtuoso is programmatically chasing bottom', () => {
    const { handleSpy } = renderStatefulList({
      isLoading: true,
      initialFollowState: 'force',
      handleAtBottomChange: () => {
        // Real scroll owner keeps 'force' on atBottom=false while programmatic
        // scroll-to-bottom is still chasing.
      },
    });

    act(() => {
      lastVirtuosoProps?.atBottomStateChange?.(false);
    });

    expect(handleSpy).toHaveBeenCalledWith(false);
    expect(document.querySelector('[data-chat-status-overlay]')).toBeInTheDocument();
  });
});
