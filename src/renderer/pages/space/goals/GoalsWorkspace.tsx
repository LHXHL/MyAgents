import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, ChevronRight, GitBranch, Loader2, Plus, RefreshCw, Save, Target } from 'lucide-react';

import type { SpaceGoal, SpaceSession } from '@/api/spaceCloud';
import { spaceErrorMessage } from '@/api/spaceCloud';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import type { SpaceActions } from '@/pages/space/spaceStore';

type GoalTreeNode = SpaceGoal & {
  children: GoalTreeNode[];
};

function buildGoalTree(goals: SpaceGoal[]): GoalTreeNode[] {
  const nodes = new Map<string, GoalTreeNode>();
  for (const goal of goals) {
    nodes.set(goal.id, { ...goal, children: [] });
  }
  const roots: GoalTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.parentGoalId ?? '';
    const parent = parentId ? nodes.get(parentId) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (items: GoalTreeNode[]) => {
    items.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.createdAt.localeCompare(b.createdAt);
    });
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  return roots;
}

function findGoal(goals: SpaceGoal[], id: string | null): SpaceGoal | null {
  if (!id) return null;
  return goals.find((goal) => goal.id === id) ?? null;
}

function isRootGoal(goal: SpaceGoal | null, session: SpaceSession): boolean {
  if (!goal) return false;
  return goal.parentGoalId == null || goal.id === session.space.rootGoalId;
}

