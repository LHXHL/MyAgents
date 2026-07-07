export type WorkspacePanelMode = 'inline' | 'overlay';

export const DEFAULT_WORKSPACE_LAYOUT_METRICS = {
  contentMinWidthPx: 640,
  sidebarMinWidthPx: 320,
} as const;

export interface WorkspacePanelModeInput {
  viewportWidthPx: number;
  splitPanelVisible: boolean;
  splitRatio: number;
  contentMinWidthPx: number;
  sidebarMinWidthPx: number;
}

export function resolveWorkspacePanelMode(input: WorkspacePanelModeInput): WorkspacePanelMode {
  const splitRatio = input.splitPanelVisible
    ? Math.min(Math.max(input.splitRatio, 0), 1)
    : 1;
  const leftPaneWidthPx = input.viewportWidthPx * splitRatio;
  const chatWidthWithInlineWorkspacePx = leftPaneWidthPx - input.sidebarMinWidthPx;
  return chatWidthWithInlineWorkspacePx >= input.contentMinWidthPx ? 'inline' : 'overlay';
}
