import { act, useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserPanel from './BrowserPanel';

const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  error: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: async (name: string, listener: (event: { payload: unknown }) => void, signal: AbortSignal) => {
    native.listeners.set(name, listener);
    signal.addEventListener('abort', () => native.listeners.delete(name), { once: true });
    return { unlisten: () => native.listeners.delete(name), isRegistered: () => true };
  },
}));
vi.mock('@/hooks/useBrowserOverlayGuard', () => ({ useBrowserOverlayGuard: () => false }));
vi.mock('@/utils/openExternal', () => ({ openExternal: vi.fn() }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ error: native.error }) }));
vi.mock('@/components/Tip', () => ({ default: ({ children, label }: { children: React.ReactNode; label: string }) => <span title={label}>{children}</span> }));

const seed = 'https://example.com/start';
const noop = () => {};
function Harness({ initiallyAlive = true }: { initiallyAlive?: boolean }) {
  const [alive, setAlive] = useState(initiallyAlive);
  const [visible, setVisible] = useState(true);
  const [navigationRequest, setNavigationRequest] = useState({ url: seed });
  return <>
    <button onClick={() => setVisible(value => !value)}>toggle visibility</button>
    <button onClick={() => setNavigationRequest({ url: seed })}>open original link</button>
    <BrowserPanel tabId="navigation-test" navigationRequest={navigationRequest} onNavigate={url => setNavigationRequest({ url })} browserAlive={alive} isVisible={visible}
      isDraggingSplit={false} onBrowserCreated={() => setAlive(true)} onCreateFailed={noop} onClose={noop} />
  </>;
}
function navigate(view: ReturnType<typeof render>, address: string) {
  fireEvent.click(view.getByTitle(seed));
  fireEvent.change(view.getByRole('textbox'), { target: { value: address } });
  fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter' });
}
async function emit(kind: string, payload: unknown) {
  await act(async () => {
    for (const [name, listener] of native.listeners) if (name.startsWith(`browser:${kind}:`)) listener({ payload });
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  native.invoke.mockReset().mockResolvedValue(undefined);
  native.error.mockClear(); native.listeners.clear();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', noop);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 100, width: 600, height: 600 } as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BrowserPanel navigation intent and basic controls', () => {
  it('preserves address-bar navigation when visibility changes', async () => {
    const view = render(<Harness />);
    navigate(view, 'https://example.com/destination');
    await emit('url-changed', 'https://example.com/destination');
    native.invoke.mockClear();
    fireEvent.click(view.getByText('toggle visibility'));
    fireEvent.click(view.getByText('toggle visibility'));
    expect(native.invoke.mock.calls.filter(([command]) => command === 'cmd_browser_navigate')).toEqual([]);
  });
  it('treats reopening the original link as a fresh navigation after a native page navigation', async () => {
    const view = render(<Harness />);
    await emit('url-changed', 'https://example.com/elsewhere');
    native.invoke.mockClear();
    fireEvent.click(view.getByText('open original link'));
    expect(native.invoke.mock.calls.filter(([command]) => command === 'cmd_browser_navigate'))
      .toEqual([['cmd_browser_navigate', expect.objectContaining({ url: seed })]]);
  });
  it('delivers the latest address only after pending native creation completes', async () => {
    let finishCreate!: () => void;
    native.invoke.mockImplementation(command => command === 'cmd_browser_create'
      ? new Promise(resolve => { finishCreate = () => resolve(undefined); }) : Promise.resolve(undefined));
    const view = render(<Harness initiallyAlive={false} />);
    navigate(view, 'localhost:3000');
    navigate(view, 'localhost:4000');
    expect(native.invoke.mock.calls.filter(([command]) => command === 'cmd_browser_navigate')).toHaveLength(0);
    await act(async () => { finishCreate(); });
    expect(native.invoke.mock.calls.filter(([command]) => command === 'cmd_browser_navigate'))
      .toEqual([['cmd_browser_navigate', expect.objectContaining({ url: 'http://localhost:4000/' })]]);
    expect(native.invoke.mock.calls.filter(([command]) => command === 'cmd_browser_create')).toHaveLength(1);
  });
  it('reports current creation failure even when its requested address changed', async () => {
    let failCreate!: (error: Error) => void;
    vi.spyOn(console, 'error').mockImplementation(noop);
    native.invoke.mockImplementation(command => command === 'cmd_browser_create'
      ? new Promise((_, reject) => { failCreate = reject; }) : Promise.resolve(undefined));
    const view = render(<Harness initiallyAlive={false} />);
    navigate(view, 'localhost:3000');
    await act(async () => { failCreate(new Error('creation failed')); });
    expect(native.error).toHaveBeenCalledOnce();
  });
  it('does not surface an old navigation failure after the panel closes', async () => {
    const view = render(<Harness />);
    let fail!: (error: Error) => void;
    native.invoke.mockImplementation(command => command === 'cmd_browser_navigate'
      ? new Promise((_, reject) => { fail = reject; }) : Promise.resolve(undefined));
    navigate(view, 'https://example.com/new');
    view.unmount();
    await act(async () => { fail(new Error('old generation')); });
    expect(native.error).not.toHaveBeenCalled();
  });
  it('reloads after loading has finished', async () => {
    const view = render(<Harness />);
    await emit('loading', false);
    native.invoke.mockClear();
    fireEvent.click(view.getByTitle('刷新').querySelector('button')!);
    expect(native.invoke).toHaveBeenCalledWith('cmd_browser_reload', expect.anything());
  });
  it('stops loading without issuing reload', async () => {
    const view = render(<Harness />);
    await emit('loading', true);
    native.invoke.mockClear();
    fireEvent.click(view.getByTitle('停止').querySelector('button')!);
    expect(native.invoke).toHaveBeenCalledWith('cmd_browser_stop', expect.objectContaining({ tabId: 'navigation-test' }));
    expect(native.invoke.mock.calls.some(([command]) => command === 'cmd_browser_reload')).toBe(false);
  });
  it('recognizes a local development server address', () => {
    const view = render(<Harness />);
    navigate(view, 'localhost:3000');
    expect(native.invoke).toHaveBeenCalledWith('cmd_browser_navigate', expect.objectContaining({ url: 'http://localhost:3000/' }));
  });
  it('rejects search text instead of dispatching a malformed URL', () => {
    const view = render(<Harness />);
    native.invoke.mockClear();
    navigate(view, 'browser performance');
    expect(native.invoke.mock.calls.some(([command]) => command === 'cmd_browser_navigate')).toBe(false);
    expect(native.error).toHaveBeenCalled();
  });
  it('reports a failed navigation', async () => {
    const view = render(<Harness />);
    native.invoke.mockImplementation(async command => {
      if (command === 'cmd_browser_navigate') throw new Error('native navigation unavailable');
    });
    navigate(view, 'https://example.com/destination');
    await act(async () => { await Promise.resolve(); });
    expect(native.error).toHaveBeenCalled();
  });
});