export function GoalsWorkspace({
  admin,
  session,
  goals,
  actions,
  onRefresh,
  onOpenIssuesForGoal,
}: {
  admin: boolean;
  session: SpaceSession;
  goals: SpaceGoal[];
  actions: SpaceActions;
  onRefresh: () => Promise<void>;
  onOpenIssuesForGoal: (goalId: string) => void;
}) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const tree = useMemo(() => buildGoalTree(goals), [goals]);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(session.space.rootGoalId ?? goals[0]?.id ?? null);
  const selectedGoal = findGoal(goals, selectedGoalId) ?? goals[0] ?? null;
  const [title, setTitle] = useState(selectedGoal?.title ?? '');
  const [context, setContext] = useState(selectedGoal?.context ?? '');
  const [childTitle, setChildTitle] = useState('');
  const [childContext, setChildContext] = useState('');
  const [busy, setBusy] = useState<'refresh' | 'save' | 'create' | 'archive' | null>(null);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);

  useEffect(() => {
    if (selectedGoalId && goals.some((goal) => goal.id === selectedGoalId)) return;
    setSelectedGoalId(session.space.rootGoalId ?? goals[0]?.id ?? null);
  }, [goals, selectedGoalId, session.space.rootGoalId]);

  useEffect(() => {
    setTitle(selectedGoal?.title ?? '');
    setContext(selectedGoal?.context ?? '');
    setChildTitle('');
    setChildContext('');
  }, [selectedGoal?.id, selectedGoal?.title, selectedGoal?.context]);

  const root = goals.find((goal) => goal.id === session.space.rootGoalId) ?? tree[0] ?? null;
  const canEdit = admin && selectedGoal !== null;
  const canArchive = canEdit && !isRootGoal(selectedGoal, session);
  const dirty = selectedGoal ? title.trim() !== selectedGoal.title || context.trim() !== selectedGoal.context : false;
  const canCreateChild = canEdit && childTitle.trim().length > 0 && childContext.trim().length > 0;

  const refresh = async () => {
    setBusy('refresh');
    try {
      await onRefresh();
      toast.success(t('space.toasts.refreshed'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!selectedGoal || !dirty || busy) return;
    setBusy('save');
    try {
      const goal = await actions.updateGoal({
        goalId: selectedGoal.id,
        title: title.trim(),
        context: context.trim(),
      });
      setSelectedGoalId(goal.id);
      toast.success(t('space.toasts.goalSaved'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const createChild = async () => {
    if (!selectedGoal || !canCreateChild || busy) return;
    setBusy('create');
    try {
      const goal = await actions.createGoal({
        parentGoalId: selectedGoal.id,
        title: childTitle.trim(),
        context: childContext.trim(),
      });
      setSelectedGoalId(goal.id);
      toast.success(t('space.toasts.goalCreated'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const archive = async () => {
    if (!selectedGoal || !canArchive || busy) return;
    setBusy('archive');
    try {
      await actions.archiveGoal(selectedGoal.id);
      setArchiveConfirmOpen(false);
      setSelectedGoalId(root?.id ?? session.space.rootGoalId ?? null);
      toast.success(t('space.toasts.goalArchived'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
        <section className="flex min-h-12 items-center gap-2.5 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-1.5 backdrop-blur-md">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-xl border border-[var(--accent-warm-muted)] bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
              <GitBranch className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-[var(--ink)]">{t('space.goals.title')}</h2>
              <p className="truncate text-xs text-[var(--ink-muted)]">{t('space.goals.subtitle')}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-transparent text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            aria-label={t('space.common.refresh')}
            title={t('space.common.refresh')}
          >
            {busy === 'refresh' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </section>

        <main className="grid min-h-0 grid-cols-[360px_minmax(0,1fr)] max-lg:grid-cols-1">
          <section className="min-h-0 overflow-y-auto border-r border-[var(--line)] bg-[var(--paper)]/45 px-4 py-4 max-lg:border-b max-lg:border-r-0">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-xs font-semibold uppercase text-[var(--ink-muted)]/60">
                {t('space.goals.tree')}
              </span>
              <span className="rounded-md bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
                {t('space.goals.goalCount', { count: goals.length })}
              </span>
            </div>
            {tree.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--line)] px-3 py-4 text-sm text-[var(--ink-muted)]">
                {t('space.goals.empty')}
              </div>
            ) : (
              <div className="grid gap-1">
                {tree.map((node) => (
                  <GoalTreeRow
                    key={node.id}
                    node={node}
                    selectedGoalId={selectedGoal?.id ?? null}
                    onSelect={setSelectedGoalId}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="min-h-0 overflow-y-auto px-6 py-5">
            {selectedGoal ? (
              <div className="mx-auto grid max-w-[920px] gap-6">
                <header className="flex min-w-0 items-start justify-between gap-4 border-b border-[var(--line-subtle)] pb-4">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--ink-muted)]">
                      <Target className="h-3.5 w-3.5" />
                      <span>{selectedGoal.goalPathLabel || selectedGoal.title}</span>
                      {isRootGoal(selectedGoal, session) && (
                        <span className="rounded-md bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
                          {t('space.goals.root')}
                        </span>
                      )}
                    </div>
                    <h3 className="text-xl font-semibold text-[var(--ink)]">{selectedGoal.title}</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenIssuesForGoal(selectedGoal.id)}
                    className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/70 px-3 text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                  >
                    {t('space.goals.viewIssues')}
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </header>

                <section className="grid gap-3">
                  <div className="grid gap-1.5">
                    <label
                      className="text-xs font-semibold uppercase text-[var(--ink-muted)]/60"
                      htmlFor="space-goal-title"
                    >
                      {t('space.goals.titleLabel')}
                    </label>
                    <input
                      id="space-goal-title"
                      value={title}
                      disabled={!canEdit}
                      onChange={(event) => setTitle(event.target.value)}
                      className="h-10 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/80 px-3 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)] disabled:opacity-70"
                      placeholder={t('space.goals.titlePlaceholder')}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <label
                      className="text-xs font-semibold uppercase text-[var(--ink-muted)]/60"
                      htmlFor="space-goal-context"
                    >
                      {t('space.goals.contextLabel')}
                    </label>
                    <textarea
                      id="space-goal-context"
                      value={context}
                      disabled={!canEdit}
                      onChange={(event) => setContext(event.target.value)}
                      className="min-h-40 resize-y rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/80 px-3 py-2 text-sm leading-6 text-[var(--ink-secondary)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)] disabled:opacity-70"
                      placeholder={t('space.goals.contextPlaceholder')}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={!dirty || !canEdit || busy !== null}
                      onClick={() => void save()}
                      className="inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] shadow-sm transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      {t('space.common.save')}
                    </button>
                    {canArchive && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => setArchiveConfirmOpen(true)}
                        className="inline-flex h-9 items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/70 px-3 text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--error)] disabled:cursor-wait disabled:opacity-60"
                      >
                        {busy === 'archive' ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Archive className="h-4 w-4" />
                        )}
                        {t('space.goals.archive')}
                      </button>
                    )}
                  </div>
                </section>

                {admin && (
                  <section className="grid gap-3 border-t border-[var(--line-subtle)] pt-5">
                    <div>
                      <h4 className="text-base font-semibold text-[var(--ink)]">{t('space.goals.newChild')}</h4>
                      <p className="mt-1 text-xs text-[var(--ink-muted)]">
                        {t('space.goals.newChildHint', {
                          parent: selectedGoal.title,
                        })}
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,280px)_minmax(0,1fr)_auto] sm:items-start">
                      <input
                        value={childTitle}
                        onChange={(event) => setChildTitle(event.target.value)}
                        className="h-10 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/80 px-3 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)]"
                        placeholder={t('space.goals.childTitlePlaceholder')}
                      />
                      <textarea
                        value={childContext}
                        onChange={(event) => setChildContext(event.target.value)}
                        className="min-h-10 resize-y rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/80 px-3 py-2 text-sm leading-5 text-[var(--ink-secondary)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)]"
                        placeholder={t('space.goals.childContextPlaceholder')}
                      />
                      <button
                        type="button"
                        disabled={!canCreateChild || busy !== null}
                        onClick={() => void createChild()}
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy === 'create' ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Plus className="h-4 w-4" />
                        )}
                        {t('space.goals.createChild')}
                      </button>
                    </div>
                  </section>
                )}
              </div>
            ) : (
              <div className="grid h-full min-h-60 place-items-center text-sm text-[var(--ink-muted)]">
                {t('space.goals.empty')}
              </div>
            )}
          </section>
        </main>
      </div>
      {archiveConfirmOpen && selectedGoal && (
        <ConfirmDialog
          title={t('space.goals.archiveTitle')}
          message={t('space.goals.archiveMessage', {
            name: selectedGoal.title,
          })}
          confirmText={t('space.goals.archive')}
          cancelText={t('space.common.cancel')}
          confirmVariant="danger"
          loading={busy === 'archive'}
          disableEnterShortcut
          onConfirm={() => void archive()}
          onCancel={() => setArchiveConfirmOpen(false)}
        />
      )}
    </>
  );
}

function GoalTreeRow({
  node,
  selectedGoalId,
  onSelect,
}: {
  node: GoalTreeNode;
  selectedGoalId: string | null;
  onSelect: (goalId: string) => void;
}) {
  const selected = selectedGoalId === node.id;
  return (
    <div className="grid gap-1">
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        className={`grid min-h-9 w-full grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors ${
          selected
            ? 'bg-[var(--accent-warm-subtle)] font-semibold text-[var(--accent-warm)]'
            : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
        }`}
        style={{ paddingLeft: `${8 + Math.min(node.depth, 6) * 18}px` }}
      >
        <GitBranch className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{node.title}</span>
      </button>
      {node.children.length > 0 && (
        <div className="grid gap-1">
          {node.children.map((child) => (
            <GoalTreeRow key={child.id} node={child} selectedGoalId={selectedGoalId} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}
