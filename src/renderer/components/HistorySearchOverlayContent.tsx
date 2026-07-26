/**
 * HistorySearchOverlayContent — history/search content inside the App Shell overlay.
 *
 * v0.1.69 rework: was a two-column view (sessions + cron tasks). The right
 * column has been removed because the Launcher's 「我的任务」 tab now routes
 * "全部 → / 搜索" to the Task Center singleton tab instead of this overlay,
 * making the cron column redundant here. The overlay now serves a single
 * purpose — browse/filter/search historical Chat sessions — and is renamed
 * accordingly ("历史会话").
 *
 * The App Shell owns the stable backdrop/panel and its entrance animation.
 * This lazy component renders only the interior so Suspense resolution cannot
 * replace the visible shell and replay an opacity-from-zero animation.
 *
 * The legacy `onOpenCronDetail` prop is dropped; downstream callers have
 * been updated in the same commit.
 */

import { memo, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Loader2, BarChart2, Clock, Star, Trash2, X } from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';

import { searchSessions, type SessionSearchHit } from '@/api/searchClient';

import type { SessionTag, TaskCenterData } from '@/hooks/useTaskCenterData';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import SessionTagBadge from '@/components/SessionTagBadge';
import Tip from '@/components/Tip';
import SessionStatsModal from '@/components/SessionStatsModal';
import ConfirmDialog from '@/components/ConfirmDialog';
import CustomSelect from '@/components/CustomSelect';
import { useToast } from '@/components/Toast';
import { getFolderName, formatTime, isImSource, getSessionDisplayText, formatTurnCount } from '@/utils/taskCenterUtils';
import type { SessionMetadata } from '@/api/sessionClient';
import { normalizeWorkspacePathIdentity } from '@/../shared/workspacePath';
import type { Project } from '@/config/types';
import SessionSearchItem from '@/components/search/SessionSearchItem';
import { parseSessionIdQuery } from '@/utils/parseSessionIdQuery';

interface HistorySearchOverlayContentProps {
    projects: Project[];
    onOpenSession: (session: SessionMetadata, project: Project) => void;
    onClose: () => void;
    taskCenterData: TaskCenterData;
    initialMode?: 'default' | 'search';
}

type StatusFilter = 'all' | 'favorite' | 'active' | 'desktop' | 'bot';

const FILTER_OPTIONS: { key: StatusFilter; labelKey: string }[] = [
    { key: 'all', labelKey: 'historyOverlay.filters.all' },
    { key: 'favorite', labelKey: 'historyOverlay.filters.favorite' },
    { key: 'active', labelKey: 'historyOverlay.filters.active' },
    { key: 'desktop', labelKey: 'historyOverlay.filters.desktop' },
    { key: 'bot', labelKey: 'historyOverlay.filters.bot' },
];

interface HistorySessionRowProps {
    session: SessionMetadata;
    project: Project;
    tags: SessionTag[];
    isCronProtected: boolean;
    onOpen: () => void;
    onToggleFavorite: (event: React.MouseEvent) => void;
    onShowStats: (event: React.MouseEvent) => void;
    onDelete: (event: React.MouseEvent) => void;
}

