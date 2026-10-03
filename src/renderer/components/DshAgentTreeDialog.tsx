import { useEffect, useRef, useState } from 'react';
import { GitBranchIcon, CloseIcon } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useTabApi } from '@/context/TabContext';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import type { RuntimeAgentWorkControl, RuntimeAgentWorkSnapshot, RuntimeAgentWorkTree } from '../../shared/types/subagent-lifecycle';

export default function DshAgentTreeDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('chat');
  const { apiGet, apiPost } = useTabApi();
  const [items, setItems] = useState<readonly RuntimeAgentWorkSnapshot[]>([]);
  const [taskLists, setTaskLists] = useState<RuntimeAgentWorkTree['taskLists']>([]);
  const [tasksFor, setTasksFor] = useState<string>();
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
        const path = `/api/session/agent-work${tasksFor ? `?tasksFor=${encodeURIComponent(tasksFor)}` : ''}`;
        const result = await requests.current.apiGet<{ success: boolean; items: RuntimeAgentWorkSnapshot[]; taskLists?: RuntimeAgentWorkTree['taskLists']; error?: string }>(path, { signal: controller.signal });
        if (!result.success || !Array.isArray(result.items)) throw new Error(result.error ?? 'Agent work is unavailable');
        if (!controller.signal.aborted) { setItems(result.items); setTaskLists(result.taskLists ?? []); setLoading(false); }
      } catch (error) {
        if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : String(error)); setLoading(false); }
      } finally { if (!controller.signal.aborted) timer = setTimeout(() => { void load(); }, 2000); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh, tasksFor]);
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
  const active = (item: RuntimeAgentWorkSnapshot) => item.native ? item.native.activity === 'running'
    : item.handleState !== 'closed' && ['running', 'queued', 'waiting_child', 'waiting_delivery', 'waiting_interaction'].includes(item.activation?.state ?? item.status);
  const native = items.some(item => item.native !== undefined) || Boolean(taskLists?.length);
  const board = (agentId: string, list: 'personal' | 'shared') => {
    const tasks = taskLists?.find(entry => entry.agentId === agentId && entry.list === list)?.tasks;
    if (!tasks) return null;
    return <div className="mt-3 rounded-lg bg-[var(--paper-inset)] p-3 text-sm text-[var(--ink-secondary)]">
      <p className="font-medium text-[var(--ink)]">{t(`agentTree.${list}Tasks`)} ({tasks.length})</p>
      {tasks.map(task => <div key={task.id} className="mt-2 flex flex-wrap gap-x-2 break-words">
        <span className="font-mono text-xs">{task.id}</span><span>{task.subject}</span>
        <span className="text-xs text-[var(--ink-muted)]">{t(`agentTree.taskStates.${task.status}`)}</span>
        {task.owner && <span className="text-xs">{t('agentTree.taskOwner')}: {task.owner}</span>}
        {task.offerTo?.length ? <span className="text-xs">{t('agentTree.taskOffered')}: {task.offerTo.join(', ')}</span> : null}
        {task.blockedBy?.length ? <span className="text-xs">{t('agentTree.taskBlockedBy')}: {task.blockedBy.join(', ')}</span> : null}
      </div>)}
    </div>;
  };
  const descendantsActive = (parent: RuntimeAgentWorkSnapshot) => items.some(item => {
    if (!active(item) || item.agentId === parent.agentId) return false;
    let id = item.tree?.parentAgentId; const seen = new Set<string>();
    while (id && !seen.has(id)) { if (id === parent.agentId) return true; seen.add(id); id = byId.get(id)?.tree?.parentAgentId; }
    return false;
  });
  return <OverlayBackdrop onClose={busy ? undefined : onClose} className="z-[220] p-4" portal>
    <section role="dialog" aria-modal="true" aria-label={t('agentTree.title')} className="glass-panel flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-4 border-b border-[var(--line)] p-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--ink)]"><GitBranchIcon className="h-4 w-4" />{t('agentTree.title')}<span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">{items.length}</span></h2>
        <button onClick={onClose} disabled={Boolean(busy)} aria-label={t('agentTree.close')} className="rounded-lg p-2 text-[var(--ink)]"><CloseIcon className="h-4 w-4" /></button>
      </header>
      <div className="min-h-0 overflow-auto p-5">
        {notice && <p role="status" className="mb-3 text-sm text-[var(--ink-secondary)]">{notice}</p>}
        {error && <p role="alert" className="mb-3 text-sm text-[var(--error)]">{error}</p>}
        {!loading && native && taskLists && <div className="mb-4">
          {board(taskLists[0]?.agentId ?? '', 'personal')}
          {board(taskLists[0]?.agentId ?? '', 'shared')}
        </div>}
        {loading ? <p>{t('agentTree.loading')}</p> : items.length === 0 ? <p className="text-sm text-[var(--ink-muted)]">{t('agentTree.empty')}</p> : ordered.map(item => {
          const role = item.agentType === 'general' || item.agentType === 'Explore' || item.agentType === 'Plan'
            ? t(`agentTree.roles.${item.agentType}`) : item.native ? t(`agentTree.nativeModes.${item.native.mode}`) : item.agentType ?? t('agentTree.roles.general');
          return <article key={item.agentId} style={{ marginLeft: Math.min(7, (item.tree?.depth ?? 1) - 1) * 16 }} className="mb-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 last:mb-0">
          <div className="flex items-start justify-between gap-3"><h3 className="min-w-0 break-words text-base font-semibold text-[var(--ink)]">{item.description || role}</h3>
            <span className={`shrink-0 rounded-full bg-[var(--paper-inset)] px-2 py-1 text-xs ${active(item) ? 'text-[var(--accent)]' : 'text-[var(--ink-secondary)]'}`}>{item.native ? t(`agentTree.nativeStates.${item.native.activity}`) : t(`agentTree.states.${item.handleState === 'closed' ? 'closed' : item.handleState === 'stopping' ? 'stopping' : item.activation?.state ?? item.status}`)}</span>
          </div>
          {descendantsActive(item) && item.status !== 'running' && <p className="mt-1 text-xs text-[var(--accent)]">{t('agentTree.descendants')}</p>}
          <p className="mt-1 flex min-w-0 items-center gap-2 text-xs text-[var(--ink-muted)]"><span className="shrink-0">{role}</span>{item.model && <><span aria-hidden="true">·</span><span className="truncate" title={item.model}>{item.model}</span></>}</p>
          {item.native && <><button onClick={() => setTasksFor(value => value === item.agentId ? undefined : item.agentId)} className="mt-3 text-sm text-[var(--accent)]">{t('agentTree.personalTasks')}</button>{tasksFor === item.agentId && board(item.agentId, 'personal')}</>}
          <details className="mt-3 text-xs text-[var(--ink-muted)]"><summary className="w-fit cursor-pointer rounded-sm hover:text-[var(--ink)]">{t('agentTree.details')}</summary>
            <div className="mt-3 space-y-3 border-t border-[var(--line)] pt-3">
              {item.result && <div><p className="mb-1 font-medium text-[var(--ink-secondary)]">{t('agentTree.latestResult')}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm text-[var(--ink-secondary)]">{item.result}</pre></div>}
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
                {!item.native && <><dt>{t('agentTree.provider')}</dt><dd className="break-all">{item.modelRoute?.provider ?? t('agentTree.unknown')}</dd>
                <dt>{t('agentTree.model')}</dt><dd className="break-all">{item.model ?? t('agentTree.unknown')}</dd>
                <dt>{t('agentTree.tokens')}</dt><dd>{item.totalUsage?.totalTokens.toLocaleString() ?? t('agentTree.unknown')}</dd>
                <dt>{t('agentTree.context')}</dt><dd>{item.context?.projectedInputTokens?.toLocaleString() ?? t('agentTree.unknown')} / {item.context?.capacity?.toLocaleString() ?? t('agentTree.unknown')}</dd>
                <dt>{t('agentTree.activation')}</dt><dd>{item.activation?.ordinal ?? 1}</dd></>}
                <dt>Agent ID</dt><dd className="break-all">{item.agentId}</dd>
                {!item.native && <><dt>Task ID</dt><dd className="break-all">{item.taskId}</dd></>}
                <dt>{t('agentTree.parent')}</dt><dd className="break-all">{item.tree?.parentAgentId ?? t('agentTree.unknown')}</dd>
              </dl>
            </div>
          </details>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">{item.handleState !== 'closed' && <button disabled={Boolean(busy) || item.handleState !== 'open'} onClick={() => { setSelected(item.agentId); setMessage(''); }} className="rounded-lg border border-[var(--line)] px-3 py-1.5 hover:bg-[var(--paper-inset)] disabled:opacity-40">{t('agentTree.message')}</button>}
            {item.native ? active(item) && item.native.mode === 'continuable' && <button disabled={Boolean(busy)} onClick={() => void control(item, 'stop')} className="rounded-lg px-3 py-1.5 text-[var(--error)] hover:bg-[var(--paper-inset)] disabled:opacity-40">{t('agentTree.interruptTurn')}</button>
              : item.handleState === 'closed' ? <button disabled={Boolean(busy) || item.handleRevision === undefined} onClick={() => void control(item, 'resume')} className="rounded-lg border border-[var(--line)] px-3 py-1.5 disabled:opacity-40">{t('agentTree.resume')}</button>
              : <button disabled={Boolean(busy) || item.handleRevision === undefined || item.handleState === 'stopping'} onClick={() => void control(item, 'stop')} className="rounded-lg px-3 py-1.5 text-[var(--error)] hover:bg-[var(--paper-inset)] disabled:opacity-40">{t('agentTree.stop')}</button>}
          </div>
          {selected === item.agentId && <form className="mt-3 grid gap-2" onSubmit={event => { event.preventDefault(); if (message.trim()) void control(item, 'message'); }}><textarea aria-label={t('agentTree.message')} maxLength={12000} value={message} onChange={event => setMessage(event.target.value)} className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 text-sm text-[var(--ink)]" /><button disabled={Boolean(busy) || !message.trim() || item.handleState !== 'open'} className="justify-self-end rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm text-[var(--button-primary-text)] disabled:opacity-40">{t('agentTree.send')}</button></form>}
        </article>;
        })}
      </div>
    </section>
  </OverlayBackdrop>;
}
