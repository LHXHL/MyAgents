import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Message as MessageType } from '@/types/chat';
import { i18n } from '@/i18n';
import { createWebSearchCitationIndex, citationScope } from '@/utils/webSearchCitations';

vi.mock('@/context/ImagePreviewContext', () => ({ useImagePreview: () => ({ openPreview: vi.fn() }) }));
vi.mock('@/components/Toast', () => ({ useToastOptional: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));
vi.mock('@/utils/clipboard', () => ({ copyPlainText: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/utils/markdownExport', () => ({ buildReplyMarkdown: (text: string) => text, downloadMarkdown: vi.fn().mockResolvedValue('saved'), localDateStr: () => '2026-10-11' }));
import { copyPlainText } from '@/utils/clipboard';
import { downloadMarkdown } from '@/utils/markdownExport';
import Message from './Message';

const cite = '\uE200cite\uE202turn0search0\uE201';
const source = { ref_id: 'turn0search0', title: 'Primary source', url: 'https://example.com/source' };
const search: MessageType = { id: 'search-message', turnId: 'product-turn', role: 'assistant', timestamp: new Date(0), content: [{ type: 'tool_use', tool: { id: 'search', name: 'WebSearch', streamIndex: 0, input: {}, result: JSON.stringify({ results: [source] }) } }] };
const sources = createWebSearchCitationIndex()([search]).get(citationScope(search));
function answer(blocks: boolean): MessageType {
  return { id: 'answer', turnId: 'product-turn', role: 'assistant', timestamp: new Date(0), content: blocks ? [{ type: 'text', text: `Claim ${cite}.` }] : `Claim ${cite}.`, streamingTextActive: true };
}

describe('desktop citation live/history/actions', () => {
  it.each([false, true])('updates an unchanged row when source projection arrives; completed/reloaded content stays linked (blocks=%s)', blocks => {
    const message = answer(blocks);
    const { container, rerender, unmount } = render(<Message message={message} isLoading />);
    expect(container.textContent).not.toMatch(/[\uE200-\uE202]|turn0search/);
    expect(container.querySelector('a')).toBeNull();
    rerender(<Message message={message} citationSources={sources} isLoading />);
    expect(container.querySelector('a')).toHaveAttribute('href', source.url);
    rerender(<Message message={message} citationSources={sources} />);
    expect(container.querySelector('a')).toHaveAttribute('href', source.url);
    unmount();
    const restored = JSON.parse(JSON.stringify(message)) as MessageType;
    restored.timestamp = new Date(0);
    expect(render(<Message message={restored} citationSources={sources} />).container.querySelector('a')).toHaveAttribute('href', source.url);
  });

  it.each([false, true])('copy and export use the same explicit source mapping (blocks=%s)', async blocks => {
    render(<Message message={answer(blocks)} citationSources={sources} />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('app:message.actions.copy') }));
    await waitFor(() => expect(copyPlainText).toHaveBeenLastCalledWith('Claim [Primary source](<https://example.com/source>).'));
    fireEvent.click(screen.getByRole('button', { name: i18n.t('app:message.actions.exportMarkdown') }));
    await waitFor(() => expect(downloadMarkdown).toHaveBeenLastCalledWith(expect.any(String), 'Claim [Primary source](<https://example.com/source>).'));
  });
});
