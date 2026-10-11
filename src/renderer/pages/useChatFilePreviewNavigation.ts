import { useCallback, useEffect, useRef } from 'react';
import type { FilePreviewOptions, FilePreviewTarget } from '@/types/filePreview';
import { resolveFilePreview, type ResolvedFilePreview } from '@/utils/filePreview';

/** Chat's existing navigation generation covers both file requests and panel
 * selections. Loading never acquires authority to undo a newer user action. */
export function useChatFilePreviewNavigation({
  service, workspacePath, browserEnabled, prepareTransition, present,
}: {
  service: Parameters<typeof resolveFilePreview>[0];
  workspacePath: string | null;
  browserEnabled: boolean;
  prepareTransition: (path: string) => Promise<boolean>;
  present: (preview: ResolvedFilePreview) => void;
}) {
  const generation = useRef(0);
  const cancel = useCallback(() => { ++generation.current; }, []);
  useEffect(() => cancel, [cancel, workspacePath, browserEnabled]);

  const open = useCallback(async (target: FilePreviewTarget, options?: FilePreviewOptions) => {
    const request = ++generation.current;
    const isCurrent = () => request === generation.current && (options?.isCurrent?.() ?? true);
    if (!isCurrent()) return;
    try {
      const resolved = await resolveFilePreview(service, {
        ...target, initialEditMode: options?.initialEditMode ?? target.initialEditMode,
      }, browserEnabled);
      if (!isCurrent() || !await prepareTransition(target.path) || !isCurrent()) return;
      present(resolved);
    } catch (error) {
      if (isCurrent()) throw error;
    }
  }, [service, browserEnabled, prepareTransition, present]);

  return { open, cancel };
}
