import { invoke } from '@tauri-apps/api/core';

export interface RendererAttachment {
  replacement: boolean;
  previousTabOwners: { sessionId: string; tabId: string }[];
}

export const COLD_RENDERER_ATTACHMENT: RendererAttachment = {
  replacement: false,
  previousTabOwners: [],
};

/** Called once by the main-window entry, before App / any TabProvider mounts. */
export function attachMainRenderer(windowLabel: string | undefined): Promise<RendererAttachment> {
  if (windowLabel !== 'main') return Promise.resolve(COLD_RENDERER_ATTACHMENT);
  return invoke('cmd_attach_main_renderer', { rendererId: crypto.randomUUID() });
}
