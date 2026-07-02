import { render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: {
    components?: {
      Footer?: React.ComponentType<{ context?: unknown }>;
    };
  }) => {
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

function renderList(overrides: Partial<React.ComponentProps<typeof MessageList>> = {}) {
  const props: React.ComponentProps<typeof MessageList> = {
    historyMessages: [msg('h1', 'hello', 'user')],
    streamingMessage: null,
    isLoading: false,
    sessionId: 's1',
    isActive: true,
    firstItemIndex: 1_000_000,
    virtuosoRef: { current: null },
    followEnabledRef: { current: true },
    scrollToBottom: vi.fn(),
    handleAtBottomChange: vi.fn(),
    ...overrides,
  };
  return render(<MessageList {...props} />);
}

describe('MessageList footer status positioning', () => {
  it('pins the loading status to the measured bottom spacer boundary', () => {
    renderList({
      isLoading: true,
      bottomSpacerPx: 152.2,
    });

    const anchor = document.querySelector<HTMLElement>('[data-chat-footer-status-anchor]');
    expect(anchor).toBeInTheDocument();
    expect(anchor).toHaveClass('sticky');
    expect(anchor).toHaveStyle({ bottom: '193px' });
  });
});
