import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

type VirtuosoMockProps = {
  context?: unknown;
  components?: {
    Footer?: React.ComponentType<{ context?: unknown }>;
  };
};

vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: VirtuosoMockProps) => {
    const Footer = props.components?.Footer;
    return (
      <div data-testid="virtuoso">
        {Footer ? <Footer context={props.context} /> : null}
      </div>
    );
  },
}));

vi.mock('@/components/Message', () => ({
  default: () => <div data-testid="msg" />,
}));
vi.mock('@/components/PermissionPrompt', async () => {
  const { useState } = await import('react');
  return {
    PermissionPrompt: () => {
      const [responding, setResponding] = useState(false);
      return (
        <button
          data-testid="permission-choice"
          disabled={responding}
          onClick={() => setResponding(true)}
        >
          permission
        </button>
      );
    },
  };
});
vi.mock('@/components/AskUserQuestionPrompt', async () => {
  const { useState } = await import('react');
  return {
    AskUserQuestionPrompt: () => {
      const [selected, setSelected] = useState(false);
      return (
        <button
          data-testid="ask-choice"
          aria-pressed={selected}
          onClick={() => setSelected(true)}
        >
          answer
        </button>
      );
    },
  };
});
vi.mock('@/components/ExitPlanModePrompt', () => ({
  ExitPlanModePrompt: () => null,
}));

import MessageList from './MessageList';
import { useQueryElapsedClock } from '@/hooks/useQueryElapsedClock';

function msg(
  id: string,
  content: string,
  role: 'user' | 'assistant' = 'assistant',
): MessageType {
  return { id, role, content, timestamp: new Date() } as MessageType;
}

function createBaseProps(
  overrides: Partial<React.ComponentProps<typeof MessageList>> = {},
) {
  return {
    messages: [msg('h1', 'hello', 'user')],
    streamingMessage: null,
    isLoading: false,
    sessionId: 's1',
    isActive: true,
    firstItemIndex: 1_000_000,
    virtuosoRef: { current: null },
    followEnabledRef: { current: true } as React.MutableRefObject<
      boolean | 'force'
    >,
    scrollToBottom: vi.fn(),
    handleAtBottomChange: vi.fn(),
    ...overrides,
  };
}

function renderList(
  overrides: Partial<React.ComponentProps<typeof MessageList>> = {},
) {
  const props: React.ComponentProps<typeof MessageList> =
    createBaseProps(overrides);
  return render(<MessageList {...props} />);
}

function ClockOwner({
  props,
  mounted = true,
  waiting = false,
}: {
  props: React.ComponentProps<typeof MessageList>;
  mounted?: boolean;
  waiting?: boolean;
}) {
  const { getElapsedSeconds: getQueryElapsedSeconds } = useQueryElapsedClock(
    props.isLoading,
    waiting,
    props.sessionId ?? null,
  );
  return mounted ? (
    <MessageList {...props} getQueryElapsedSeconds={getQueryElapsedSeconds} />
  ) : null;
}

