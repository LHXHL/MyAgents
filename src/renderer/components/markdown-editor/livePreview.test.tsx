import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusedField, livePreview, sourceBlock } from './livePreview';

// jsdom cannot reproduce browser line wrapping. Exercise the scheduling boundary
// with a real CM view, leaving actual geometry convergence to the browser smoke.
function fixture() {
  type Request = NonNullable<Parameters<EditorView['requestMeasure']>[0]>;
  const requests: Request[] = [];
  vi.spyOn(EditorView.prototype, 'requestMeasure').mockImplementation(request => {
    if (request) requests.push(request);
  });
  const view = new EditorView({ state: EditorState.create({
    doc: 'x'.repeat(12000), extensions: [sourceBlock, focusedField, livePreview()],
  }) });
  document.body.append(view.dom);
  vi.spyOn(view.scrollDOM, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 800));
  let reading = false;
  const coords = vi.spyOn(view, 'posAtCoords').mockImplementation(point => {
    expect(reading).toBe(true);
    // A geometry read may synchronously notify the plugin again. It must still
    // belong to the pending request rather than enqueue another microtask read.
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    return point.y < 400 ? 5000 : 8000;
  });
  const dispatch = vi.spyOn(view, 'dispatch');
  const read = () => {
    const request = requests.shift()!;
    reading = true;
    const region = request.read(view);
    reading = false;
    return () => request.write?.(region, view);
  };
  return { view, requests, coords, dispatch, read };
}

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe('live projection measurement lifecycle', () => {
  it('reads geometry only in CM measure phase and coalesces reentrant requests until commit', async () => {
    const { view, requests, coords, dispatch, read } = fixture();
    try {
      await Promise.resolve();
      expect(coords).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      const write = read();
      expect(coords).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(0);
      write();
      expect(dispatch).not.toHaveBeenCalled();
      view.scrollDOM.dispatchEvent(new Event('scroll'));
      expect(requests).toHaveLength(0);
      await Promise.resolve();
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(coords).toHaveBeenCalledTimes(2);
    } finally { view.destroy(); }
  });

  it.each(['edit', 'destroy'] as const)('does not commit coordinates after %s invalidates their document', async invalidation => {
    const { view, requests, dispatch, read } = fixture();
    const write = read();
    write();
    if (invalidation === 'edit') view.dispatch({ changes: { from: 0, insert: 'new' } });
    else view.destroy();
    dispatch.mockClear();
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    expect(requests).toHaveLength(invalidation === 'edit' ? 1 : 0);
    if (invalidation === 'edit') view.destroy();
  });
});