const HistorySessionRow = memo(function HistorySessionRow({
    session,
    project,
    tags,
    isCronProtected,
    onOpen,
    onToggleFavorite,
    onShowStats,
    onDelete,
}: HistorySessionRowProps) {
    const { t } = useTranslation('app');
    const displayText = getSessionDisplayText(session);
    const turnCount = formatTurnCount(session);

    return (
        <div className="pb-0.5">
            <div
                role="button"
                onClick={onOpen}
                className="group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--hover-bg)]"
            >
                <div className="flex w-16 shrink-0 items-center gap-1 text-xs text-[var(--ink-muted)]/50">
                    <Clock className="h-2.5 w-2.5" />
                    <span>{formatTime(session.lastActiveAt)}</span>
                </div>
                {tags.map((tag, index) => (
                    <SessionTagBadge key={`${tag.type}-${index}`} tag={tag} />
                ))}
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                    {displayText}
                    {turnCount && (
                        <span className="ml-1.5 text-xs text-[var(--ink-muted)]/40">
                            {turnCount}
                        </span>
                    )}
                </span>
                <div className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--ink-muted)]/45">
                    <WorkspaceIcon icon={project.icon} size={14} />
                    <span className="max-w-[80px] truncate">
                        {getFolderName(project.path)}
                    </span>
                </div>

                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                    <div className="h-full w-10 bg-gradient-to-r from-[var(--paper-inset-a0)] to-[var(--paper-inset)]" />
                    <div className="flex h-full items-center gap-1 bg-[var(--paper-inset)] pr-3">
                        <Tip label={session.favorite ? t('historyOverlay.unfavorite') : t('historyOverlay.favorite')} position="bottom">
                            <button
                                onClick={onToggleFavorite}
                                aria-label={session.favorite ? t('historyOverlay.unfavorite') : t('historyOverlay.favorite')}
                                className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--paper)] ${
                                    session.favorite
                                        ? 'text-[var(--accent)]'
                                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                }`}
                            >
                                <Star className="h-3.5 w-3.5" fill={session.favorite ? 'currentColor' : 'none'} />
                            </button>
                        </Tip>
                        <Tip label={t('historyOverlay.viewStats')} position="bottom">
                            <button
                                onClick={onShowStats}
                                aria-label={t('historyOverlay.viewStats')}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                            >
                                <BarChart2 className="h-3.5 w-3.5" />
                            </button>
                        </Tip>
                        {isCronProtected ? (
                            <Tip label={t('historyOverlay.deleteBlocked')} position="bottom">
                                <button
                                    disabled
                                    aria-label={t('historyOverlay.deleteBlockedAria')}
                                    className="flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-md text-[var(--ink-muted)] opacity-40"
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </Tip>
                        ) : (
                            <Tip label={t('historyOverlay.delete')} position="bottom">
                                <button
                                    onClick={onDelete}
                                    aria-label={t('historyOverlay.delete')}
                                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </Tip>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
});

export default memo(function HistorySearchOverlayContent({
    projects,
    onOpenSession,
    onClose,
    taskCenterData,
    initialMode = 'default',
}: HistorySearchOverlayContentProps) {
    const { t } = useTranslation('app');
    const { sessions, protectedSchedulerSessionIds, sessionTagsMap, isSessionsLoading, actions } = taskCenterData;
    const toast = useToast();

    // Search state
    const [isSearchMode, setIsSearchMode] = useState(initialMode === 'search');
    const [searchQuery, setSearchQuery] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [searchResults, setSearchResults] = useState<SessionSearchHit[]>([]);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [workspaceFilter, setWorkspaceFilter] = useState<string>('all');
    const [pendingDeleteSession, setPendingDeleteSession] = useState<{ id: string; title: string } | null>(null);
    const [statsSession, setStatsSession] = useState<{ id: string; title: string } | null>(null);

    // Auto-focus search input on mount when overlay opens in search mode
    useEffect(() => {
        if (initialMode === 'search') {
            const id = setTimeout(() => searchInputRef.current?.focus(), 50);
            return () => clearTimeout(id);
        }
    }, [initialMode]);

    const projectsByWorkspace = useMemo(() => {
        const byWorkspace = new Map<string, Project>();
        for (const project of projects) {
            byWorkspace.set(normalizeWorkspacePathIdentity(project.path), project);
        }
        return byWorkspace;
    }, [projects]);

    const sessionsById = useMemo(
        () => new Map(sessions.map(session => [session.id, session])),
        [sessions],
    );

    const getProjectForSession = useCallback(
        (session: SessionMetadata): Project | undefined =>
            projectsByWorkspace.get(normalizeWorkspacePathIdentity(session.agentDir)),
        [projectsByWorkspace],
    );

    // Unique workspace entries for dropdown (name + icon)
    const workspaceOptions = useMemo(() => {
        const seen = new Map<string, string | undefined>(); // name → icon
        for (const s of sessions) {
            const proj = getProjectForSession(s);
            if (proj) {
                const name = getFolderName(proj.path);
                if (!seen.has(name)) seen.set(name, proj.icon);
            }
        }
        return Array.from(seen.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, icon]) => ({ name, icon }));
    }, [sessions, getProjectForSession]);

    // Memoize CustomSelect options to avoid re-creating JSX icons each render
    const workspaceSelectOptions = useMemo(() => [
        { value: 'all', label: t('historyOverlay.allWorkspaces') },
        ...workspaceOptions.map(({ name, icon }) => ({
            value: name,
            label: name,
            icon: <WorkspaceIcon icon={icon} size={14} />,
        })),
    ], [workspaceOptions, t]);

    // Filter sessions
    const filteredSessions = useMemo(() => {
        // 48h cutoff for "active" filter — computed per-filter to avoid stale mount-time values.
        // sessions is the dependency, so this recomputes whenever session data refreshes.
        const activeCutoff48h = new Date(+new Date() - 48 * 3600000).toISOString();
        return sessions.filter(session => {
            // Status filter (source-based for bot/desktop)
            if (statusFilter === 'favorite' && !session.favorite) return false;
            if (statusFilter === 'active') {
                const tags = sessionTagsMap.get(session.id) ?? [];
                if (tags.length === 0) return false;
                // Require recent activity (48h) — prevents stale IM sessions
                // from permanently appearing as "active" just because they have a source tag
                if (session.lastActiveAt && session.lastActiveAt < activeCutoff48h) return false;
            }
            if (statusFilter === 'desktop' && isImSource(session.source)) return false;
            if (statusFilter === 'bot' && !isImSource(session.source)) return false;

            // Workspace filter
            if (workspaceFilter !== 'all') {
                const proj = getProjectForSession(session);
                if (!proj || getFolderName(proj.path) !== workspaceFilter) return false;
            }

            return true;
        });
    }, [sessions, sessionTagsMap, statusFilter, workspaceFilter, getProjectForSession]);

    const browseRows = useMemo(() => filteredSessions.flatMap((session) => {
        const project = getProjectForSession(session);
        return project ? [{ session, project }] : [];
    }), [filteredSessions, getProjectForSession]);

    // Search effect
    useEffect(() => {
        if (!isSearchMode) return;
        
        let isStale = false;
        const timeout = setTimeout(async () => {
            // A pasted session id short-circuits full-text search — it's resolved
            // synchronously via directSessionMatch (Issue #260).
            if (!searchQuery.trim() || parseSessionIdQuery(searchQuery)) {
                setSearchResults([]);
                setIsSearching(false);
                return;
            }

            setIsSearching(true);
            try {
                const result = await searchSessions(searchQuery);
                if (!isStale) {
                    setSearchResults(result.hits);
                }
            } catch (err) {
                console.error('[HistorySearchOverlayContent] Session search failed:', err);
                if (!isStale) setSearchResults([]);
            } finally {
                if (!isStale) setIsSearching(false);
            }
        }, 300); // 300ms debounce
        
        return () => {
            isStale = true;
            clearTimeout(timeout);
        };
    }, [searchQuery, isSearchMode]);

    // Paste-to-jump (Issue #260): if the query is a pasted session id (bare or
    // the `SessionID: <uuid>` copy-button format), resolve it directly against
    // the already-loaded sessions instead of running full-text search.
    //   - { kind: 'found' }    → render one clickable result, Enter opens it
    //   - { kind: 'notFound' } → the id is well-formed but no loaded session matches
    //   - null                 → not a session id, fall through to normal search
    const directSessionMatch = useMemo(() => {
        const sessionId = parseSessionIdQuery(searchQuery);
        if (!sessionId) return null;
        const session = sessions.find(s => s.id.toLowerCase() === sessionId);
        const project = session ? getProjectForSession(session) : undefined;
        if (session && project) return { kind: 'found' as const, session, project };
        return { kind: 'notFound' as const };
    }, [searchQuery, sessions, getProjectForSession]);

    // Open the direct-match session (used by Enter in the search box).
    const openDirectMatch = useCallback(() => {
        if (directSessionMatch?.kind === 'found') {
            onOpenSession(directSessionMatch.session, directSessionMatch.project);
        }
    }, [directSessionMatch, onOpenSession]);

    const cronProtectedSessionIds = protectedSchedulerSessionIds;

    const handleDeleteClick = useCallback((e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setPendingDeleteSession({ id: session.id, title: getSessionDisplayText(session) });
    }, []);

    const handleConfirmDelete = useCallback(async () => {
        if (!pendingDeleteSession) return;
        const { id } = pendingDeleteSession;
        setPendingDeleteSession(null);
        try {
            const success = await actions.deleteSession(id);
            if (success) {
                toast.success(t('historyOverlay.deleted'));
            } else {
                toast.error(t('historyOverlay.deleteFailedRetry'));
            }
        } catch (err) {
            console.error('[HistorySearchOverlayContent] Delete session failed:', err);
            toast.error(t('historyOverlay.deleteFailed'));
        }
    }, [actions, pendingDeleteSession, t, toast]);

    const handleShowStats = useCallback((e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setStatsSession({ id: session.id, title: getSessionDisplayText(session) });
    }, []);

    const handleToggleFavorite = useCallback(async (e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        try {
            const success = await actions.setSessionFavorite(session.id, !session.favorite);
            if (!success) toast.error(t('historyOverlay.favoriteFailed'));
        } catch (err) {
            console.error('[HistorySearchOverlayContent] Toggle favorite failed:', err);
            toast.error(t('historyOverlay.favoriteFailed'));
        }
    }, [actions, t, toast]);

    return (
        <>
                {/* Header — v0.1.69 renamed from "任务中心" to "历史对话" to
                    match the new domain of this overlay (Chat sessions only;
                    Tasks live in the Task Center singleton tab). */}
                <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-[var(--ink)]">{t('historyOverlay.title')}</h2>
                    <button
                        onClick={onClose}
                        aria-label={t('common.close')}
                        className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Body — single column now that the cron-tasks right pane
                    has been removed. Kept inside the flex wrapper so a future
                    sibling (e.g. per-workspace stats) slides in without
                    further restructuring. */}
                <div className="flex min-h-0 flex-1">
                    <div className="flex min-w-0 flex-1 flex-col">
                        {/* Filter bar / Search Input */}
                        <div className="mb-3 flex flex-wrap items-center gap-2 h-8">
                            {isSearchMode ? (
                                <div className="relative flex-1 h-full">
                                    <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5 text-[var(--ink-muted)]/50">
                                        <Search className="h-3.5 w-3.5" />
                                    </div>
                                    <input
                                        ref={searchInputRef}
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        placeholder={t('historyOverlay.searchPlaceholder')}
                                        className="h-full w-full rounded-md outline-none border border-[var(--line)] bg-transparent py-1 pl-8 pr-10 text-sm text-[var(--ink)] transition-colors placeholder:text-[var(--ink-muted)]/60 focus:border-[var(--accent)]"
                                        onKeyDown={(e) => {
                                            if (e.key === "Escape") {
                                                setIsSearchMode(false);
                                                setSearchQuery("");
                                            } else if (e.key === "Enter" && directSessionMatch?.kind === 'found') {
                                                // Paste-to-jump: Enter opens the matched session (#260).
                                                e.preventDefault();
                                                openDirectMatch();
                                            }
                                        }}
                                    />
                                    <div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-2">
                                        {isSearching && (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--ink-muted)]/50" />
                                        )}
                                        <button
                                            onClick={() => {
                                                setIsSearchMode(false);
                                                setSearchQuery("");
                                                setSearchResults([]);
                                            }}
                                            title={t('historyOverlay.exitSearch')}
                                            className="flex items-center text-[var(--ink-muted)]/50 transition-colors hover:text-[var(--ink)]"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    {/* Status pills */}
                                    <div className="flex gap-1">
                                        {FILTER_OPTIONS.map(opt => (
                                            <button
                                                key={opt.key}
                                                onClick={() => setStatusFilter(opt.key)}
                                                className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                                                    statusFilter === opt.key
                                                        ? 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)]'
                                                        : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]'
                                                }`}
                                            >
                                                {t(opt.labelKey)}
                                            </button>
                                        ))}
                                    </div>

                                    {/* Workspace dropdown */}
                                    {workspaceOptions.length > 1 && (
                                        <CustomSelect
                                            value={workspaceFilter}
                                            options={workspaceSelectOptions}
                                            onChange={setWorkspaceFilter}
                                            compact
                                            className="w-[140px]"
                                        />
                                    )}
                                    <div className="flex-1" />
                                    <button
                                        onClick={() => {
                                            setIsSearchMode(true);
                                            setTimeout(() => searchInputRef.current?.focus(), 50);
                                        }}
                                        className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                    >
                                        <Search className="h-4 w-4" />
                                    </button>
                                </>
                            )}
                        </div>

                        {/* Session list — empty-query history is virtualized so opening
                            the overlay never mounts the entire archive in one commit. */}
                        {isSearchMode && directSessionMatch ? (
                            <div className="flex-1 overflow-y-auto overscroll-contain" style={{ scrollbarGutter: 'stable' }}>
                                {directSessionMatch.kind === 'found' ? (
                                    <div className="space-y-2">
                                        <div className="px-1 text-xs text-[var(--ink-muted)]/60">
                                            {t('historyOverlay.directMatch')}
                                        </div>
                                        <div
                                            role="button"
                                            onClick={openDirectMatch}
                                            className="group flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--accent)]/30 px-3 py-2.5 text-left transition-colors hover:bg-[var(--hover-bg)]"
                                        >
                                            <div className="flex w-16 shrink-0 items-center gap-1 text-xs text-[var(--ink-muted)]/50">
                                                <Clock className="h-2.5 w-2.5" />
                                                <span>{formatTime(directSessionMatch.session.lastActiveAt)}</span>
                                            </div>
                                            <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                                                {getSessionDisplayText(directSessionMatch.session)}
                                            </span>
                                            <div className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--ink-muted)]/45">
                                                <WorkspaceIcon icon={directSessionMatch.project.icon} size={14} />
                                                <span className="max-w-[80px] truncate">
                                                    {getFolderName(directSessionMatch.project.path)}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="py-8 text-center text-sm text-[var(--ink-muted)]/60">
                                        {t('historyOverlay.sessionNotFound')}
                                    </div>
                                )}
                            </div>
                        ) : isSearchMode && searchQuery.trim() !== '' ? (
                            <div className="flex-1 overflow-y-auto overscroll-contain" style={{ scrollbarGutter: 'stable' }}>
                                {searchResults.length === 0 && !isSearching ? (
                                    <div className="py-8 text-center text-sm text-[var(--ink-muted)]/60">
                                        {t('historyOverlay.noResults')}
                                    </div>
                                ) : (
                                    <div className="space-y-0.5">
                                        {searchResults.map(hit => {
                                            const session = sessionsById.get(hit.sessionId);
                                            const project = projectsByWorkspace.get(normalizeWorkspacePathIdentity(hit.agentDir));
                                            if (!session || !project) return null;
                                            const isCronProtected = cronProtectedSessionIds.has(session.id);
                                            return (
                                                <SessionSearchItem
                                                    key={`${hit.sessionId}-${hit.matchType}`}
                                                    hit={hit}
                                                    session={session}
                                                    project={project}
                                                    isCronProtected={isCronProtected}
                                                    onClick={() => onOpenSession(session, project)}
                                                    onShowStats={(event) => handleShowStats(event, session)}
                                                    onDelete={(event) => handleDeleteClick(event, session)}
                                                />
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        ) : isSessionsLoading && browseRows.length === 0 ? (
                            <div className="flex flex-1 items-center justify-center" aria-busy="true">
                                <Loader2 className="h-4 w-4 animate-spin text-[var(--ink-muted)]/50" />
                            </div>
                        ) : browseRows.length === 0 ? (
                            <div className="flex-1 py-8 text-center text-sm text-[var(--ink-muted)]/60">
                                {t('historyOverlay.empty')}
                            </div>
                        ) : (
                            <Virtuoso
                                data={browseRows}
                                computeItemKey={(_index, row) => row.session.id}
                                defaultItemHeight={38}
                                increaseViewportBy={240}
                                className="flex-1 overscroll-contain"
                                style={{ scrollbarGutter: 'stable' }}
                                itemContent={(_index, row) => (
                                    <HistorySessionRow
                                        session={row.session}
                                        project={row.project}
                                        tags={sessionTagsMap.get(row.session.id) ?? []}
                                        isCronProtected={cronProtectedSessionIds.has(row.session.id)}
                                        onOpen={() => onOpenSession(row.session, row.project)}
                                        onToggleFavorite={(event) => handleToggleFavorite(event, row.session)}
                                        onShowStats={(event) => handleShowStats(event, row.session)}
                                        onDelete={(event) => handleDeleteClick(event, row.session)}
                                    />
                                )}
                            />
                        )}
                    </div>
                </div>

            {pendingDeleteSession && (
                <ConfirmDialog
                    title={t('historyOverlay.deleteTitle')}
                    message={t('historyOverlay.deleteMessage', { title: pendingDeleteSession.title })}
                    confirmText={t('historyOverlay.delete')}
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
        </>
    );
});
