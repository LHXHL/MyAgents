import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeListItem, VisibleTreeRow } from '../workspace-tree/treeTypes';
import DirectoryPanel from './DirectoryPanel';

const mocks = vi.hoisted(() => ({
  files: {
    isAvailable: true,
    dirTree: vi.fn(),
    gitBranch: vi.fn().mockResolvedValue({ branch: null }),
    readPreview: vi.fn(),
  },
}));
vi.mock('@/hooks/useWorkspaceFileService', () => ({ useWorkspaceFileService: () => mocks.files }));
vi.mock('@/context/TabContext', () => ({ useTabApi: () => ({}) }));
vi.mock('@/context/ImagePreviewContext', () => ({ useImagePreview: () => ({ openPreview: vi.fn() }) }));
vi.mock('@/hooks/useWorkspaceChangeSignal', () => ({ useWorkspaceChangeSignal: () => 0 }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock('../AgentCapabilitiesPanel', () => ({ default: () => null }));
// Replace virtual layout, while exercising the actual directory click/routing.
vi.mock('../workspace-tree/WorkspaceTreeViewport', () => ({
  WorkspaceTreeViewport: ({ items, onRowClick }: {
    items: TreeListItem[];
    onRowClick: (row: VisibleTreeRow, event: React.MouseEvent) => void;
  }) => <>{items.map(item => item.kind === 'node' &&
    <button key={item.row.path} onClick={event => onRowClick(item.row, event)}>{item.row.data.name}</button>)}</>,
}));

describe('directory preview delegation', () => {
  beforeEach(() => {
    mocks.files.dirTree.mockResolvedValue({
      root: '/workspace', summary: { totalFiles: 1, totalDirs: 0 }, truncated: false,
      tree: { id: 'root', name: 'workspace', path: '', type: 'dir', children: [
        { id: 'report', name: 'report.html', path: 'report.html', type: 'file' },
      ] },
    });
    mocks.files.readPreview.mockRejectedValue('max 2 MiB');
  });

  it('sends an HTML target to Chat without a source-read gate', async () => {
    const preview = vi.fn();
    render(<DirectoryPanel agentDir="/workspace" onFilePreviewExternal={preview} />);
    fireEvent.click(await screen.findByRole('button', { name: 'report.html' }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith(
      { name: 'report.html', path: 'report.html' },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    ));
    expect(mocks.files.readPreview).not.toHaveBeenCalled();
  });
});
