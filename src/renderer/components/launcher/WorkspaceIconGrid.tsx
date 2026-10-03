/**
 * WorkspaceIconGrid — the single Agent icon library grid.
 *
 * Agent Settings and the New Agent panel both pick an Agent identity icon, and
 * users must see the exact same library in both places (set, order, default
 * first, selected style). Callers own the floating container; this component
 * owns the scrollable grid. Selecting the default icon reports `''` so callers
 * store "no icon" instead of persisting the default ID.
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { ALL_WORKSPACE_ICON_IDS, DEFAULT_WORKSPACE_ICON, resolveWorkspaceIconId } from '@/assets/workspace-icons';
import WorkspaceIcon from './WorkspaceIcon';

/** Scroll box + padding shared by every caller's floating container. */
export const WORKSPACE_ICON_GRID_PANEL_CLASS = 'max-h-[260px] w-[320px] overflow-y-auto overscroll-contain p-2';

interface WorkspaceIconGridProps {
  /** Current icon ID (empty / undefined = default). */
  value: string | undefined;
  /** Receives the chosen icon ID, or `''` for the default icon. */
  onSelect: (iconId: string) => void;
}

export default memo(function WorkspaceIconGrid({ value, onSelect }: WorkspaceIconGridProps) {
  const { t } = useTranslation('settings');
  const selected = resolveWorkspaceIconId(value);
  const ids = [DEFAULT_WORKSPACE_ICON, ...ALL_WORKSPACE_ICON_IDS.filter((id) => id !== DEFAULT_WORKSPACE_ICON)];

  return (
    <div className="flex flex-wrap gap-1.5">
      {ids.map((iconId) => (
        <button
          key={iconId}
          type="button"
          aria-pressed={selected === iconId}
          onClick={() => onSelect(iconId === DEFAULT_WORKSPACE_ICON ? '' : iconId)}
          className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
            selected === iconId
              ? 'bg-[var(--accent-warm-muted)] ring-1 ring-[var(--accent-warm)]'
              : 'hover:bg-[var(--hover-bg)]'
          }`}
          title={iconId === DEFAULT_WORKSPACE_ICON ? t('agentSettings.basics.defaultIcon') : iconId}
        >
          <WorkspaceIcon icon={iconId} size={20} />
        </button>
      ))}
    </div>
  );
});
