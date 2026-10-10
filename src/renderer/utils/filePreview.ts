import type { WorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import type { FilePreviewTarget } from '@/types/filePreview';
import { getRichDocKind, type RichDocKind } from '../../shared/fileTypes';

export interface LoadedFilePreview extends FilePreviewTarget {
  content: string;
  size: number;
  richDocKind?: RichDocKind;
}

export type ResolvedFilePreview =
  | { kind: 'browser'; target: FilePreviewTarget; url: string }
  | { kind: 'file'; file: LoadedFilePreview };

/** Decide the consumer before loading its data. Native HTML browsing needs a
 * validated path; only source/line intents need bounded text over IPC. */
export async function resolveFilePreview(
  service: Pick<WorkspaceFileService, 'readPreview' | 'readLocalPreview' | 'resolvePreviewPath' | 'resolveLocalPreviewPath'>,
  target: FilePreviewTarget,
  browserEnabled: boolean,
): Promise<ResolvedFilePreview> {
  const local = target.sourceScope === 'local';
  const localPath = target.localPath ?? target.path;
  if (browserEnabled && /\.html?$/i.test(target.name) &&
      !target.focusTarget && target.initialLineNumber === undefined && !target.initialEditMode) {
    const url = local
      ? await service.resolveLocalPreviewPath({ fullPath: localPath })
      : await service.resolvePreviewPath({ path: target.path });
    return { kind: 'browser', target, url };
  }
  const richDocKind = getRichDocKind(target.name);
  if (richDocKind) {
    return { kind: 'file', file: { ...target, content: '', size: 0, richDocKind } };
  }
  const loaded = local
    ? await service.readLocalPreview({ fullPath: localPath })
    : await service.readPreview({ path: target.path });
  return { kind: 'file', file: { ...target, ...loaded } };
}

/** Tauri Result<_, String> rejects with a string, not necessarily an Error. */
export function filePreviewErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