describe('MessageList footer status positioning', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['tab', 'window'])('stops footer polling while the %s is hidden, even when the query ends there', (surface) => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const elapsed = vi.fn(() => Math.floor((Date.now() - startedAt) / 1000));
    const props = createBaseProps({ isLoading: true, getQueryElapsedSeconds: elapsed });
    const { rerender } = render(<MessageList {...props} />);
    act(() => vi.advanceTimersByTime(1000));
    const hidden = surface === 'tab'
      ? { isActive: false }
      : { windowPresentation: { surfaceAvailable: false, generation: 1 } };
    rerender(<MessageList {...props} {...hidden} />);
    expect(document.querySelector('[data-chat-status-row] svg')).toBeNull();
    elapsed.mockClear();
    act(() => vi.advanceTimersByTime(5000));
    expect(elapsed).not.toHaveBeenCalled();

    rerender(<MessageList {...props} {...hidden} isLoading={false} />);
    act(() => vi.advanceTimersByTime(5000));
    expect(elapsed).not.toHaveBeenCalled();
  });

  it('resamples the Tab clock immediately when a running query becomes visible again', () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const props = createBaseProps({
      isLoading: true,
      getQueryElapsedSeconds: () => Math.floor((Date.now() - startedAt) / 1000),
    });
    const { rerender } = render(<MessageList {...props} />);
    act(() => vi.advanceTimersByTime(1000));
    const row = document.querySelector('[data-chat-status-row]');
    rerender(<MessageList {...props} isActive={false} />);
    act(() => vi.advanceTimersByTime(30000));
    rerender(<MessageList {...props} />);
    expect(document.querySelector('[data-chat-status-row]')).toBe(row);
    expect(row).toHaveTextContent('31秒');
    expect(row?.querySelector('svg')).toHaveClass('animate-spin');
  });

  it('keeps query elapsed time and the status row across footer content/layout changes', () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const props = createBaseProps({
      isLoading: true,
      getQueryElapsedSeconds: () => Math.floor((Date.now() - startedAt) / 1000),
    });
    const { rerender } = render(<MessageList {...props} />);
    act(() => vi.advanceTimersByTime(3000));
    const row = document.querySelector('[data-chat-status-row]');
    expect(row?.textContent).toMatch(/3/);
    rerender(
      <MessageList {...props} systemStatus="compacting" bottomSpacerPx={300} />,
    );
    expect(document.querySelector('[data-chat-status-row]')).toBe(row);
    act(() => vi.advanceTimersByTime(2000));
    expect(row?.textContent).toMatch(/5/);
  });

  it('keeps Tab-owned time while the list is hidden or remounted, including human waits while hidden', () => {
    vi.useFakeTimers();
    const props = createBaseProps({ isLoading: true });
    const { rerender } = render(<ClockOwner props={props} />);
    act(() => vi.advanceTimersByTime(3000));
    expect(
      document.querySelector('[data-chat-status-row]')?.textContent,
    ).toMatch(/3/);
    rerender(<ClockOwner props={{ ...props, isActive: false }} waiting />);
    act(() => vi.advanceTimersByTime(30000));
    rerender(<ClockOwner props={props} waiting />);
    expect(
      document.querySelector('[data-chat-status-row]')?.textContent,
    ).toMatch(/3/);
    rerender(<ClockOwner props={props} mounted={false} />);
    act(() => vi.advanceTimersByTime(5000));
    rerender(<ClockOwner props={props} />);
    expect(
      document.querySelector('[data-chat-status-row]')?.textContent,
    ).toMatch(/8/);
    rerender(<ClockOwner props={{ ...props, isLoading: false }} />);
    expect(document.querySelector('[data-chat-status-row]')).toBeNull();
    act(() => vi.advanceTimersByTime(20000));
    rerender(<ClockOwner props={props} />);
    act(() => vi.advanceTimersByTime(2000));
    expect(
      document.querySelector('[data-chat-status-row]')?.textContent,
    ).toMatch(/2/);
  });

  it('keeps loading status in the Virtuoso footer flow above the measured spacer', () => {
    renderList({
      isLoading: true,
      bottomSpacerPx: 152.2,
    });

    expect(
      document.querySelector('[data-chat-status-overlay]'),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-chat-footer-status-placeholder]'),
    ).not.toBeInTheDocument();

    const row = document.querySelector<HTMLElement>('[data-chat-status-row]');
    expect(row).toBeInTheDocument();
    if (!row) throw new Error('expected status row');
    expect(row).toHaveStyle({ height: '30px' });
    expect(row).not.toHaveClass('absolute');
    expect(row).not.toHaveClass('sticky');

    const spacer = document.querySelector<HTMLElement>(
      '[data-chat-footer-spacer]',
    );
    expect(spacer).toBeInTheDocument();
    if (!spacer) throw new Error('expected footer spacer');
    expect(spacer).toHaveStyle({ height: '193px' });
    expect(
      row.compareDocumentPosition(spacer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('uses the same footer slot for idle system notices', () => {
    renderList({
      systemNotice: { kind: 'compact', level: 'success', message: 'Saved' },
    });

    expect(
      document.querySelector('[data-chat-status-row]'),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-chat-footer-spacer]'),
    ).toBeInTheDocument();
    expect(document.body).toHaveTextContent('Saved');
  });

  it('preserves interaction-card state while volatile loading footer values change', () => {
    const pendingAskUserQuestion = {
      requestId: 'ask-1',
      questions: [
        {
          question: 'Choose',
          header: 'Choice',
          options: [
            { label: 'One', description: 'First' },
            { label: 'Two', description: 'Second' },
          ],
          multiSelect: false,
        },
      ],
    };
    const pendingPermission = {
      requestId: 'permission-1',
      toolName: 'Bash',
      input: '{}',
    };
    const first = createBaseProps({
      isLoading: true,
      pendingAskUserQuestion,
      onAskUserQuestionSubmit: vi.fn(),
      onAskUserQuestionCancel: vi.fn(),
      pendingPermission,
      onPermissionDecision: vi.fn(),
      bottomSpacerPx: 152,
    });
    const view = render(<MessageList {...first} />);

    fireEvent.click(screen.getByTestId('ask-choice'));
    fireEvent.click(screen.getByTestId('permission-choice'));
    expect(screen.getByTestId('ask-choice')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('permission-choice')).toBeDisabled();

    view.rerender(
      <MessageList
        {...createBaseProps({
          ...first,
          systemStatus: 'api_retry:2:3',
          bottomSpacerPx: 168,
        })}
      />,
    );

    expect(screen.getByTestId('ask-choice')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('permission-choice')).toBeDisabled();
  });

  it('projects interaction waiting as a static status instead of a reasoning timer', () => {
    renderList({
      isLoading: true,
      pendingAskUserQuestion: {
        requestId: 'ask-static',
        questions: [
          {
            question: 'Choose',
            header: 'Choice',
            options: [
              { label: 'One', description: 'First' },
              { label: 'Two', description: 'Second' },
            ],
            multiSelect: false,
          },
        ],
      },
      onAskUserQuestionSubmit: vi.fn(),
      onAskUserQuestionCancel: vi.fn(),
    });

    const status = document.querySelector(
      '[data-chat-waiting-for-interaction]',
    );
    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent('等待你的选择');
    expect(status?.querySelector('.animate-spin')).not.toBeInTheDocument();
  });

  it('returns to execution status after a plan response is accepted', () => {
    renderList({
      isLoading: true,
      pendingExitPlanMode: {
        requestId: 'plan-accepted',
        resolved: 'approved',
      },
      onExitPlanModeApprove: vi.fn(),
      onExitPlanModeReject: vi.fn(),
    });

    expect(
      document.querySelector('[data-chat-waiting-for-interaction]'),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-chat-status-row]'),
    ).toBeInTheDocument();
  });
});
