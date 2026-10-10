import { describe, expect, it, vi } from 'vitest';
import { resolveFilePreview, filePreviewErrorMessage } from './filePreview';

function service() {
  return {
    readPreview: vi.fn().mockResolvedValue({ name: 'report.html', content: 'fresh', size: 5 }),
    readLocalPreview: vi.fn().mockResolvedValue({ name: 'report.html', content: 'local', size: 5 }),
    resolvePreviewPath: vi.fn().mockResolvedValue('/workspace/report.html'),
    resolveLocalPreviewPath: vi.fn().mockResolvedValue('/external/report.html'),
  };
}

describe('file preview consumer selection', () => {
  it.each(['report.html', 'report.htm', 'report.HTML'])('opens %s by validated path without reading source', async (name) => {
    const files = service();
    files.readPreview.mockRejectedValue('File too large for source preview');
    const resolved = await resolveFilePreview(files, { name, path: name }, true);
    expect(resolved.kind).toBe('browser');
    expect(files.resolvePreviewPath).toHaveBeenCalledWith({ path: name });
    expect(files.readPreview).not.toHaveBeenCalled();
  });

  it('uses the local lane for ordinary files outside the workspace', async () => {
    const files = service();
    expect(await resolveFilePreview(files, {
      name: 'report.html', path: '/external/report.html', sourceScope: 'local',
    }, true)).toMatchObject({ kind: 'browser', url: '/external/report.html' });
    expect(files.resolveLocalPreviewPath).toHaveBeenCalledWith({ fullPath: '/external/report.html' });
    expect(files.readLocalPreview).not.toHaveBeenCalled();
    expect(files.resolvePreviewPath).not.toHaveBeenCalled();
  });

  it.each([
    { initialLineNumber: 2 },
    { focusTarget: { requestId: 1, lineNumber: 2 } },
    { initialEditMode: true },
  ])('loads bounded source for an explicit source intent: %j', async (intent) => {
    const files = service();
    const target = { name: 'report.html', path: 'report.html', ...intent };
    expect(await resolveFilePreview(files, target, true)).toMatchObject({ kind: 'file', file: { ...intent, content: 'fresh' } });
    expect(files.readPreview).toHaveBeenCalledWith({ path: 'report.html' });
    expect(files.resolvePreviewPath).not.toHaveBeenCalled();
  });

  it('retains bounded source preview in layouts without browser routing', async () => {
    const files = service();
    expect((await resolveFilePreview(files, { name: 'report.html', path: 'report.html' }, false)).kind).toBe('file');
    expect(files.readPreview).toHaveBeenCalledTimes(1);
  });

  it('surfaces a source rejection without supplying stale or empty source', async () => {
    const files = service();
    files.readPreview.mockRejectedValue('4037468 bytes exceeds 2 MiB');
    await expect(resolveFilePreview(files, { name: 'report.html', path: 'report.html', initialEditMode: true }, true))
      .rejects.toBe('4037468 bytes exceeds 2 MiB');
  });

  it('preserves regular text and deferred rich-document loading', async () => {
    const files = service();
    expect((await resolveFilePreview(files, { name: 'notes.md', path: 'notes.md' }, true)).kind).toBe('file');
    files.readPreview.mockClear();
    expect(await resolveFilePreview(files, { name: 'report.pdf', path: 'report.pdf' }, true))
      .toMatchObject({ kind: 'file', file: { richDocKind: 'pdf', content: '' } });
    expect(files.readPreview).not.toHaveBeenCalled();
  });

  it('preserves Tauri string and Error diagnostics', () => {
    expect(filePreviewErrorMessage('max 2 MiB')).toBe('max 2 MiB');
    expect(filePreviewErrorMessage(new Error('not readable'))).toBe('not readable');
  });
});
