import { useEffect, useRef, useState } from 'react';
import { GitBranch, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useTabApi } from '@/context/TabContext';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import type { RuntimeAgentWorkControl, RuntimeAgentWorkSnapshot, RuntimeAgentWorkTree } from '../../shared/types/subagent-lifecycle';

export default function DshAgentTreeDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('chat');
  const { apiGet, apiPost } = useTabApi();
  const [items, setItems] = useState<readonly RuntimeAgentWorkSnapshot[]>([]);
  const [configuration, setConfiguration] = useState<RuntimeAgentWorkTree['configuration']>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const requests = useRef({ apiGet, apiPost }); requests.current = { apiGet, apiPost };
  const pendingAction = useRef<RuntimeAgentWorkControl | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useCloseLayer(() => { if (busy) return false; onClose(); return true; }, 220);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await requests.current.apiGet<{ success: boolean; items: RuntimeAgentWorkSnapshot[]; configuration?: RuntimeAgentWorkTree['configuration']; error?: string }>('/api/session/agent-work', { signal: controller.signal });
        if (!result.success || !Array.isArray(result.items)) throw new Error(result.error ?? 'Agent work is unavailable');
        if (!controller.signal.aborted) { setItems(result.items); setConfiguration(result.configuration); setLoading(false); }
      } catch (error) {
        if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : String(error)); setLoading(false); }
      } finally { if (!controller.signal.aborted) timer = setTimeout(() => { void load(); }, 2000); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  const control = async (item: RuntimeAgentWorkSnapshot, kind: RuntimeAgentWorkControl['kind']) => {
    if (busy || (kind === 'message' && item.handleState !== 'open')) return;
    if (kind !== 'message' && item.handleRevision === undefined) return;
    const previous = pendingAction.current;
    const same = previous?.agentId === item.agentId && previous.kind === kind
      && (kind === 'message' ? previous.kind === 'message' && previous.message === message : previous.kind !== 'message' && previous.expectedHandleRevision === item.handleRevision);
    const request: RuntimeAgentWorkControl = same && previous ? previous : kind === 'message'
      ? { kind, agentId: item.agentId, clientMessageId: crypto.randomUUID(), message }
      : kind === 'resume' ? { kind, agentId: item.agentId, clientRequestId: crypto.randomUUID(), expectedHandleRevision: item.handleRevision ?? 0 }
        : { kind, agentId: item.agentId, expectedHandleRevision: item.handleRevision ?? 0 };
    pendingAction.current = request; setBusy(item.agentId); setError(''); setNotice('');
    try {
      const result = await requests.current.apiPost<{ success: boolean; error?: string }>('/api/session/agent-work', request);
      if (!result.success) throw new Error(result.error ?? 'Agent action failed');
      if (!mounted.current) return;
      pendingAction.current = undefined;
      if (kind === 'message') { setSelected(undefined); setMessage(''); setNotice(t('agentTree.messageAccepted')); }
      setRefresh(value => value + 1);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setBusy(undefined); }
  };
  const byId = new Map(items.map(item => [item.agentId, item]));
  const ordered: RuntimeAgentWorkSnapshot[] = [];
  const visited = new Set<string>();
  const add = (item: RuntimeAgentWorkSnapshot) => { if (visited.has(item.agentId)) return; visited.add(item.agentId); ordered.push(item); for (const child of items) if (child.tree?.parentAgentId === item.agentId) add(child); };
  for (const item of items) if (!item.tree || !byId.has(item.tree.parentAgentId)) add(item);
  for (const item of items) add(item);
  const active = (item: RuntimeAgentWorkSnapshot) => item.handleState !== 'closed' && ['running', 'queued', 'waiting_child', 'waiting_delivery', 'waiting_interaction'].includes(item.activation?.state ?? item.status);
  const descendantsActive = (parent: RuntimeAgentWorkSnapshot) => items.some(item => {
    if (!active(item) || item.agentId === parent.agentId) return false;
    let id = item.tree?.parentAgentId; const seen = new Set<string>();
    while (id && !seen.has(id)) { if (id === parent.agentId) return true; seen.add(id); id = byId.get(id)?.tree?.parentAgentId; }
    return false;
  });
  const reportedTotal = items.reduce((sum, item) => sum + (item.totalUsage?.totalTokens ?? 0), 0);
  const partial = items.some(item => item.totalUsage === undefined);
  return <OverlayBackdrop onClose={busy ? undefined : onClose} className="z-[220] p-4" portal>
    <section role="dialog" aria-modal="true" aria-label={t('agentTree.title')} className="glass-panel flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--line)] p-5">
        <div><h2 className="flex items-center gap-2 text-base font-semibold text-[var(--ink)]"><GitBranch className="h-4 w-4" />{t('agentTree.title')} ({items.length})</h2>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">{t('agentTree.totals', { active: items.filter(active).length, tokens: items.some(item => item.totalUsage) ? reportedTotal.toLocaleString() : t('agentTree.unknown') })}{partial && items.length > 0 ? ` · ${t('agentTree.partial')}` : ''}</p>
        </div><button onClick={onClose} disabled={Boolean(busy)} aria-label={t('agentTree.close')} className="rounded-lg p-2 text-[var(--ink)]"><X className="h-4 w-4" /></button>
      </header>
      <div className="min-h-0 overflow-auto p-5">
        <p className="mb-4 text-sm text-[var(--ink-muted)]">{t('agentTree.description')}</p>
        {configuration && <p className="mb-3 text-xs text-[var(--ink-muted)]">{t('agentTree.effective', {
          depth: configuration.maxDepth, active: configuration.maxActiveChildren, retained: configuration.maxRetainedChildren,
          policy: t(`agentTree.policies.${configuration.modelPolicy}`), delivery: t(`agentTree.delivery.${configuration.messageDelivery}`),
        })}{configuration.desiredState !== 'effective' ? ` · ${t(`agentTree.config.${configuration.desiredState}`)}` : ''}</p>}
        {notice && <p role="status" className="mb-3 text-sm text-[var(--ink-secondary)]">{notice}</p>}
        {error && <p role="alert" className="mb-3 text-sm text-[var(--error)]">{error}</p>}
        {loading ? <p>{t('agentTree.loading')}</p> : items.length === 0 ? <p className="text-sm text-[var(--ink-muted)]">{t('agentTree.empty')}</p> : ordered.map(item => <article key={item.agentId} style={{ marginLeft: Math.min(7, (item.tree?.depth ?? 1) - 1) * 16 }} className="mb-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium text-[var(--ink)]">{item.description ?? item.agentType ?? item.agentId}</h3>
            <span className="text-xs text-[var(--ink-muted)]">{t(`agentTree.states.${item.handleState === 'closed' ? 'closed' : item.handleState === 'stopping' ? 'stopping' : item.activation?.state ?? item.status}`)} · #{item.activation?.ordinal ?? 1}</span>
          </div>
          {descendantsActive(item) && item.status !== 'running' && <p className="mt-1 text-xs text-[var(--accent)]">{t('agentTree.descendants')}</p>}
          <p className="mt-2 break-all text-xs text-[var(--ink-muted)]">{item.agentType} · {item.modelRoute?.provider ?? t('agentTree.unknown')} / {item.model ?? t('agentTree.unknown')}</p>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">{t('agentTree.tokens')}: {item.totalUsage?.totalTokens.toLocaleString() ?? t('agentTree.unknown')} · {t('agentTree.context')}: {item.context?.projectedInputTokens?.toLocaleString() ?? t('agentTree.unknown')} / {item.context?.capacity?.toLocaleString() ?? t('agentTree.unknown')}</p>
          <details className="mt-2 text-xs text-[var(--ink-muted)]"><summary className="cursor-pointer">{t('agentTree.details')}</summary>
            <p className="mt-1 break-all">Agent: {item.agentId}<br />Task: {item.taskId}<br />{t('agentTree.parent')}: {item.tree?.parentAgentId ?? t('agentTree.unknown')}</p>
            {item.result && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-sm text-[var(--ink-secondary)]">{item.result}</pre>}
          </details>
          <div className="mt-3 flex gap-2 text-sm"><button disabled={Boolean(busy) || item.handleState !== 'open'} onClick={() => { setSelected(item.agentId); setMessage(''); }} className="rounded-lg border border-[var(--line)] px-3 py-1.5 disabled:opacity-40">{t('agentTree.message')}</button>
            {item.handleState === 'closed' ? <button disabled={Boolean(busy) || item.handleRevision === undefined} onClick={() => void control(item, 'resume')} className="rounded-lg border border-[var(--line)] px-3 py-1.5 disabled:opacity-40">{t('agentTree.resume')}</button>
              : <button disabled={Boolean(busy) || item.handleRevision === undefined || item.handleState === 'stopping'} onClick={() => void control(item, 'stop')} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[var(--error)] disabled:opacity-40">{t('agentTree.stop')}</button>}
          </div>
          {selected === item.agentId && <form className="mt-3 grid gap-2" onSubmit={event => { event.preventDefault(); if (message.trim()) void control(item, 'message'); }}><textarea aria-label={t('agentTree.message')} maxLength={12000} value={message} onChange={event => setMessage(event.target.value)} className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 text-sm text-[var(--ink)]" /><button disabled={Boolean(busy) || !message.trim() || item.handleState !== 'open'} className="justify-self-end rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm text-[var(--button-primary-text)] disabled:opacity-40">{t('agentTree.send')}</button></form>}
        </article>)}
      </div>
    </section>
  </OverlayBackdrop>;
}
