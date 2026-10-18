import { StrictMode, useCallback, useLayoutEffect, useReducer, useRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatWorkspaceLayout } from './useChatWorkspaceLayout';
import { createWorkspacePanelDisclosureState, reduceWorkspacePanelDisclosure } from '@/utils/chatWorkspaceLayout';

let containerWidth = 1000;
let notify: () => void;
const disconnected = vi.fn();
let renders = 0;
function Fixture({ split = false, ratio = 0.5, browser = false }) {
  const layout = useChatWorkspaceLayout({ splitViewEnabled: true, splitPanelVisible: split, splitRatio: ratio, browserPresented: browser });
  renders++;
  return <div ref={layout.containerRef} data-testid="chat" data-ready={layout.ready}
    data-mode={layout.workspacePanelMode} data-narrow={layout.isNarrowLayout} data-fullscreen={layout.browserUsesFullscreen} />;
}
function DisclosureFixture() {
  const [disclosure, dispatch] = useReducer(reduceWorkspacePanelDisclosure, false, createWorkspacePanelDisclosureState);
  const motionRef = useRef(disclosure.motion);
  useLayoutEffect(() => { motionRef.current = disclosure.motion; }, [disclosure.motion]);
  const onResize = useCallback(() => {
    if (motionRef.current !== null) dispatch({ type: 'settle-layout' });
  }, []);
  const { containerRef, workspacePanelMode } = useChatWorkspaceLayout({ splitViewEnabled: true, splitPanelVisible: false, splitRatio: 0.5, browserPresented: false, onResize });
  return <div ref={containerRef} data-testid="disclosure" data-visible={disclosure.visible}
    data-motion={workspacePanelMode === 'inline' ? disclosure.motion ?? '' : ''}>
    <button onClick={() => dispatch({ type: 'open' })}>Open</button>
    <button onClick={() => dispatch({ type: 'close' })}>Close</button>
  </div>;
}
describe('Chat container layout', () => {
  beforeEach(() => {
    renders = 0;
    containerWidth = 1000;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: containerWidth } as DOMRect));
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notify = callback; }
      observe() {}
      disconnect() { disconnected(); }
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('responds to container changes without window resize and preserves hidden-tab geometry', () => {
    const windowWidth = window.innerWidth;
    const view = render(<StrictMode><Fixture /></StrictMode>);
    const chat = screen.getByTestId('chat');
    expect(chat).toHaveAttribute('data-mode', 'inline');
    act(() => { containerWidth = 900; notify(); });
    expect(chat).toHaveAttribute('data-mode', 'overlay');
    expect(window.innerWidth).toBe(windowWidth);
    act(() => { containerWidth = 0; notify(); });
    expect(chat).toHaveAttribute('data-mode', 'overlay');
    expect(chat).toHaveAttribute('data-narrow', 'false');
    act(() => { containerWidth = 1000; notify(); });
    expect(chat).toHaveAttribute('data-mode', 'inline');
    view.unmount();
    expect(disconnected).toHaveBeenCalled();
  });

  it('does not rerender on every pixel while decisions are unchanged', () => {
    render(<Fixture />);
    // React can invoke the state owner once to settle a same-value update.
    act(() => { containerWidth = 1001; notify(); });
    const before = renders;
    for (let i = 0; i < 10; i++) act(() => { containerWidth += 1; notify(); });
    expect(renders).toBe(before);
  });

  it('waits for first nonzero geometry and applies split ratio exactly once', () => {
    containerWidth = 0;
    const view = render(<Fixture split />);
    const chat = screen.getByTestId('chat');
    expect(chat).toHaveAttribute('data-ready', 'false');
    act(() => { containerWidth = 1920; notify(); });
    expect(chat).toHaveAttribute('data-ready', 'true');
    expect(chat).toHaveAttribute('data-mode', 'inline');
    view.rerender(<Fixture split ratio={0.49} />);
    expect(chat).toHaveAttribute('data-mode', 'overlay');
    view.rerender(<Fixture split browser />);
    act(() => { containerWidth = 600; notify(); });
    expect(chat).toHaveAttribute('data-fullscreen', 'true');
    act(() => { containerWidth = 1000; notify(); });
    expect(chat).toHaveAttribute('data-fullscreen', 'false');
  });

  it('does not replay a previous workspace-open animation after overlay to inline or drag release', () => {
    render(<DisclosureFixture />);
    act(() => screen.getByText('Open').click());
    const pane = screen.getByTestId('disclosure');
    expect(pane).toHaveAttribute('data-motion', 'expand');
    act(() => { containerWidth = 860; notify(); });
    expect(pane).toHaveAttribute('data-motion', '');
    act(() => { containerWidth = 996; notify(); });
    expect(pane).toHaveAttribute('data-motion', '');
    expect(pane).toHaveAttribute('data-visible', 'true');
    act(() => notify());
    expect(pane).toHaveAttribute('data-motion', '');
    act(() => screen.getByText('Close').click());
    act(() => { containerWidth = 900; notify(); });
    expect(pane).toHaveAttribute('data-visible', 'false');
  });

  it('reads the same CSS panel ratio as the rendered workspace', () => {
    render(<Fixture />);
    const chat = screen.getByTestId('chat');
    chat.style.setProperty('--chat-workspace-panel-ratio', '0.5');
    act(() => notify());
    expect(chat).toHaveAttribute('data-mode', 'overlay');
  });
});
