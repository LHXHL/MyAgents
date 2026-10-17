import { StrictMode, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarResizeHandle } from './SidebarResizeHandle';

class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

function Fixture({ expanded = true, onCommit = vi.fn() }: { expanded?: boolean; onCommit?: (width: number) => void }) {
  const [width, setWidth] = useState(256);
  return <div data-testid="shell" data-app-shell><aside>
    <SidebarResizeHandle expanded={expanded} width={width} onStart={() => {}}
      onCommit={(value) => { setWidth(value); onCommit(value); }} />
  </aside><main /></div>;
}

const pointer = (clientX: number, pointerId = 1) => ({ clientX, pointerId, button: 0 });
const width = () => screen.getByTestId('shell').style.getPropertyValue('--global-sidebar-expanded-width');

describe('sidebar width transaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => window.setTimeout(() => fn(0), 16));
    vi.stubGlobal('cancelAnimationFrame', window.clearTimeout.bind(window));
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => true);
    Element.prototype.releasePointerCapture = vi.fn();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('coalesces live changes, clamps them, and commits the final pointer position once', () => {
    const commit = vi.fn();
    render(<StrictMode><Fixture onCommit={commit} /></StrictMode>);
    const handle = screen.getByRole('separator');
    expect(width()).toBe('256px');
    fireEvent.pointerDown(handle, pointer(256));
    fireEvent.pointerMove(window, pointer(300));
    fireEvent.pointerMove(window, pointer(800));
    expect(commit).not.toHaveBeenCalled();
    expect(width()).toBe('256px');
    act(() => vi.advanceTimersByTime(16));
    expect(width()).toBe('360px');
    fireEvent.pointerMove(window, pointer(200));
    act(() => vi.advanceTimersByTime(16));
    expect(width()).toBe('224px');
    fireEvent.pointerUp(window, pointer(312));
    expect(commit).toHaveBeenCalledExactlyOnceWith(312);
    expect(width()).toBe('312px');
    fireEvent.lostPointerCapture(handle, pointer(312));
    expect(width()).toBe('312px');
    expect(document.querySelector('[data-sidebar-resize-shield]')).toBeNull();
    expect(document.body.style.cursor).toBe('');
  });

  it.each(['escape', 'blur', 'cancel', 'lostCapture', 'rail'] as const)('rolls back on %s and releases pending work', (reason) => {
    const commit = vi.fn();
    const view = render(<Fixture onCommit={commit} />);
    const handle = screen.getByRole('separator');
    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'text';
    fireEvent.pointerDown(handle, pointer(256));
    fireEvent.pointerMove(window, pointer(350));
    act(() => vi.advanceTimersByTime(16));
    expect(width()).toBe('350px');
    fireEvent.pointerMove(window, pointer(340));
    if (reason === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
    if (reason === 'blur') fireEvent.blur(window);
    if (reason === 'cancel') fireEvent.pointerCancel(window, pointer(340));
    if (reason === 'lostCapture') fireEvent.lostPointerCapture(handle, pointer(340));
    if (reason === 'rail') view.rerender(<Fixture expanded={false} onCommit={commit} />);
    act(() => vi.advanceTimersByTime(32));
    fireEvent.pointerUp(window, pointer(340));
    expect(commit).not.toHaveBeenCalled();
    expect(width()).toBe('256px');
    expect(document.querySelector('[data-sidebar-resize-shield]')).toBeNull();
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('restores shell projection and pointer resources when unmounted during a drag', () => {
    const commit = vi.fn();
    const view = render(<Fixture onCommit={commit} />);
    const shell = screen.getByTestId('shell');
    fireEvent.pointerDown(screen.getByRole('separator'), pointer(256));
    fireEvent.pointerMove(window, pointer(340));
    view.unmount();
    act(() => vi.advanceTimersByTime(32));
    fireEvent.pointerUp(window, pointer(340));
    expect(commit).not.toHaveBeenCalled();
    expect(shell.style.getPropertyValue('--global-sidebar-expanded-width')).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('supports keyboard limits and reset, double-click reset, and no rail focus target', () => {
    const view = render(<Fixture />);
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(width()).toBe('264px');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(width()).toBe('256px');
    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '224');
    fireEvent.keyDown(handle, { key: 'End' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(width()).toBe('360px');
    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(width()).toBe('256px');
    fireEvent.keyDown(handle, { key: 'End' });
    fireEvent.doubleClick(handle);
    expect(width()).toBe('256px');
    view.rerender(<Fixture expanded={false} />);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(handle.tabIndex).toBe(-1);
  });

  it('ignores other buttons and pointers', () => {
    const commit = vi.fn();
    render(<Fixture onCommit={commit} />);
    const handle = screen.getByRole('separator');
    fireEvent.pointerDown(handle, { ...pointer(256), button: 2 });
    expect(document.querySelector('[data-sidebar-resize-shield]')).toBeNull();
    fireEvent.pointerDown(handle, pointer(256));
    fireEvent.pointerMove(window, pointer(340, 2));
    fireEvent.pointerUp(window, pointer(340, 2));
    expect(commit).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, pointer(280));
    expect(commit).toHaveBeenCalledExactlyOnceWith(280);
  });
});
