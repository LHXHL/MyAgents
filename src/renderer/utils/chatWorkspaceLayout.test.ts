import { describe, expect, it } from 'vitest';

import {
  createWorkspacePanelDisclosureState,
  DEFAULT_WORKSPACE_LAYOUT_METRICS,
  nextSplitViewAfterBrowserClose,
  reduceWorkspacePanelDisclosure,
  resolveWorkspacePanelMode,
  shouldPresentBrowserFullscreen,
} from './chatWorkspaceLayout';

const baseInput = {
  ...DEFAULT_WORKSPACE_LAYOUT_METRICS,
  splitPanelVisible: false,
  splitRatio: 0.5,
};

describe('workspace panel disclosure', () => {
  it('retires old animation geometry on container resize without changing user intent', () => {
    const open = reduceWorkspacePanelDisclosure(createWorkspacePanelDisclosureState(false), { type: 'open' });
    const settled = reduceWorkspacePanelDisclosure(open, { type: 'settle-layout' });
    expect(settled).toEqual({ visible: true, mounted: true, motion: null });
    expect(reduceWorkspacePanelDisclosure(settled, { type: 'settle-layout' })).toBe(settled);
    const closed = reduceWorkspacePanelDisclosure(open, { type: 'close' });
    expect(reduceWorkspacePanelDisclosure(closed, { type: 'settle-layout' }))
      .toEqual({ visible: false, mounted: false, motion: null });
  });

  it('initializes from measured space without playing an open animation', () => {
    expect(reduceWorkspacePanelDisclosure(createWorkspacePanelDisclosureState(false), { type: 'initialize', visible: true }))
      .toEqual({ visible: true, mounted: true, motion: null });
  });

  it('keeps an already-visible panel stable when reveal only needs it to stay open', () => {
    const visible = createWorkspacePanelDisclosureState(true);

    expect(reduceWorkspacePanelDisclosure(visible, { type: 'open' })).toBe(visible);
  });

  it('animates only real visibility edges and ignores a stale collapse settlement after reopen', () => {
    const hidden = createWorkspacePanelDisclosureState(false);
    const opened = reduceWorkspacePanelDisclosure(hidden, { type: 'open' });
    const closing = reduceWorkspacePanelDisclosure(opened, { type: 'close' });
    const reopened = reduceWorkspacePanelDisclosure(closing, { type: 'open' });

    expect(opened).toEqual({ visible: true, mounted: true, motion: 'expand' });
    expect(closing).toEqual({ visible: false, mounted: true, motion: 'collapse' });
    expect(reopened).toEqual({ visible: true, mounted: true, motion: 'expand' });
    expect(reduceWorkspacePanelDisclosure(reopened, { type: 'settle-close' })).toBe(reopened);
  });

  it('unmounts only after a still-current close transition settles', () => {
    const closing = reduceWorkspacePanelDisclosure(
      createWorkspacePanelDisclosureState(true),
      { type: 'close' },
    );

    expect(reduceWorkspacePanelDisclosure(closing, { type: 'settle-close' })).toEqual({
      visible: false,
      mounted: false,
      motion: 'collapse',
    });
  });
});

describe('resolveWorkspacePanelMode', () => {
  it('accounts for a proportional workspace wider than its minimum', () => {
    expect(resolveWorkspacePanelMode({ ...baseInput, containerWidthPx: 1200, sidebarWidthRatio: 0.5 })).toBe('overlay');
    expect(resolveWorkspacePanelMode({ ...baseInput, containerWidthPx: 1280, sidebarWidthRatio: 0.5 })).toBe('inline');
  });

  it('keeps the workspace tree inline when the remaining chat width reaches the content threshold', () => {
    expect(resolveWorkspacePanelMode({
      ...baseInput,
      containerWidthPx: 960,
    })).toBe('inline');
  });

  it('uses the overlay drawer when inline workspace would squeeze chat below the content threshold', () => {
    expect(resolveWorkspacePanelMode({
      ...baseInput,
      containerWidthPx: 959,
    })).toBe('overlay');
  });

  it('includes the active split ratio when a split preview is open', () => {
    expect(resolveWorkspacePanelMode({
      ...baseInput,
      containerWidthPx: 1920,
      splitPanelVisible: true,
      splitRatio: 0.5,
    })).toBe('inline');

    expect(resolveWorkspacePanelMode({
      ...baseInput,
      containerWidthPx: 1920,
      splitPanelVisible: true,
      splitRatio: 0.49,
    })).toBe('overlay');
  });

  it('ignores split ratio when the split preview is closed', () => {
    expect(resolveWorkspacePanelMode({
      ...baseInput,
      containerWidthPx: 1200,
      splitPanelVisible: false,
      splitRatio: 0.2,
    })).toBe('inline');
  });
});

describe('shouldPresentBrowserFullscreen', () => {
  it('keeps an open browser split only when split view has enough room', () => {
    expect(shouldPresentBrowserFullscreen({
      browserPresented: true,
      splitViewEnabled: true,
      narrowLayout: false,
    })).toBe(false);
  });

  it('uses fullscreen for an open browser when the layout is narrow or split view is disabled', () => {
    expect(shouldPresentBrowserFullscreen({
      browserPresented: true,
      splitViewEnabled: true,
      narrowLayout: true,
    })).toBe(true);
    expect(shouldPresentBrowserFullscreen({
      browserPresented: true,
      splitViewEnabled: false,
      narrowLayout: false,
    })).toBe(true);
  });

  it('does not claim fullscreen when a browser resource exists behind another active view', () => {
    expect(shouldPresentBrowserFullscreen({
      browserPresented: false,
      splitViewEnabled: false,
      narrowLayout: true,
    })).toBe(false);
  });
});

describe('nextSplitViewAfterBrowserClose', () => {
  it('hands fullscreen browser close to the surviving terminal before the file view', () => {
    expect(nextSplitViewAfterBrowserClose({
      terminalVisible: true,
      fileVisible: true,
    })).toBe('terminal');
  });

  it('falls back to a file view and returns null when no split resource survives', () => {
    expect(nextSplitViewAfterBrowserClose({
      terminalVisible: false,
      fileVisible: true,
    })).toBe('file');
    expect(nextSplitViewAfterBrowserClose({
      terminalVisible: false,
      fileVisible: false,
    })).toBeNull();
  });
});
