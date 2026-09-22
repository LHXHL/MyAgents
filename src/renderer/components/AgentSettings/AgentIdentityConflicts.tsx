import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@/hooks/useConfig';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { apiPostJson } from '@/api/apiFetch';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import type { Project } from '@/config/types';
import { resolveAgentWorkspaceProjections } from '../../../shared/agentWorkspaceIdentity';

export default function AgentIdentityConflicts({ agentId }: { agentId?: string }) {
  const { t } = useTranslation('settings');
  const { config, projects, refreshConfig } = useConfig();
  const toast = useToast();
  const [choice, setChoice] = useState<{ agentId: string; claims: Project[] } | null>(null);
  const [error, setError] = useState('');
  const diagnostics = useMemo(() => resolveAgentWorkspaceProjections(projects, config.agents ?? []).diagnostics,
    [projects, config.agents]);
  const visible = diagnostics.filter(item => !agentId || item.agentIds.includes(agentId));
  if (!visible.length && !error) return null;

  return <section className="mb-6 space-y-3" aria-label={t('agentSettings.identity.title')}>
    {error && <p role="alert" className="break-words text-sm text-[var(--error)]">{error}</p>}
    {visible.map((diagnostic, index) => {
      const claims = projects.filter(project => diagnostic.projectIds.includes(project.id));
      const target = diagnostic.agentIds[0];
      const canChoose = diagnostic.code === 'AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS' && target
        && !diagnostics.some(other => other !== diagnostic && (other.agentIds.includes(target)
          || other.projectIds.some(id => diagnostic.projectIds.includes(id))));
      return <div key={`${diagnostic.code}-${index}`} className="rounded-xl border border-[var(--warning)] bg-[var(--paper-elevated)] p-4">
        <h3 className="text-sm font-semibold text-[var(--ink)]">{t('agentSettings.identity.title')}</h3>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">{canChoose ? t('agentSettings.identity.description') : diagnostic.message}</p>
        <p className="mt-2 break-all text-xs text-[var(--ink-subtle)]">{target}</p>
        <ul className="mt-3 space-y-2 text-sm text-[var(--ink)]">
          {claims.map((project, row) => <li key={`${project.id}-${row}`}>
            <span>{project.displayName || project.name}</span>
            <span className="block break-all text-xs text-[var(--ink-muted)]">{project.path}</span>
          </li>)}
        </ul>
        {canChoose && <button type="button" className="mt-4 rounded-full bg-[var(--button-primary-bg)] px-4 py-2 text-sm text-[var(--button-primary-text)]"
          onClick={() => { setError(''); setChoice({ agentId: target, claims }); }}>
          {t('agentSettings.identity.choose')}
        </button>}
      </div>;
    })}
    {choice && <ConflictChoiceDialog claims={choice.claims} onCancel={() => setChoice(null)} onConfirm={async keepProjectId => {
      try {
        const result = await apiPostJson<{ success: boolean; error?: string }>('/api/admin/agent/resolve-conflict', {
          agentId: choice.agentId, keepProjectId,
          expectedClaims: choice.claims.map(({ id, path }) => ({ id, path })),
        });
        if (!result.success) throw new Error(result.error || t('agentSettings.identity.failed'));
        toast.success(t('agentSettings.identity.success'));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setChoice(null);
        try { await refreshConfig(); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }
    }} />}
  </section>;
}

function ConflictChoiceDialog({ claims, onConfirm, onCancel }: {
  claims: Project[]; onConfirm: (id: string) => Promise<void>; onCancel: () => void;
}) {
  const { t } = useTranslation('settings');
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  useCloseLayer(() => { if (!busy) onCancel(); return true; }, 350);
  useEffect(() => {
    const prior = document.activeElement;
    panel.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { if (prior instanceof HTMLElement && prior.isConnected) prior.focus(); };
  }, []);
  return <OverlayBackdrop portal className="z-[350] px-4" onClose={busy ? undefined : onCancel}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId}
      className="glass-panel max-h-[85vh] w-full max-w-xl overflow-auto p-6" onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onCancel(); }
        if (event.key === 'Tab') {
          const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? []);
          const first = items[0]; const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <h2 id={titleId} className="text-lg font-semibold text-[var(--ink)]">{t('agentSettings.identity.choose')}</h2>
      <p className="mt-3 text-sm text-[var(--ink-muted)]">{t('agentSettings.identity.consequences')}</p>
      <fieldset disabled={busy} className="mt-4 space-y-2">
        <legend className="sr-only">{t('agentSettings.identity.choose')}</legend>
        {claims.map(project => <label key={project.id} className="flex cursor-pointer gap-3 rounded-lg border border-[var(--line)] p-3">
          <input type="radio" name={titleId} value={project.id} aria-label={`${project.displayName || project.name} ${project.path}`}
            checked={selected === project.id} onChange={() => setSelected(project.id)} />
          <span className="min-w-0 text-sm text-[var(--ink)]">
            {project.displayName || project.name}
            {project.hidden && <span className="ml-2 text-xs">{t('agentSettings.identity.hidden')}</span>}
            {project.archivedAt && <span className="ml-2 text-xs">{t('agentSettings.identity.archived')}</span>}
            <span className="block break-all text-xs text-[var(--ink-muted)]">{project.path}</span>
          </span>
        </label>)}
      </fieldset>
      <p className="mt-4 text-xs leading-relaxed text-[var(--ink-muted)]">{t('agentSettings.identity.defaults')}</p>
      <div className="mt-5 flex justify-end gap-3">
        <button type="button" disabled={busy} onClick={onCancel} className="rounded-full bg-[var(--button-secondary-bg)] px-4 py-2 text-sm text-[var(--ink)]">{t('agentSettings.identity.cancel')}</button>
        <button type="button" disabled={!selected || busy} onClick={async () => { setBusy(true); try { await onConfirm(selected); } finally { setBusy(false); } }}
          className="rounded-full bg-[var(--button-primary-bg)] px-4 py-2 text-sm text-[var(--button-primary-text)] disabled:opacity-50">
          {t(busy ? 'agentSettings.identity.repairing' : 'agentSettings.identity.confirm')}
        </button>
      </div>
    </div>
  </OverlayBackdrop>;
}
