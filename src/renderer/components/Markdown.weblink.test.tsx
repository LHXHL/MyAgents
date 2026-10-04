import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock('@/utils/openExternal', () => ({
  openExternal: mocks.openExternal,
  isExternalUrl: (url: string) => /^https?:\/\//i.test(url),
}));

import { BrowserPanelContext } from '@/context/BrowserPanelContext';
import { CUSTOM_EVENTS } from '../../shared/constants';
import { parseAppRouteUrl } from '../../shared/appRoute';
import Markdown from './Markdown';

describe('Markdown web links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '' } as Selection);
  });

  it.each([
    'myagents://open/v1/spaces',
    'myagents://open/v1/spaces/official/issues',
    'myagents://open/v1/spaces/myagents/issues/iss_123',
  ])('sends a validated app intent for %s', href => {
    const received: unknown[] = [];
    const handler = (event: Event) => received.push((event as CustomEvent).detail);
    window.addEventListener(CUSTOM_EVENTS.OPEN_APP_ROUTE, handler);
    try {
      render(<BrowserPanelContext.Provider value={{ openUrl: mocks.openUrl }}><Markdown>{`[Space](${href})`}</Markdown></BrowserPanelContext.Provider>);
      const link = screen.getByRole('link', { name: 'Space' });
      expect(link).toHaveAttribute('href', href);
      fireEvent.click(link, { ctrlKey: true });
      expect(received).toEqual([parseAppRouteUrl(href)]);
      expect(mocks.openUrl).not.toHaveBeenCalled();
      expect(mocks.openExternal).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.OPEN_APP_ROUTE, handler);
    }
  });

  it('opens an ordinary click in the Chat-owned BrowserPanel', () => {
    render(
      <BrowserPanelContext.Provider value={{ openUrl: mocks.openUrl }}>
        <Markdown>[Example](https://example.com)</Markdown>
      </BrowserPanelContext.Provider>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Example' }));

    expect(mocks.openUrl).toHaveBeenCalledWith('https://example.com');
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('keeps Cmd/Ctrl click as an explicit system-browser bypass', () => {
    render(
      <BrowserPanelContext.Provider value={{ openUrl: mocks.openUrl }}>
        <Markdown>[Example](https://example.com)</Markdown>
      </BrowserPanelContext.Provider>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Example' }), { ctrlKey: true });

    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com');
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });
});
