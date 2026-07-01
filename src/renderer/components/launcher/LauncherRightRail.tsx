import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertCircle,
    BarChart2,
    Check,
    ChevronDown,
    ChevronUp,
    FolderPlus,
    LayoutTemplate,
    Loader2,
    MoreHorizontal,
    RefreshCw,
    Search,
    Star,
    Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ConfirmDialog from '@/components/ConfirmDialog';
import SessionStatsModal from '@/components/SessionStatsModal';
import SessionTagBadge from '@/components/SessionTagBadge';
import UnreadNotificationIndicator from '@/components/UnreadNotificationIndicator';
import { useToast } from '@/components/Toast';
import { MenuItem } from '@/components/ui/MenuItem';
import { Popover } from '@/components/ui/Popover';
import type { SessionMetadata } from '@/api/sessionClient';
import type { Project } from '@/config/types';
import type { AgentStatusData } from '@/hooks/useAgentStatuses';
import type { SessionTag, TaskCenterData } from '@/hooks/useTaskCenterData';
import { normalizeWorkspacePathIdentity } from '@/../shared/workspacePath';
import type { AgentConfig } from '../../../shared/types/agent';
import { isSupportedLocale } from '../../../shared/i18n';
import { formatMessageCount, formatTime, getFolderName, getSessionDisplayText } from '@/utils/taskCenterUtils';
import AddWorkspaceMenu from './AddWorkspaceMenu';
import WorkspaceCard from './WorkspaceCard';
import WorkspaceIcon from './WorkspaceIcon';
import { sortLauncherProjects } from './workspaceSort';

const COLLAPSED_WORKSPACE_COUNT = 6;
const HISTORY_PAGE_SIZE = 30;
const WORKSPACE_ROW_MAX_HEIGHT = 94;
const EMPTY_SESSION_TAGS: SessionTag[] = [];

type HistoryFilterValue = 'all' | 'favorites' | string;

const FAVORITE_HISTORY_FILTER: HistoryFilterValue = 'favorites';

type AgentLookup = Map<string, { agent: AgentConfig; status?: AgentStatusData | undefined }>;

interface LauncherRightRailProps {
    projects: Project[];
    agentLookup: AgentLookup;
    isProjectsLoading: boolean;
    isStarting?: boolean | undefined;
    launchingProjectId: string | null;
    showDevTools?: boolean | undefined;
    taskCenterData: TaskCenterData;
    sessionNotificationBadgeCounts?: ReadonlyMap<string, number>;
    onLaunch: (project: Project) => void;
    onOpenTask: (session: SessionMetadata, project: Project) => void;
    onOpenOverlay: (mode?: 'default' | 'search') => void;
    onRemoveProject: (project: Project) => void;
    onAgentSettings: (project: Project) => void;
    onOpenProjectFolder: (project: Project) => void;
    onToggleProjectPin: (project: Project) => void;
    onAddFolder: () => void;
    onCreateFromTemplate: () => void;
    onShowLogs: () => void;
}

const getProjectDisplayName = (project: Project): string =>
    project.displayName || getFolderName(project.path);

