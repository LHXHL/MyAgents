import { describe, expect, it } from 'vitest';

import { resolveWorkspacePanelMode } from './chatWorkspaceLayout';

describe('resolveWorkspacePanelMode', () => {
  it('keeps the workspace tree inline while a split preview is open on wide layouts', () => {
    expect(resolveWorkspacePanelMode({
      isNarrowLayout: false,
      splitPanelVisible: true,
    })).toBe('inline');
  });

  it('uses the overlay drawer on narrow layouts', () => {
    expect(resolveWorkspacePanelMode({
      isNarrowLayout: true,
      splitPanelVisible: true,
    })).toBe('overlay');
  });
});
