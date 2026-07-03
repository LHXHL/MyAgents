import type { CSSProperties } from 'react';
import { currentSupportedLocale } from '@/i18n/format';
import { isClosedIssue } from './spaceHelpers';

export const PAPER_GRID_STYLE: CSSProperties = {
  backgroundImage:
    'linear-gradient(var(--line-subtle) 1px, var(--paper-a0) 1px), linear-gradient(90deg, var(--line-subtle) 1px, var(--paper-a0) 1px)',
  backgroundSize: '24px 24px, 24px 24px',
  maskImage: 'linear-gradient(to bottom, rgb(0 0 0 / 0) 0, #000 120px, #000 calc(100% - 120px), rgb(0 0 0 / 0) 100%)',
};

export const SPACE_BACKGROUND_STYLE: CSSProperties = {
  background:
    'linear-gradient(180deg, var(--paper-elevated), var(--paper) 48%, color-mix(in srgb, var(--paper) 86%, var(--paper-inset)) 100%), var(--paper)',
};

export const SPACE_LIST_FRAME_CLASS = 'mx-auto max-w-4xl';
export const SPACE_TWO_COLUMN_GRID_CLASS = 'grid grid-cols-2 gap-3 max-lg:grid-cols-1';

export function formatTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(currentSupportedLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatDate(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(currentSupportedLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatBytes(value?: number | null): string {
  if (!value || value <= 0) return '0 KB';
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function statusPillClass(status: string): string {
  if (status === 'doing') return 'bg-[var(--warning-bg)] text-[var(--warning)]';
  if (status === 'todo') return 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]';
  if (status === 'done') return 'bg-[var(--success-bg)] text-[var(--success)]';
  if (isClosedIssue(status)) return 'bg-[var(--paper-inset)] text-[var(--ink-muted)]';
  return 'bg-[var(--success-bg)] text-[var(--success)]';
}
