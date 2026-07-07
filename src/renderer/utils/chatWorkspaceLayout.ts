export type WorkspacePanelMode = 'inline' | 'overlay';

export interface WorkspacePanelModeInput {
  isNarrowLayout: boolean;
  splitPanelVisible: boolean;
}

export function resolveWorkspacePanelMode(input: WorkspacePanelModeInput): WorkspacePanelMode {
  if (input.isNarrowLayout) return 'overlay';
  // Split preview stays a third column on wide layouts; it should not turn the
  // workspace tree into a dismissible drawer.
  return 'inline';
}
