import { act, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import MarkdownEditor, { type MarkdownEditorHandle } from './MarkdownEditor';
vi.mock('@/hooks/useTauriFileDrop', () => ({ useTauriFileDrop: () => ({ registerZone: vi.fn(), unregisterZone: vi.fn() }) }));
vi.mock('@/hooks/useWorkspaceFileService', () => ({ useWorkspaceFileService: () => ({ isAvailable: false }) }));
vi.mock('@/context/BrowserPanelContext', () => ({ useOpenWebLink: () => vi.fn() }));
vi.mock('@/context/fileActionState', () => ({ useFileLinkAction: () => null, useFileAction: () => null, useFileTargetInfo: () => null }));
vi.mock('../Toast', () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock('@/theme', () => {
  const theme = { adapters: { prism: {} }, resolvedColorScheme: 'light' };
  return { useResolvedTheme: () => theme };
});
beforeAll(async () => {
  // This is a rendering/sanitization contract test, not a cold chunk timing test.
  await import('../Markdown');
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 10, 20);
});
describe('live projections through the real sanitized Markdown pipeline', () => {
  it('renders supported HTML and math while keeping source and removing unsafe HTML attributes', async () => {
    const source = 'Hello <kbd onclick="alert(1)">Ctrl</kbd> and <mark>highlight</mark>.\n\n$$ x^2 $$\n\n> $$\n> E=mc^2\n> $$\n\n- $$\n  a+b\n  $$';
    const ref = createRef<MarkdownEditorHandle>();
    const { rerender } = render(<MarkdownEditor ref={ref} path="notes.md" initialSource={source} sourceMode={false} allowImages={false} onChange={vi.fn()} onSave={vi.fn()} />);
    await waitFor(() => expect(document.querySelectorAll('.katex')).toHaveLength(3));
    expect(document.querySelector('kbd')?.textContent).toBe('Ctrl');
    expect(document.querySelector('kbd')?.hasAttribute('onclick')).toBe(false);
    expect(document.querySelector('mark')?.textContent).toBe('highlight');
    expect(ref.current?.getSource()).toBe(source);
    await act(async () => rerender(<MarkdownEditor ref={ref} path="notes.md" initialSource={source} sourceMode allowImages={false} onChange={vi.fn()} onSave={vi.fn()} />));
    expect(document.querySelector('.katex')).toBeNull();
    expect(ref.current?.getSource()).toBe(source);
  });
});
