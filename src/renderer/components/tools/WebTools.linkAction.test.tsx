import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserPanelContext } from '@/context/BrowserPanelContext';
import type { ToolUseSimple } from '@/types/chat';
import WebFetchTool from './WebFetchTool';
import WebSearchTool from './WebSearchTool';

const openUrl = vi.fn();

function renderInChat(children: React.ReactNode) {
  return render(
    <BrowserPanelContext.Provider value={{ openUrl }}>
      {children}
    </BrowserPanelContext.Provider>,
  );
}

describe('web tool link actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '',
    } as Selection);
  });

  it('opens WebSearch results in the internal BrowserPanel', () => {
    const tool = {
      id: 'search-1',
      name: 'WebSearch',
      input: { query: 'example' },
      parsedInput: { query: 'example' },
      inputJson: '{"query":"example"}',
      result: JSON.stringify([{ title: 'Example result', url: 'https://example.com/result' }]),
      streamIndex: 0,
    } as ToolUseSimple;
    renderInChat(<WebSearchTool tool={tool} />);

    fireEvent.click(screen.getByRole('link', { name: /Example result/ }));

    expect(openUrl).toHaveBeenCalledWith('https://example.com/result');
  });

  it('opens WebFetch targets in the internal BrowserPanel', () => {
    const tool = {
      id: 'fetch-1',
      name: 'WebFetch',
      input: { url: 'https://example.com/page', prompt: 'Read it' },
      parsedInput: { url: 'https://example.com/page', prompt: 'Read it' },
      streamIndex: 0,
    } as ToolUseSimple;
    renderInChat(<WebFetchTool tool={tool} />);

    fireEvent.click(screen.getByRole('link', { name: 'https://example.com/page' }));

    expect(openUrl).toHaveBeenCalledWith('https://example.com/page');
  });

  it('shows retained service text alongside confirmed sources without turning prose into links', () => {
    const tool = {
      id: 'partial-search', name: 'WebSearch', parsedInput: { query: 'example' }, streamIndex: 0,
      result: JSON.stringify({
        results: [{ title: 'Confirmed source', url: 'https://example.com/result' }],
        answer: 'Unconfirmed https://unconfirmed.test remains service text',
        warnings: ['unverified_search_results'],
      }),
    } as ToolUseSimple;
    renderInChat(<WebSearchTool tool={tool} />);
    expect(screen.getByText('Unconfirmed https://unconfirmed.test remains service text')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Confirmed source/ })).toBeInTheDocument();
    expect(screen.queryByText(/"warnings"/)).not.toBeInTheDocument();
  });

  it('keeps legacy SDK text in a mixed search result', () => {
    const tool = {
      id: 'sdk-search', name: 'WebSearch', parsedInput: { query: 'example' }, streamIndex: 0,
      result: JSON.stringify({ results: [
        'SDK service summary', { content: [{ title: 'SDK source', url: 'https://example.com/sdk' }] },
      ] }),
    } as ToolUseSimple;
    renderInChat(<WebSearchTool tool={tool} />);
    expect(screen.getByText('SDK service summary')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /SDK source/ })).toBeInTheDocument();
  });
});
