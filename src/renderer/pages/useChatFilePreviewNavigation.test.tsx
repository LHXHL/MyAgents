import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useChatFilePreviewNavigation } from './useChatFilePreviewNavigation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const read = deferred<{ name: string; content: string; size: number }>();
  const props = {
    service: {
      readPreview: vi.fn().mockReturnValue(read.promise), readLocalPreview: vi.fn(),
      resolvePreviewPath: vi.fn().mockResolvedValue('/workspace/report.html'), resolveLocalPreviewPath: vi.fn(),
    },
    workspacePath: '/workspace', browserEnabled: true,
    prepareTransition: vi.fn().mockResolvedValue(true), present: vi.fn(),
  };
  const hook = renderHook((input: typeof props) => useChatFilePreviewNavigation(input), { initialProps: props });
  return { ...hook, props, read };
}
const source = { name: 'report.html', path: 'report.html', initialEditMode: true };
const loaded = { name: 'report.html', content: 'current source', size: 14 };

describe('Chat file preview navigation admission', () => {
  it('keeps a newer panel selection when a Browser→Source read completes later', async () => {
    const { result, props, read } = setup();
    let pending!: Promise<void>;
    act(() => { pending = result.current.open(source); });
    // Chat's terminal/browser/file tab handlers use this same cancellation.
    act(() => result.current.cancel());
    await act(async () => { read.resolve(loaded); await pending; });
    expect(props.present).not.toHaveBeenCalled();
    expect(props.prepareTransition).not.toHaveBeenCalled();
  });

  it('leaves the current page intact when its source is oversized or unreadable', async () => {
    const { result, props, read } = setup();
    const pending = result.current.open(source);
    read.reject('4037468 bytes; max 2 MiB');
    await expect(pending).rejects.toBe('4037468 bytes; max 2 MiB');
    expect(props.present).not.toHaveBeenCalled();
  });

  it('allows a newer HTML browser request to supersede a source read', async () => {
    const { result, props, read } = setup();
    const first = result.current.open(source);
    await result.current.open({ name: 'second.htm', path: 'second.htm' });
    read.resolve(loaded);
    await first;
    expect(props.present).toHaveBeenCalledTimes(1);
    expect(props.present).toHaveBeenCalledWith(expect.objectContaining({ kind: 'browser', target: { name: 'second.htm', path: 'second.htm', initialEditMode: undefined } }));
  });

  it('respects draft transition rejection and cancellation during a pending save', async () => {
    const { result, props, read } = setup();
    const transition = deferred<boolean>();
    props.prepareTransition.mockReturnValue(transition.promise);
    const pending = result.current.open(source);
    read.resolve(loaded);
    await act(async () => { await Promise.resolve(); });
    expect(props.prepareTransition).toHaveBeenCalledWith('report.html');
    act(() => result.current.cancel());
    transition.resolve(true);
    await pending;
    expect(props.present).not.toHaveBeenCalled();
    props.prepareTransition.mockResolvedValue(false);
    await result.current.open(source);
    expect(props.present).not.toHaveBeenCalled();
  });

  it.each(['workspace', 'layout', 'unmount', 'upstream'] as const)('drops source completion after %s invalidation', async (change) => {
    const { result, rerender, unmount, props, read } = setup();
    let upstreamCurrent = true;
    const pending = result.current.open(source, { isCurrent: () => upstreamCurrent });
    if (change === 'workspace') rerender({ ...props, workspacePath: '/other' });
    if (change === 'layout') rerender({ ...props, browserEnabled: false });
    if (change === 'unmount') unmount();
    if (change === 'upstream') upstreamCurrent = false;
    read.resolve(loaded);
    await pending;
    expect(props.present).not.toHaveBeenCalled();
  });
});
