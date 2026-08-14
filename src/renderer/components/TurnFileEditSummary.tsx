import { FilePenLine } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import Tip from '@/components/Tip';
import { Popover } from '@/components/ui/Popover';
import { useFileAction } from '@/context/FileActionContext';
import type { Message } from '@/types/chat';
import {
  deriveTurnFileEdits,
  type TurnFileEditItem,
} from '@/utils/turnFileEdits';
import { resolveFileActionTarget } from '@/utils/workspaceFileLinks';

export function TurnFileEditSummary({ content }: { content: Message['content'] }) {
  const { t } = useTranslation('app');
  const fileAction = useFileAction();
  const summary = useMemo(
    () => deriveTurnFileEdits(content, fileAction?.workspacePath),
    [content, fileAction?.workspacePath],
  );
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  if (!summary) return null;

  const capsuleLabel = t('message.turnFileEdits.summary', {
    count: summary.files.length,
  });
  const showTotals = summary.allStatsReliable
    && (summary.totalAdded > 0 || summary.totalRemoved > 0);
  const closeAndRestoreFocus = () => {
    setOpen(false);
    anchorRef.current?.focus();
  };

  return (
    <>
      <Tip label={capsuleLabel} disabled={open}>
        <button
          ref={anchorRef}
          type="button"
          className="flex h-7 max-w-full items-center gap-1.5 rounded-full px-2 text-sm text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          aria-expanded={open}
          aria-controls={popoverId}
          onClick={() => setOpen((current) => !current)}
        >
          <FilePenLine className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{capsuleLabel}</span>
          {showTotals && (
            <span className="shrink-0 font-mono text-xs text-[var(--ink-muted)]/80">
              <span className="text-[var(--success)]">+{summary.totalAdded}</span>
              {' '}
              <span className="text-[var(--error)]">−{summary.totalRemoved}</span>
            </span>
          )}
        </button>
      </Tip>
      <Popover
        open={open}
        onClose={closeAndRestoreFocus}
        anchorRef={anchorRef}
        placement="top-start"
        offset={6}
        className="w-[min(380px,calc(100vw-24px))]"
      >
        <div id={popoverId} role="dialog" aria-label={t('message.turnFileEdits.title')}>
          <div className="border-b border-[var(--line-subtle)] px-3 py-2 text-sm font-medium text-[var(--ink)]">
            {t('message.turnFileEdits.title')}
          </div>
          <div className="max-h-80 overflow-y-auto overscroll-contain py-1">
            {summary.files.map((file) => (
              <TurnFileEditRow
                key={file.identityPath}
                file={file}
                onOpen={() => {
                  if (file.status === 'deleted' || !fileAction) return;
                  const target = resolveFileActionTarget(
                    file.displayPath,
                    fileAction.workspacePath,
                  ) ?? file.actionTarget;
                  setOpen(false);
                  fileAction.openFileTarget(target, { displayPath: file.displayPath });
                }}
              />
            ))}
          </div>
        </div>
      </Popover>
    </>
  );
}

function TurnFileEditRow({
  file,
  onOpen,
}: {
  file: TurnFileEditItem;
  onOpen: () => void;
}) {
  const { t } = useTranslation('app');
  const deleted = file.status === 'deleted';
  const { basename, parent } = splitPath(file.displayPath);
  const original = file.originalPath ? splitPath(file.originalPath) : null;
  const originalName = original?.basename ?? null;
  const parentLabel = original && original.parent !== parent
    ? `${original.parent || '.'} → ${parent || '.'}`
    : parent;
  const statusLetter = statusLetterFor(file.status);
  const statusLabel = t(`message.turnFileEdits.status.${file.status}`);

  return (
    <button
      type="button"
      disabled={deleted}
      className="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)] disabled:cursor-default disabled:opacity-65"
      aria-label={`${statusLabel}: ${file.originalPath ? `${file.originalPath} → ` : ''}${file.displayPath}`}
      onClick={onOpen}
    >
      <span
        aria-hidden="true"
        className={`w-4 shrink-0 text-center font-mono text-xs font-semibold ${statusColor(file.status)}`}
      >
        {statusLetter}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1 text-sm text-[var(--ink)]">
          {originalName && (
            <>
              <span className="truncate">{originalName}</span>
              <span className="shrink-0 text-[var(--ink-muted)]">→</span>
            </>
          )}
          <span className="truncate">{basename}</span>
        </span>
        {parentLabel && (
          <span className="block truncate text-xs text-[var(--ink-muted)]/70">
            {parentLabel}
          </span>
        )}
      </span>
      <span className="shrink-0 font-mono text-xs text-[var(--ink-muted)]">
        {formatStats(file, t)}
      </span>
    </button>
  );
}

function splitPath(path: string): { basename: string; parent: string } {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return {
    basename: parts.pop() || normalized,
    parent: parts.join('/'),
  };
}

function statusLetterFor(status: TurnFileEditItem['status']): string {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  if (status === 'renamed') return 'R';
  return 'M';
}

function statusColor(status: TurnFileEditItem['status']): string {
  if (status === 'added') return 'text-[var(--success)]';
  if (status === 'deleted') return 'text-[var(--error)]';
  if (status === 'renamed') return 'text-[var(--accent)]';
  return 'text-[var(--accent-warm)]';
}

function formatStats(
  file: TurnFileEditItem,
  t: (key: string) => string,
): string {
  if (!file.statsReliable || (file.added === 0 && file.removed === 0)) {
    return file.status === 'deleted'
      ? t('message.turnFileEdits.deleted')
      : t('message.turnFileEdits.edited');
  }
  if (file.status === 'added' && file.removed === 0) return `+${file.added}`;
  if (file.status === 'deleted' && file.added === 0) return `−${file.removed}`;
  return `+${file.added} −${file.removed}`;
}
