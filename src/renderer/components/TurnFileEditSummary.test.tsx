import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type { ContentBlock, ToolUseSimple } from '@/types/chat';
import type { FilePatchDisplayDescriptor } from '../../shared/toolDisplay/filePatch';

const fileActionMocks = vi.hoisted(() => ({
  openFileTarget: vi.fn(),
}));

vi.mock('@/context/FileActionContext', () => ({
  useFileAction: () => ({
    workspacePath: '/workspace',
    openFileTarget: fileActionMocks.openFileTarget,
  }),
}));

import { TurnFileEditSummary } from './TurnFileEditSummary';

function contentWithChanges(
  changes: FilePatchDisplayDescriptor['changes'],
): ContentBlock[] {
  const display: FilePatchDisplayDescriptor = {
    kind: 'file_patch',
    version: 1,
    source: 'codex',
    summary: {
      files: changes.length,
      added: changes.reduce((total, item) => total + item.added, 0),
      removed: changes.reduce((total, item) => total + item.removed, 0),
    },
    changes,
  };
  return [{
    type: 'tool_use',
    tool: {
      id: 'file-change',
      name: 'fileChange',
      input: {},
      result: 'completed',
      display,
    } as ToolUseSimple,
  }];
}

function change(
  path: string,
  kind: string,
  added: number,
  removed: number,
  movePath?: string,
): FilePatchDisplayDescriptor['changes'][number] {
  return {
    path,
    kind,
    added,
    removed,
    ...(movePath ? { movePath } : {}),
    view: { kind: 'unified-diff' },
  };
}

describe('TurnFileEditSummary', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('zh-CN');
  });

  it('renders a compact capsule and opens the full file list above the toolbar', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([
          change('src/a.ts', 'update', 2, 1),
          change('src/new.ts', 'add', 8, 0),
        ])}
      />,
    );

    const trigger = screen.getByRole('button', { name: /本轮编辑 2 个文件/ });
    expect(trigger).toHaveTextContent('+10');
    expect(trigger).toHaveTextContent('−1');

    fireEvent.click(trigger);

    expect(screen.getByRole('dialog', { name: '本轮文件编辑' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已修改: src/a.ts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已新增: src/new.ts' })).toBeInTheDocument();
  });

  it('closes before delegating a file row to the existing preview action', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([change('src/a.ts', 'update', 2, 1)])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /本轮编辑 1 个文件/ }));
    fireEvent.click(screen.getByRole('button', { name: '已修改: src/a.ts' }));

    expect(screen.queryByRole('dialog', { name: '本轮文件编辑' })).not.toBeInTheDocument();
    expect(fileActionMocks.openFileTarget).toHaveBeenCalledWith(
      { scope: 'workspace', path: 'src/a.ts' },
      { displayPath: 'src/a.ts' },
    );
  });

  it('keeps deleted files visible but non-clickable', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([change('src/gone.ts', 'delete', 0, 7)])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /本轮编辑 1 个文件/ }));

    expect(screen.getByRole('button', { name: '已删除: src/gone.ts' })).toBeDisabled();
  });

  it('shows both parent paths when a rename keeps the same basename', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([change('src/a.ts', 'move', 0, 0, 'tests/a.ts')])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /本轮编辑 1 个文件/ }));

    const row = screen.getByRole('button', { name: '已重命名: src/a.ts → tests/a.ts' });
    expect(row).toHaveTextContent('a.ts→a.ts');
    expect(row).toHaveTextContent('src → tests');
  });

  it('restores trigger focus when Escape dismisses the popover', () => {
    render(
      <TurnFileEditSummary
        content={contentWithChanges([change('src/a.ts', 'update', 2, 1)])}
      />,
    );
    const trigger = screen.getByRole('button', { name: /本轮编辑 1 个文件/ });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: '本轮文件编辑' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
