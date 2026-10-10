import { render, screen } from '@testing-library/react';
import React from 'react';
import { expect, it, vi } from 'vitest';
import type { Message as MessageType } from '@/types/chat';
import type { CitationSources } from '@/utils/runtimeCitations';

const VirtualRow = React.memo(function VirtualRow({ index, message, context, itemContent }: {
  index: number; message: MessageType; context: unknown;
  itemContent: (index: number, message: MessageType, context: unknown) => React.ReactNode;
}) { return itemContent(index, message, context); });
vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: { data: MessageType[]; context: unknown; itemContent: (index: number, message: MessageType, context: unknown) => React.ReactNode }) => <div>{props.data.map((message, index) => <VirtualRow key={message.id} index={index} message={message} context={props.context} itemContent={props.itemContent} />)}</div>,
}));
vi.mock('@/components/Message', () => ({
  default: ({ message, citationSources }: { message: MessageType; citationSources?: CitationSources }) => <div data-testid={message.id}>{citationSources?.get('turn0search0')?.url ?? 'unresolved'}</div>,
}));
vi.mock('@/components/PermissionPrompt', () => ({ PermissionPrompt: () => null }));
vi.mock('@/components/AskUserQuestionPrompt', () => ({ AskUserQuestionPrompt: () => null }));
vi.mock('@/components/ExitPlanModePrompt', () => ({ ExitPlanModePrompt: () => null }));
import MessageList from './MessageList';

it('invalidates a mounted sibling row through Virtuoso context when search sources arrive, then isolates a new turn', () => {
  const answer: MessageType = { id: 'answer', role: 'assistant', turnId: 'one', content: 'unchanged answer', timestamp: new Date(0) };
  const search: MessageType = { id: 'search', role: 'assistant', turnId: 'one', content: [{ type: 'tool_use', tool: { id: 'web', name: 'WebSearch', streamIndex: 0, input: {}, isLoading: true } }], timestamp: new Date(0) };
  const props = {
    streamingMessage: null, isLoading: false, sessionId: 'session-one', isActive: true,
    virtuosoRef: { current: null }, followEnabledRef: { current: true as const },
    scrollToBottom: vi.fn(), handleAtBottomChange: vi.fn(),
  };
  const { rerender } = render(<MessageList {...props} messages={[search, answer]} />);
  expect(screen.getByTestId('answer')).toHaveTextContent('unresolved');
  const completed: MessageType = { ...search, content: [{ type: 'tool_use', tool: { id: 'web', name: 'WebSearch', streamIndex: 0, input: {}, isLoading: false, result: JSON.stringify({ results: [{ ref_id: 'turn0search0', title: 'Source', url: 'https://example.com/' }] }) } }] };
  rerender(<MessageList {...props} messages={[completed, answer]} />);
  expect(screen.getByTestId('answer')).toHaveTextContent('https://example.com/');
  const next: MessageType = { ...answer, id: 'new-answer', turnId: 'two' };
  rerender(<MessageList {...props} messages={[completed, answer, next]} />);
  expect(screen.getByTestId('new-answer')).toHaveTextContent('unresolved');
});
