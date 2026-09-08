import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpandableContainer } from './utils';
import { ChatRowLayoutProvider } from '@/context/ChatRowLayoutContext';

let contentHeight: number;
let measure: () => void;
const disconnect = vi.fn();
beforeEach(() => {
  contentHeight = 160;
  disconnect.mockClear();
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(80);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { measure = callback; }
    observe() {}
    disconnect = disconnect;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('compact expandable command content', () => {
  it('preserves complete content, expands and collapses with matching row-layout notifications', () => {
    const onRowLayoutChanged = vi.fn();
    const command = 'first line\nlast line remains available';
    const { container, unmount } = render(<ChatRowLayoutProvider messageId="message" onRowLayoutChanged={onRowLayoutChanged}>
      <ExpandableContainer compact fade="code-bg" expandLabel="Expand command" collapseLabel="Collapse command"><pre>{command}</pre></ExpandableContainer>
    </ChatRowLayoutProvider>);
    expect(container.querySelector('pre')?.textContent).toBe(command);
    const expand = screen.getByRole('button', { name: 'Expand command' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(expand.getAttribute('aria-controls')!)).toContainElement(container.querySelector('pre'));
    fireEvent.click(expand);
    expect(onRowLayoutChanged).toHaveBeenLastCalledWith('message', 'expandable-container-expand');
    expect(screen.getByRole('button', { name: 'Collapse command' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse command' }));
    expect(onRowLayoutChanged).toHaveBeenLastCalledWith('message', 'expandable-container-collapse');
    expect(container.querySelector('pre')?.textContent).toBe(command);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('shows an expander only when content overflows, including after a width change', () => {
    contentHeight = 40;
    render(<ExpandableContainer compact expandLabel="Expand command"><pre>short command</pre></ExpandableContainer>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    act(() => { contentHeight = 160; measure(); });
    expect(screen.getByRole('button', { name: 'Expand command' })).toBeInTheDocument();
    act(() => { contentHeight = 40; measure(); });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
