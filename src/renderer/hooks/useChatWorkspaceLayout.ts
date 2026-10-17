import { useLayoutEffect, useState } from 'react';
import {
  DEFAULT_WORKSPACE_LAYOUT_METRICS,
  resolveWorkspacePanelMode,
  shouldPresentBrowserFullscreen,
  type WorkspacePanelMode,
} from '@/utils/chatWorkspaceLayout';

interface ChatLayoutOptions {
  splitViewEnabled: boolean;
  splitPanelVisible: boolean;
  splitRatio: number;
  browserPresented: boolean;
  onResize?: () => void;
}

interface ChatLayout {
  ready: boolean;
  isNarrowLayout: boolean;
  browserUsesFullscreen: boolean;
  workspacePanelMode: WorkspacePanelMode;
}

/** Observe the stable outer Chat box, not a pane that our own policy resizes.
 * Publish only changed layout decisions, so dragging doesn't rerender Chat at
 * every pixel. Hidden Tabs keep their last valid geometry until visible again.
 */
export function useChatWorkspaceLayout({
  splitViewEnabled, splitPanelVisible, splitRatio, browserPresented, onResize,
}: ChatLayoutOptions) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<ChatLayout>({
    ready: false, isNarrowLayout: true, browserUsesFullscreen: false, workspacePanelMode: 'overlay',
  });
  useLayoutEffect(() => {
    if (!container) return;
    let previousWidth: number | null = null;
    const measure = () => {
      const width = container.getBoundingClientRect().width;
      if (!Number.isFinite(width) || width <= 0) return;
      if (previousWidth !== null && width !== previousWidth) onResize?.();
      previousWidth = width;
      const style = getComputedStyle(container);
      const token = (name: string, fallback: number) => {
        const value = Number.parseFloat(style.getPropertyValue(name));
        return Number.isFinite(value) && value > 0 ? value : fallback;
      };
      const contentMinWidthPx = token('--breakpoint-mobile', DEFAULT_WORKSPACE_LAYOUT_METRICS.contentMinWidthPx);
      const isNarrowLayout = width < contentMinWidthPx;
      const browserUsesFullscreen = shouldPresentBrowserFullscreen({
        browserPresented, splitViewEnabled, narrowLayout: isNarrowLayout,
      });
      const workspacePanelMode = resolveWorkspacePanelMode({
        containerWidthPx: width,
        splitPanelVisible: splitViewEnabled && splitPanelVisible && !browserUsesFullscreen,
        splitRatio, contentMinWidthPx,
        sidebarMinWidthPx: token('--sidebar-min-width', DEFAULT_WORKSPACE_LAYOUT_METRICS.sidebarMinWidthPx),
        sidebarWidthRatio: token('--chat-workspace-panel-ratio', DEFAULT_WORKSPACE_LAYOUT_METRICS.sidebarWidthRatio),
      });
      setLayout((previous) => previous.ready
        && previous.isNarrowLayout === isNarrowLayout
        && previous.browserUsesFullscreen === browserUsesFullscreen
        && previous.workspacePanelMode === workspacePanelMode
        ? previous : { ready: true, isNarrowLayout, browserUsesFullscreen, workspacePanelMode });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, splitViewEnabled, splitPanelVisible, splitRatio, browserPresented, onResize]);
  return { ...layout, containerRef: setContainer };
}
