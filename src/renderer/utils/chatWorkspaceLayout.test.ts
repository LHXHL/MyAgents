import { describe, expect, it } from 'vitest';

import { DEFAULT_WORKSPACE_LAYOUT_METRICS, resolveWorkspacePanelMode } from './chatWorkspaceLayout';

const baseInput = {
  ...DEFAULT_WORKSPACE_LAYOUT_METRICS,
  splitPanelVisible: false,
  splitRatio: 0.5,
};

describe('resolveWorkspacePanelMode', () => {
  it('keeps the workspace tree inline when the remaining chat width reaches the content threshold', () => {
    expect(resolveWorkspacePanelMode({
      ...baseInput,
      viewportWidthPx: 960,
    })).toBe('inline');
  });

  it('uses the overlay drawer when inline workspace would squeeze chat below the content threshold', () => {
    expect(resolveWorkspacePanelMode({
      ...baseInput,
      viewportWidthPx: 959,
    })).toBe('overlay');
  });

  it('includes the active split ratio when a split preview is open', () => {
    expect(resolveWorkspacePanelMode({
      ...baseInput,
      viewportWidthPx: 1920,
      splitPanelVisible: true,
      splitRatio: 0.5,
    })).toBe('inline');

    expect(resolveWorkspacePanelMode({
      ...baseInput,
      viewportWidthPx: 1920,
      splitPanelVisible: true,
      splitRatio: 0.49,
    })).toBe('overlay');
  });

  it('ignores split ratio when the split preview is closed', () => {
    expect(resolveWorkspacePanelMode({
      ...baseInput,
      viewportWidthPx: 1200,
      splitPanelVisible: false,
      splitRatio: 0.2,
    })).toBe('inline');
  });
});
