import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkPaths: vi.fn(),
  checkLocalPaths: vi.fn(),
}));

vi.mock('@/components/Toast', () => ({
  useToastOptional: () => null,
}));

vi.mock('@/components/ContextMenu', () => ({
  default: () => <div data-testid="file-context-menu" />,
}));

vi.mock('@/context/ImagePreviewContext', () => ({
  useImagePreview: () => ({ openPreview: vi.fn() }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: (workspacePath: string | null) => ({
    isAvailable: true,
    checkPaths: (args: { paths: string[] }) => mocks.checkPaths(workspacePath, args),
    checkLocalPaths: (args: { paths: string[]; workspace: string | null }) => (
      mocks.checkLocalPaths(workspacePath, args)
    ),
    openWithDefault: vi.fn(),
    openPathWithDefault: vi.fn(),
    openPathExternal: vi.fn(),
    openInFinder: vi.fn(),
    readPreview: vi.fn(),
    readLocalPreview: vi.fn(),
    downloadFile: vi.fn(),
    downloadLocalFile: vi.fn(),
  }),
}));

import { FileActionProvider, useFileAction, useFileTargetInfo } from './FileActionContext';
import type { FileActionTarget } from '@/utils/workspaceFileLinks';

function Probe({ target, testId = 'state' }: { target: FileActionTarget; testId?: string }) {
  const info = useFileTargetInfo(target);
  return (
    <output data-testid={testId}>
      {info ? (info.exists ? 'available' : 'unavailable') : 'pending'}
    </output>
  );
}

function MenuProbe({ target }: { target: FileActionTarget }) {
  const fileAction = useFileAction();
  const info = useFileTargetInfo(target);
  return (
    <button
      data-testid="open-menu"
      type="button"
      disabled={!info?.exists}
      onClick={() => fileAction?.openFileTargetMenu(10, 20, target)}
    >
      open
    </button>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('FileActionProvider verified target cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.checkPaths.mockResolvedValue({ results: {} });
    mocks.checkLocalPaths.mockResolvedValue({ results: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('discards a late response from the previous workspace generation', async () => {
    const slowA = deferred<{ results: Record<string, { exists: boolean; type: 'file' }> }>();
    mocks.checkPaths.mockImplementation((workspace: string) => {
      if (workspace === '/workspace-a') return slowA.promise;
      return Promise.resolve({ results: { 'docs/a.md': { exists: false, type: 'file' } } });
    });

    const view = render(
      <FileActionProvider workspacePath="/workspace-a">
        <Probe target={{ scope: 'workspace', path: 'docs/a.md' }} />
      </FileActionProvider>,
    );
    await waitFor(() => expect(mocks.checkPaths).toHaveBeenCalledWith(
      '/workspace-a',
      { paths: ['docs/a.md'] },
    ));

    view.rerender(
      <FileActionProvider workspacePath="/workspace-b">
        <Probe target={{ scope: 'workspace', path: 'docs/a.md' }} />
      </FileActionProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('unavailable'));

    await act(async () => {
      slowA.resolve({ results: { 'docs/a.md': { exists: true, type: 'file' } } });
      await slowA.promise;
    });
    expect(screen.getByTestId('state')).toHaveTextContent('unavailable');
  });

  it('expires and rechecks local results after the 30 second lease', async () => {
    vi.useFakeTimers();
    mocks.checkLocalPaths
      .mockResolvedValueOnce({ results: { '/Users/me/note.md': { exists: true, type: 'file' } } })
      .mockResolvedValueOnce({ results: { '/Users/me/note.md': { exists: false, type: 'file' } } });

    render(
      <FileActionProvider workspacePath="/workspace">
        <Probe target={{ scope: 'local', path: '/Users/me/note.md' }} />
      </FileActionProvider>,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(screen.getByTestId('state')).toHaveTextContent('available');

    await act(async () => { await vi.advanceTimersByTimeAsync(29_990); });
    expect(screen.getByTestId('state')).toHaveTextContent('pending');
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(screen.getByTestId('state')).toHaveTextContent('unavailable');
    expect(mocks.checkLocalPaths).toHaveBeenCalledTimes(2);
  });

  it('splits mounted candidates at the Rust 200-path batch cap', async () => {
    vi.useFakeTimers();
    mocks.checkPaths.mockResolvedValue({ results: {} });
    const targets = Array.from({ length: 201 }, (_, index) => `docs/${index}.md`);

    render(
      <FileActionProvider workspacePath="/workspace">
        {targets.map((path) => (
          <Probe key={path} testId={`state-${path}`} target={{ scope: 'workspace', path }} />
        ))}
      </FileActionProvider>,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(mocks.checkPaths).toHaveBeenCalledTimes(2);
    expect(mocks.checkPaths.mock.calls.map(([, args]) => args.paths.length)).toEqual([200, 1]);
  });

  it('ignores response keys that were not requested by the active batch', async () => {
    vi.useFakeTimers();
    const firstResponse = deferred<{
      results: Record<string, { exists: boolean; type: 'file' }>;
    }>();
    mocks.checkPaths
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue({ results: { 'docs/extra.md': { exists: false, type: 'file' } } });

    const view = render(
      <FileActionProvider workspacePath="/workspace">
        <Probe key="requested" target={{ scope: 'workspace', path: 'docs/requested.md' }} />
      </FileActionProvider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });

    view.rerender(
      <FileActionProvider workspacePath="/workspace">
        <Probe key="requested" target={{ scope: 'workspace', path: 'docs/requested.md' }} />
        <Probe key="extra" testId="extra-state" target={{ scope: 'workspace', path: 'docs/extra.md' }} />
      </FileActionProvider>,
    );

    await act(async () => {
      firstResponse.resolve({
        results: {
          'docs/requested.md': { exists: false, type: 'file' },
          'docs/extra.md': { exists: true, type: 'file' },
        },
      });
      await firstResponse.promise;
    });
    expect(screen.getByTestId('extra-state')).toHaveTextContent('pending');
  });

  it('does not accept a later chunk key from an earlier 200-path response', async () => {
    vi.useFakeTimers();
    const stalledTail = deferred<{
      results: Record<string, { exists: boolean; type: 'file' }>;
    }>();
    const targets = Array.from({ length: 201 }, (_, index) => `docs/chunk-${index}.md`);
    mocks.checkPaths.mockImplementation((_: string, args: { paths: string[] }) => (
      args.paths.length === 200
        ? Promise.resolve({ results: { [targets[200]]: { exists: true, type: 'file' as const } } })
        : stalledTail.promise
    ));

    render(
      <FileActionProvider workspacePath="/workspace">
        {targets.map((path, index) => (
          <Probe key={path} testId={`chunk-${index}`} target={{ scope: 'workspace', path }} />
        ))}
      </FileActionProvider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });

    expect(screen.getByTestId('chunk-200')).toHaveTextContent('pending');
    stalledTail.resolve({ results: { [targets[200]]: { exists: false, type: 'file' } } });
    await stalledTail.promise;
  });

  it('cancels queued work when the last mounted consumer leaves before flush', async () => {
    vi.useFakeTimers();
    const view = render(
      <FileActionProvider workspacePath="/workspace">
        <Probe target={{ scope: 'workspace', path: 'docs/gone.md' }} />
      </FileActionProvider>,
    );

    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(mocks.checkPaths).not.toHaveBeenCalled();
  });

  it('deduplicates multiple mounted consumers of the same target', async () => {
    vi.useFakeTimers();
    mocks.checkPaths.mockResolvedValue({
      results: { 'docs/shared.md': { exists: true, type: 'file' } },
    });
    render(
      <FileActionProvider workspacePath="/workspace">
        <Probe testId="state-a" target={{ scope: 'workspace', path: 'docs/shared.md' }} />
        <Probe testId="state-b" target={{ scope: 'workspace', path: 'docs/shared.md' }} />
      </FileActionProvider>,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(mocks.checkPaths).toHaveBeenCalledTimes(1);
    expect(mocks.checkPaths).toHaveBeenCalledWith('/workspace', { paths: ['docs/shared.md'] });
    expect(screen.getByTestId('state-a')).toHaveTextContent('available');
    expect(screen.getByTestId('state-b')).toHaveTextContent('available');
  });

  it('invalidates the same workspace on a controlled refresh generation', async () => {
    vi.useFakeTimers();
    mocks.checkPaths
      .mockResolvedValueOnce({ results: { 'docs/a.md': { exists: true, type: 'file' } } })
      .mockResolvedValueOnce({ results: { 'docs/a.md': { exists: false, type: 'file' } } });
    const view = render(
      <FileActionProvider workspacePath="/workspace" refreshTrigger={0}>
        <Probe target={{ scope: 'workspace', path: 'docs/a.md' }} />
      </FileActionProvider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(screen.getByTestId('state')).toHaveTextContent('available');

    view.rerender(
      <FileActionProvider workspacePath="/workspace" refreshTrigger={1}>
        <Probe target={{ scope: 'workspace', path: 'docs/a.md' }} />
      </FileActionProvider>,
    );
    expect(screen.getByTestId('state')).toHaveTextContent('pending');
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(screen.getByTestId('state')).toHaveTextContent('unavailable');
  });

  it('closes an authorized file menu when the workspace identity changes', async () => {
    mocks.checkPaths.mockImplementation((workspace: string, args: { paths: string[] }) => ({
      results: Object.fromEntries(args.paths.map((path) => [
        path,
        { exists: workspace === '/workspace-a', type: 'file' as const },
      ])),
    }));
    const target: FileActionTarget = { scope: 'workspace', path: 'docs/a.md' };
    const view = render(
      <FileActionProvider workspacePath="/workspace-a">
        <MenuProbe target={target} />
      </FileActionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('open-menu')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('open-menu'));
    await waitFor(() => expect(screen.getByTestId('file-context-menu')).toBeInTheDocument());

    view.rerender(
      <FileActionProvider workspacePath="/workspace-b">
        <MenuProbe target={target} />
      </FileActionProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('file-context-menu')).not.toBeInTheDocument());
  });

  it('does not renew an early local chunk while a later 200-path chunk is stalled', async () => {
    vi.useFakeTimers();
    const stalledTail = deferred<{ results: Record<string, { exists: boolean; type: 'file' }> }>();
    let largeChunkCall = 0;
    mocks.checkLocalPaths.mockImplementation((_: string, args: { paths: string[] }) => {
      if (args.paths.length === 1) return stalledTail.promise;
      largeChunkCall += 1;
      return Promise.resolve({
        results: Object.fromEntries(args.paths.map((path) => [
          path,
          { exists: largeChunkCall === 1, type: 'file' as const },
        ])),
      });
    });
    const targets = Array.from({ length: 201 }, (_, index) => `/Users/me/${index}.md`);

    render(
      <FileActionProvider workspacePath="/workspace">
        {targets.map((path, index) => (
          <Probe key={path} testId={`local-${index}`} target={{ scope: 'local', path }} />
        ))}
      </FileActionProvider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(screen.getByTestId('local-0')).toHaveTextContent('available');

    await act(async () => { await vi.advanceTimersByTimeAsync(30_060); });
    expect(screen.getByTestId('local-0')).toHaveTextContent('unavailable');
    expect(largeChunkCall).toBe(2);

    stalledTail.resolve({ results: { [targets[200]]: { exists: false, type: 'file' } } });
    await stalledTail.promise;
  });
});