export default memo(function LauncherRightRail({
    projects,
    agentLookup,
    isProjectsLoading,
    isStarting,
    launchingProjectId,
    showDevTools,
    taskCenterData,
    sessionNotificationBadgeCounts,
    onLaunch,
    onOpenTask,
    onOpenOverlay,
    onRemoveProject,
    onAgentSettings,
    onOpenProjectFolder,
    onToggleProjectPin,
    onAddFolder,
    onCreateFromTemplate,
    onShowLogs,
}: LauncherRightRailProps) {
    const { t } = useTranslation('launcher');
    const toast = useToast();
    const scrollRootRef = useRef<HTMLDivElement | null>(null);
    const loadMoreRef = useRef<HTMLDivElement | null>(null);
    const { sessions, cronTasks, sessionTagsMap, isLoading: isHistoryLoading, error, refresh, actions } = taskCenterData;

    const [workspacesExpanded, setWorkspacesExpanded] = useState(false);
    const [historyFilter, setHistoryFilter] = useState<HistoryFilterValue>('all');
    const [historyPage, setHistoryPage] = useState<{ scopeKey: string; count: number }>({
        scopeKey: 'all',
        count: HISTORY_PAGE_SIZE,
    });
    const [openHistoryMenuSessionId, setOpenHistoryMenuSessionId] = useState<string | null>(null);
    const [pendingDeleteSession, setPendingDeleteSession] = useState<{ id: string; title: string } | null>(null);
    const [statsSession, setStatsSession] = useState<{ id: string; title: string } | null>(null);

    const sortedProjects = useMemo(() => sortLauncherProjects(projects), [projects]);
    const projectByPathKey = useMemo(() => {
        const map = new Map<string, Project>();
        for (const project of projects) {
            map.set(normalizeWorkspacePathIdentity(project.path), project);
        }
        return map;
    }, [projects]);

    const effectiveHistoryFilter =
        historyFilter === 'all' ||
            historyFilter === FAVORITE_HISTORY_FILTER ||
            projectByPathKey.has(historyFilter)
            ? historyFilter
            : 'all';

    const handleToggleWorkspaces = useCallback(() => {
        if (workspacesExpanded) {
            setWorkspacesExpanded(false);
            scrollRootRef.current?.scrollTo({ top: 0, behavior: 'auto' });
            return;
        }
        setWorkspacesExpanded(true);
    }, [workspacesExpanded]);

    const renderedWorkspaceProjects = workspacesExpanded
        ? sortedProjects
        : sortedProjects.slice(0, COLLAPSED_WORKSPACE_COUNT);
    const hiddenWorkspaceCount = Math.max(0, sortedProjects.length - COLLAPSED_WORKSPACE_COUNT);
    const workspaceRowCount = Math.max(1, Math.ceil(
        (workspacesExpanded
            ? sortedProjects.length
            : Math.min(sortedProjects.length, COLLAPSED_WORKSPACE_COUNT)) / 2,
    ));
    const workspaceMaxHeight = `${workspaceRowCount * WORKSPACE_ROW_MAX_HEIGHT}px`;

    const filteredSessions = useMemo(() => {
        return sessions.filter((session) => {
            const key = normalizeWorkspacePathIdentity(session.agentDir);
            if (!projectByPathKey.has(key)) return false;
            if (effectiveHistoryFilter === FAVORITE_HISTORY_FILTER) return !!session.favorite;
            if (effectiveHistoryFilter !== 'all' && key !== effectiveHistoryFilter) return false;
            return true;
        });
    }, [sessions, projectByPathKey, effectiveHistoryFilter]);

    const historyScopeKey = effectiveHistoryFilter;
    const visibleHistoryCount = historyPage.scopeKey === historyScopeKey
        ? historyPage.count
        : HISTORY_PAGE_SIZE;

    const pagedSessions = useMemo(
        () => filteredSessions.slice(0, visibleHistoryCount),
        [filteredSessions, visibleHistoryCount],
    );

    const cronProtectedSessionIds = useMemo(
        () => new Set(cronTasks.filter(task => task.status === 'running').map(task => task.sessionId)),
        [cronTasks],
    );

    useEffect(() => {
        const root = scrollRootRef.current;
        const target = loadMoreRef.current;
        if (!root || !target || visibleHistoryCount >= filteredSessions.length) return;

        const observer = new IntersectionObserver(
            ([entry]) => {
                if (!entry?.isIntersecting) return;
                setHistoryPage(current => {
                    const currentCount = current.scopeKey === historyScopeKey
                        ? current.count
                        : HISTORY_PAGE_SIZE;
                    return {
                        scopeKey: historyScopeKey,
                        count: Math.min(currentCount + HISTORY_PAGE_SIZE, filteredSessions.length),
                    };
                });
            },
            { root, rootMargin: '360px 0px' },
        );

        observer.observe(target);
        return () => observer.disconnect();
    }, [filteredSessions.length, historyScopeKey, visibleHistoryCount]);

    const handleRetry = useCallback(() => {
        refresh('all', { force: true, reason: 'launcher-right-rail-retry' });
    }, [refresh]);

    const handleConfirmDelete = useCallback(async () => {
        if (!pendingDeleteSession) return;
        const { id } = pendingDeleteSession;
        setPendingDeleteSession(null);
        try {
            const success = await actions.deleteSession(id);
            if (success) toast.success(t('rightRail.deleted'));
            else toast.error(t('rightRail.deleteFailedRetry'));
        } catch (err) {
            console.error('[LauncherRightRail] Delete session failed:', err);
            toast.error(t('rightRail.deleteFailed'));
        }
    }, [actions, pendingDeleteSession, t, toast]);

    const handleShowStatsSession = useCallback((target: SessionMetadata) => {
        setStatsSession({
            id: target.id,
            title: getSessionDisplayText(target),
        });
    }, []);

    const handleRequestDeleteSession = useCallback((target: SessionMetadata) => {
        setPendingDeleteSession({
            id: target.id,
            title: getSessionDisplayText(target),
        });
    }, []);

    const handleToggleFavoriteSession = useCallback(async (target: SessionMetadata) => {
        try {
            const success = await actions.setSessionFavorite(target.id, !target.favorite);
            if (!success) toast.error(t('rightRail.favoriteFailedRetry'));
        } catch (err) {
            console.error('[LauncherRightRail] Toggle favorite failed:', err);
            toast.error(t('rightRail.favoriteFailedRetry'));
        }
    }, [actions, t, toast]);

    const handleHistoryMenuOpenChange = useCallback((sessionId: string, open: boolean) => {
        setOpenHistoryMenuSessionId(current => {
            if (open) return sessionId;
            return current === sessionId ? null : current;
        });
    }, []);

    const showEmptyProjects = !isProjectsLoading && sortedProjects.length === 0;
    const hasMoreHistory = visibleHistoryCount < filteredSessions.length;

    return (
        <section className="launcher-workspaces relative flex flex-col overflow-hidden">
            <div ref={scrollRootRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="px-6 pb-6 pt-6">
                    <section>
                        <div className="mb-4 flex items-center justify-between">
                            <h2 className="text-base font-semibold tracking-[0.04em] text-[var(--ink-muted)]">
                                {t('rightRail.workspaceTitle')}
                            </h2>
                            <div className="flex items-center gap-3">
                                {showDevTools && (
                                    <button
                                        onClick={onShowLogs}
                                        className="rounded-lg px-2.5 py-1 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                                        title={t('rightRail.logsTitle')}
                                    >
                                        Logs
                                    </button>
                                )}
                                {sortedProjects.length > 0 && (
                                    <AddWorkspaceMenu
                                        onAddFolder={onAddFolder}
                                        onCreateFromTemplate={onCreateFromTemplate}
                                    />
                                )}
                            </div>
                        </div>

                        {isProjectsLoading ? (
                            <div className="flex flex-col items-center justify-center py-14">
                                <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-muted)]/50" />
                                <p className="mt-4 text-sm text-[var(--ink-muted)]/70">{t('rightRail.loading')}</p>
                            </div>
                        ) : showEmptyProjects ? (
                            <div className="flex flex-col items-center justify-center py-14 text-center">
                                <h3 className="mb-1.5 text-lg font-medium text-[var(--ink)]">
                                    {t('rightRail.emptyWorkspaceTitle')}
                                </h3>
                                <p className="mb-6 max-w-[220px] text-sm leading-relaxed text-[var(--ink-muted)]/60">
                                    {t('rightRail.emptyWorkspaceDescription')}
                                </p>
                                <div className="flex items-center gap-3">
                                    <button
                                        onClick={onAddFolder}
                                        className="flex items-center gap-1.5 rounded-full bg-[var(--button-secondary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-secondary-text)] transition-all hover:bg-[var(--button-secondary-bg-hover)] hover:shadow-sm"
                                    >
                                        <FolderPlus className="h-3.5 w-3.5" />
                                        {t('rightRail.addFolder')}
                                    </button>
                                    <button
                                        onClick={onCreateFromTemplate}
                                        className="flex items-center gap-1.5 rounded-full bg-[var(--button-primary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-primary-text)] transition-all hover:bg-[var(--button-primary-bg-hover)] hover:shadow-sm"
                                    >
                                        <LayoutTemplate className="h-3.5 w-3.5" />
                                        {t('rightRail.createFromTemplate')}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div
                                    className="overflow-hidden transition-[max-height] duration-300 ease-out motion-reduce:transition-none"
                                    style={{ maxHeight: workspaceMaxHeight }}
                                >
                                    <div className="grid grid-cols-2 gap-3">
                                        {renderedWorkspaceProjects.map((project) => {
                                            const agentData = agentLookup.get(normalizeWorkspacePathIdentity(project.path));
                                            return (
                                                <WorkspaceCard
                                                    key={project.id}
                                                    project={project}
                                                    agent={agentData?.agent}
                                                    agentStatus={agentData?.status}
                                                    onLaunch={onLaunch}
                                                    onRemove={onRemoveProject}
                                                    onAgentSettings={onAgentSettings}
                                                    onOpenFolder={onOpenProjectFolder}
                                                    onTogglePin={onToggleProjectPin}
                                                    isLoading={launchingProjectId === project.id && isStarting}
                                                />
                                            );
                                        })}
                                    </div>
                                </div>
                                {hiddenWorkspaceCount > 0 && (
                                    <div className="mt-3 flex justify-center">
                                        <button
                                            type="button"
                                            onClick={handleToggleWorkspaces}
                                            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                                        >
                                            {workspacesExpanded ? (
                                                <>
                                                    {t('rightRail.collapse')}
                                                    <ChevronUp className="h-3.5 w-3.5" />
                                                </>
                                            ) : (
                                                <>
                                                    {t('rightRail.expandMore', { count: hiddenWorkspaceCount })}
                                                    <ChevronDown className="h-3.5 w-3.5" />
                                                </>
                                            )}
                                        </button>
                                    </div>
                                )}
                            </>
                        )}
                    </section>

                    <div className="mt-3 border-t border-[var(--line-subtle)]" />

                    <section className="mt-2">
                        <div
                            className="sticky top-0 z-20 bg-[var(--paper)] py-2.5"
                        >
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-2">
                                    <h2 className="shrink-0 text-base font-semibold tracking-[0.04em] text-[var(--ink-muted)]">
                                        {t('rightRail.historyTitle')}
                                    </h2>
                                    <HistoryFilter
                                        projects={sortedProjects}
                                        value={effectiveHistoryFilter}
                                        onChange={setHistoryFilter}
                                    />
                                </div>
                                <button
                                    type="button"
                                    onClick={() => onOpenOverlay('search')}
                                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                                    title={t('rightRail.searchHistory')}
                                    aria-label={t('rightRail.searchHistory')}
                                >
                                    <Search className="h-4 w-4" />
                                </button>
                            </div>
                        </div>

                        <div className="pt-3">
                            {isHistoryLoading && filteredSessions.length === 0 ? (
                                <div className="flex items-center py-8 text-sm text-[var(--ink-muted)]/70">
                                    {t('rightRail.loading')}
                                </div>
                            ) : error ? (
                                <div className="flex items-center justify-center py-10">
                                    <div className="rounded-xl border border-dashed border-[var(--line)] px-4 py-5 text-center">
                                        <AlertCircle className="mx-auto mb-2 h-4 w-4 text-[var(--warning)]" />
                                        <p className="mb-2 text-sm text-[var(--ink-muted)]">{error}</p>
                                        <button
                                            onClick={handleRetry}
                                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                                        >
                                            <RefreshCw className="h-3.5 w-3.5" />
                                            {t('rightRail.retry')}
                                        </button>
                                    </div>
                                </div>
                            ) : pagedSessions.length === 0 ? (
                                <div className="flex items-center py-10 text-sm text-[var(--ink-muted)]/70">
                                    {effectiveHistoryFilter === FAVORITE_HISTORY_FILTER
                                        ? t('rightRail.emptyFavorites')
                                        : effectiveHistoryFilter === 'all'
                                            ? t('rightRail.emptyHistory')
                                            : t('rightRail.emptyWorkspaceHistory')}
                                </div>
                            ) : (
                                <div className="space-y-0.5">
                                    {pagedSessions.map(session => {
                                        const project = projectByPathKey.get(normalizeWorkspacePathIdentity(session.agentDir));
                                        if (!project) return null;
                                        return (
                                            <LauncherHistoryRow
                                                key={session.id}
                                                session={session}
                                                project={project}
                                                tags={sessionTagsMap.get(session.id) ?? EMPTY_SESSION_TAGS}
                                                unreadNotificationCount={sessionNotificationBadgeCounts?.get(session.id) ?? 0}
                                                isCronProtected={cronProtectedSessionIds.has(session.id)}
                                                onOpen={onOpenTask}
                                                onToggleFavorite={handleToggleFavoriteSession}
                                                onShowStats={handleShowStatsSession}
                                                onRequestDelete={handleRequestDeleteSession}
                                                menuOpen={openHistoryMenuSessionId === session.id}
                                                onMenuOpenChange={handleHistoryMenuOpenChange}
                                            />
                                        );
                                    })}
                                    <div ref={loadMoreRef} className="h-8">
                                        {hasMoreHistory && (
                                            <div className="py-2 text-center text-xs text-[var(--ink-muted)]/50">
                                                {t('rightRail.loadMore')}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </section>
                </div>
            </div>
            <div
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 left-0 right-3 z-30 h-10 bg-gradient-to-t from-[var(--paper)] to-[var(--paper-a0)]"
            />

            {pendingDeleteSession && (
                <ConfirmDialog
                    title={t('rightRail.deleteDialogTitle')}
                    message={t('rightRail.deleteDialogMessage', { title: pendingDeleteSession.title })}
                    confirmText={t('rightRail.delete')}
                    confirmVariant="danger"
                    onConfirm={handleConfirmDelete}
                    onCancel={() => setPendingDeleteSession(null)}
                />
            )}
            {statsSession && (
                <SessionStatsModal
                    sessionId={statsSession.id}
                    sessionTitle={statsSession.title}
                    onClose={() => setStatsSession(null)}
                />
            )}
        </section>
    );
});

interface HistoryFilterProps {
    projects: Project[];
    value: HistoryFilterValue;
    onChange: (value: HistoryFilterValue) => void;
}

function HistoryFilter({ projects, value, onChange }: HistoryFilterProps) {
    const { t } = useTranslation('launcher');
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const selectedProject = useMemo(
        () => projects.find(project => normalizeWorkspacePathIdentity(project.path) === value),
        [projects, value],
    );
    const label = value === FAVORITE_HISTORY_FILTER
        ? t('rightRail.filterFavorites')
        : value === 'all'
            ? t('rightRail.filterAll')
            : selectedProject ? getProjectDisplayName(selectedProject) : t('rightRail.filterAll');

    const handleSelect = useCallback((next: HistoryFilterValue) => {
        onChange(next);
        setOpen(false);
    }, [onChange]);

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                onClick={() => setOpen(value => !value)}
                className="inline-flex h-6 max-w-36 items-center gap-1 rounded-md px-2 py-0 text-xs font-medium leading-none text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                title={t('rightRail.filterTitle')}
                aria-label={t('rightRail.filterAria', { label })}
            >
                <span className="min-w-0 truncate">{label}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
            </button>
            <Popover
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={buttonRef}
                placement="bottom-start"
                className="max-h-80 w-56 overflow-y-auto py-1"
            >
                <MenuItem
                    icon={value === 'all' ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
                    label={t('rightRail.filterAll')}
                    active={value === 'all'}
                    onClick={() => handleSelect('all')}
                />
                <MenuItem
                    icon={value === FAVORITE_HISTORY_FILTER
                        ? <Check className="h-3.5 w-3.5" />
                        : <Star className="h-3.5 w-3.5" />}
                    label={t('rightRail.filterFavorites')}
                    active={value === FAVORITE_HISTORY_FILTER}
                    onClick={() => handleSelect(FAVORITE_HISTORY_FILTER)}
                />
                {projects.map(project => {
                    const key = normalizeWorkspacePathIdentity(project.path);
                    return (
                        <MenuItem
                            key={project.id}
                            icon={value === key ? <Check className="h-3.5 w-3.5" /> : <WorkspaceIcon icon={project.icon} size={14} />}
                            label={getProjectDisplayName(project)}
                            active={value === key}
                            onClick={() => handleSelect(key)}
                        />
                    );
                })}
            </Popover>
        </>
    );
}

interface LauncherHistoryRowProps {
    session: SessionMetadata;
    project: Project;
    tags: SessionTag[];
    unreadNotificationCount: number;
    isCronProtected: boolean;
    onOpen: (session: SessionMetadata, project: Project) => void;
    onToggleFavorite: (session: SessionMetadata) => void;
    onShowStats: (session: SessionMetadata) => void;
    onRequestDelete: (session: SessionMetadata) => void;
    menuOpen: boolean;
    onMenuOpenChange: (sessionId: string, open: boolean) => void;
}

const LauncherHistoryRow = memo(function LauncherHistoryRow({
    session,
    project,
    tags,
    unreadNotificationCount,
    isCronProtected,
    onOpen,
    onToggleFavorite,
    onShowStats,
    onRequestDelete,
    menuOpen,
    onMenuOpenChange,
}: LauncherHistoryRowProps) {
    const { t, i18n } = useTranslation('launcher');
    const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
    const menuAnchorRef = useRef<HTMLSpanElement | null>(null);
    const [menuAnchor, setMenuAnchor] = useState<{
        x: number;
        y: number;
        placement: 'bottom-start' | 'bottom-end';
    } | null>(null);
    const displayText = getSessionDisplayText(session);
    const msgCount = formatMessageCount(session, locale);

    const closeMenu = useCallback(() => {
        setMenuAnchor(null);
        onMenuOpenChange(session.id, false);
    }, [onMenuOpenChange, session.id]);

    const openMenuAt = useCallback((x: number, y: number, placement: 'bottom-start' | 'bottom-end' = 'bottom-start') => {
        setMenuAnchor(current => {
            if (current?.x === x && current.y === y && current.placement === placement) return current;
            return { x, y, placement };
        });
        onMenuOpenChange(session.id, true);
    }, [onMenuOpenChange, session.id]);

    const handleOpen = useCallback(() => onOpen(session, project), [onOpen, project, session]);
    const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        handleOpen();
    }, [handleOpen]);
    const handleMouseDownCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (event.button !== 2) return;
        event.preventDefault();
        event.stopPropagation();
        openMenuAt(event.clientX, event.clientY);
    }, [openMenuAt]);
    const handleContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        openMenuAt(event.clientX, event.clientY);
    }, [openMenuAt]);
    const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        handleOpen();
    }, [handleOpen]);

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={handleClick}
            onMouseDownCapture={handleMouseDownCapture}
            onContextMenu={handleContextMenu}
            onKeyDown={handleKeyDown}
            className="group relative flex w-full cursor-pointer select-none items-center gap-1 overflow-hidden rounded-lg px-3 py-2 text-left transition-all hover:bg-[var(--hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
            <div className="flex w-16 shrink-0 items-center text-xs tabular-nums text-[var(--ink-muted)]/50">
                <span className="min-w-0 truncate">{formatTime(session.lastActiveAt, new Date(), locale)}</span>
            </div>
            <div className="flex w-16 shrink-0 items-center text-xs text-[var(--ink-muted)]/55">
                <span className="min-w-0 truncate">{getProjectDisplayName(project)}</span>
            </div>
            {tags.map((tag, index) => (
                <SessionTagBadge key={index} tag={tag} />
            ))}
            <UnreadNotificationIndicator
                count={unreadNotificationCount}
                label={t('rightRail.unreadNotifications', { count: unreadNotificationCount })}
            />
            <span className="launcher-history-row-title-fade min-w-0 flex-1 truncate text-sm text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                {displayText}
                {msgCount && (
                    <span className="ml-1.5 text-xs text-[var(--ink-muted)]/40">
                        {msgCount}
                    </span>
                )}
            </span>
            <div
                className={`launcher-history-row-action-overlay pointer-events-none absolute inset-y-0 right-0 flex w-16 items-center justify-end pr-2 transition-opacity ${
                    menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                }`}
            >
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        if (menuOpen) {
                            closeMenu();
                            return;
                        }
                        const rect = event.currentTarget.getBoundingClientRect();
                        openMenuAt(rect.right, rect.bottom, 'bottom-end');
                    }}
                    className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)] focus-visible:opacity-100"
                    title={t('rightRail.more')}
                    aria-label={t('rightRail.more')}
                >
                    <MoreHorizontal className="h-4 w-4" />
                </button>
            </div>
            {menuOpen && menuAnchor && (
                <>
                    <span
                        ref={menuAnchorRef}
                        className="fixed h-px w-px"
                        style={{ left: menuAnchor.x, top: menuAnchor.y }}
                        aria-hidden
                    />
                    <Popover
                        open
                        onClose={closeMenu}
                        anchorRef={menuAnchorRef}
                        placement={menuAnchor.placement}
                        className="w-40 py-1"
                    >
                        <MenuItem
                            icon={<Star className="h-3.5 w-3.5" fill={session.favorite ? 'currentColor' : 'none'} />}
                            label={session.favorite ? t('rightRail.unfavorite') : t('rightRail.favorite')}
                            onClick={() => {
                                closeMenu();
                                onToggleFavorite(session);
                            }}
                        />
                        <MenuItem
                            icon={<BarChart2 className="h-3.5 w-3.5" />}
                            label={t('rightRail.viewStats')}
                            onClick={() => {
                                closeMenu();
                                onShowStats(session);
                            }}
                        />
                        <MenuItem
                            icon={<Trash2 className="h-3.5 w-3.5" />}
                            label={t('rightRail.delete')}
                            tone="danger"
                            disabled={isCronProtected}
                            title={isCronProtected ? t('rightRail.stopCronBeforeDelete') : undefined}
                            onClick={() => {
                                if (isCronProtected) return;
                                closeMenu();
                                onRequestDelete(session);
                            }}
                        />
                    </Popover>
                </>
            )}
        </div>
    );
});
