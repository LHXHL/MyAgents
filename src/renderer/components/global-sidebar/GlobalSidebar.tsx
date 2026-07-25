import {
  AlertCircle,
  Archive,
  BarChart2,
  Bot,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Cloud,
  Eye,
  EyeOff,
  FolderOpen,
  FolderTree,
  LayoutGrid,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelTop,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Settings2,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';

import { track } from '@/analytics';
import myAgentsLogo from '@/assets/runtime-icons/myagents.png';
import type { SessionMetadata } from '@/api/sessionClient';
import ConfirmDialog from '@/components/ConfirmDialog';
import FeedbackPopover from '@/components/FeedbackPopover';
import PathInputDialog from '@/components/PathInputDialog';
import SessionStatsModal from '@/components/SessionStatsModal';
import SessionTagBadge from '@/components/SessionTagBadge';
import UnreadNotificationIndicator from '@/components/UnreadNotificationIndicator';
import { useToast } from '@/components/Toast';
import { AddWorkspaceMenu, TemplateLibraryDialog } from '@/components/launcher';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import { sortLauncherProjects } from '@/components/launcher/workspaceSort';
import { MenuItem } from '@/components/ui/MenuItem';
import { Popover } from '@/components/ui/Popover';
import {
  isProjectActiveForUser,
  isProjectArchived,
  isProjectVisibleToUser,
  isSystemPresetProject,
  type Project,
  type WorkspaceTemplate,
} from '@/config/types';
import {
  disableAgentAndStopChannels,
  enableAgentAndStartChannels,
  getAgentById,
} from '@/config/services/agentConfigService';
import {
  archiveProject,
  unarchiveProject,
} from '@/config/services/projectService';
import { useConfig } from '@/hooks/useConfig';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useGlobalSidebarTaskCenterData, type SessionTag, type TaskCenterData } from '@/hooks/useTaskCenterData';
import { ensureWorkspaceSessions } from '@/hooks/taskCenterStore';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import type { Tab, InitialMessage } from '@/types/tab';
import { isSupportedLocale } from '../../../shared/i18n';
import { isAutomationHistoryOrigin } from '../../../shared/session-origin';
import { normalizeWorkspacePathIdentity, workspacePathsEqual } from '../../../shared/workspacePath';
import {
  DEFAULT_GLOBAL_SIDEBAR_PREFERENCE,
  loadGlobalSidebarPreference,
  pruneRemovedWorkspaceKeys,
  resolveGlobalSidebarMode,
  saveGlobalSidebarPreference,
  seedDefaultWorkspaceExpansion,
  type GlobalSidebarPreferenceV1,
} from '@/utils/globalSidebarPreference';
import { isBrowserDevMode, isTauriEnvironment, pickFolderForDialog } from '@/utils/browserMock';
import { formatTime, getSessionDisplayText } from '@/utils/taskCenterUtils';

const TaskCenterOverlay = lazy(() => import('@/components/TaskCenterOverlay'));
const WorkspaceConfigPanel = lazy(() => import('@/components/WorkspaceConfigPanel'));

const SESSION_PAGE_SIZE = 5;
const AUTO_RAIL_QUERY = '(max-width: 1080px)';
const EMPTY_TAGS: SessionTag[] = [];

export type CapabilitySection = 'skills' | 'plugins' | 'mcp';

interface GlobalSidebarProps {
  tabs: readonly Tab[];
  activeTab: Tab | undefined;
  activeWorkspacePath: string | null;
  sessionNotificationBadgeCounts?: ReadonlyMap<string, number>;
  onNewTab: () => void;
  onOpenTaskCenter: () => void;
  onOpenSpace: () => void;
  onOpenCapabilities: (section?: CapabilitySection) => void;
  onOpenSettings: () => void;
  onOpenBugReport: () => void;
  onOpenWorkspace: (
    project: Project,
    initialMessage?: InitialMessage,
    entryIntent?: 'open_workspace' | 'workspace_init',
  ) => Promise<boolean>;
  onOpenSession: (session: SessionMetadata, project: Project) => Promise<boolean>;
}

function useForcedRail(): boolean {
  const [forced, setForced] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(AUTO_RAIL_QUERY).matches
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(AUTO_RAIL_QUERY);
    const onChange = (event: MediaQueryListEvent) => setForced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return forced;
}

function SidebarTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="group/sidebar-tip relative flex justify-center">
      {children}
      <div
        role="tooltip"
        className="pointer-events-none invisible absolute left-full top-1/2 z-[270] ml-3 -translate-y-1/2 whitespace-nowrap rounded-md bg-[var(--button-dark-bg)] px-2.5 py-1.5 text-xs text-[var(--button-dark-text)] opacity-0 shadow-md transition-opacity delay-500 group-hover/sidebar-tip:visible group-hover/sidebar-tip:opacity-100 group-focus-within/sidebar-tip:visible group-focus-within/sidebar-tip:opacity-100"
      >
        {label}
      </div>
    </div>
  );
}

function useNestedInteractionCleanup(onOpenChange: (open: boolean) => void): void {
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);
  useEffect(() => () => onOpenChangeRef.current(false), []);
}

interface SidebarNavButtonProps {
  icon: ReactNode;
  label: string;
  expanded: boolean;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function SidebarNavButton({ icon, label, expanded, active, disabled, onClick }: SidebarNavButtonProps) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      className={`flex h-10 items-center rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
        expanded ? 'w-full gap-3 px-3' : 'w-10 justify-center'
      } ${
        active
          ? 'bg-[var(--hover-bg)] text-[var(--ink)] shadow-sm'
          : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
      } ${disabled ? 'cursor-not-allowed opacity-45' : ''}`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      {expanded && <span className="min-w-0 truncate">{label}</span>}
    </button>
  );
  return expanded ? button : <SidebarTooltip label={label}>{button}</SidebarTooltip>;
}

export default memo(function GlobalSidebar({
  tabs,
  activeTab,
  activeWorkspacePath,
  sessionNotificationBadgeCounts,
  onNewTab,
  onOpenTaskCenter,
  onOpenSpace,
  onOpenCapabilities,
  onOpenSettings,
  onOpenBugReport,
  onOpenWorkspace,
  onOpenSession,
}: GlobalSidebarProps) {
  const { t } = useTranslation('app');
  const { t: tLauncher } = useTranslation('launcher');
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);
  const {
    config,
    projects,
    isLoading: projectsLoading,
    error: projectsError,
    addProject,
    removeProject,
    patchProject,
    touchProject,
    refreshConfig,
  } = useConfig();
  const { openPathExternal } = useWorkspaceFileService(null);
  const forceRail = useForcedRail();
  const [preference, setPreference] = useState<GlobalSidebarPreferenceV1>(() => {
    if (typeof window === 'undefined') return DEFAULT_GLOBAL_SIDEBAR_PREFERENCE;
    return loadGlobalSidebarPreference(window.localStorage);
  });
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>({});
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const openNestedLayerKeysRef = useRef(new Set<string>());
  const flyoutTriggerRef = useRef<HTMLButtonElement | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const childLayerReturnFocusRef = useRef<HTMLElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const feedbackTriggerRef = useRef<HTMLDivElement | null>(null);

  const [pathDialogOpen, setPathDialogOpen] = useState(false);
  const [pendingFolderName, setPendingFolderName] = useState('');
  const [pendingDefaultPath, setPendingDefaultPath] = useState('');
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [projectToRemove, setProjectToRemove] = useState<Project | null>(null);
  const [agentWorkspacePath, setAgentWorkspacePath] = useState<string | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<SessionMetadata | null>(null);
  const [statsSession, setStatsSession] = useState<SessionMetadata | null>(null);
  const pinInFlightRef = useRef(new Set<string>());
  const archiveInFlightRef = useRef(new Set<string>());
  const childLayerOpen = pathDialogOpen
    || templateDialogOpen
    || projectToRemove !== null
    || agentWorkspacePath !== null
    || pendingDeleteSession !== null
    || statsSession !== null;
  const childLayerOpenRef = useRef(childLayerOpen);
  childLayerOpenRef.current = childLayerOpen;
  const previousChildLayerOpenRef = useRef(childLayerOpen);

  const updatePreference = useCallback((update: (current: GlobalSidebarPreferenceV1) => GlobalSidebarPreferenceV1) => {
    setPreference((current) => {
      const next = update(current);
      if (next === current) return current;
      if (typeof window !== 'undefined') saveGlobalSidebarPreference(window.localStorage, next);
      return next;
    });
  }, []);

  const sortedProjects = useMemo(
    () => sortLauncherProjects(projects.filter(isProjectVisibleToUser)),
    [projects],
  );
  const activeProjects = useMemo(
    () => sortedProjects.filter(isProjectActiveForUser),
    [sortedProjects],
  );
  const archivedProjects = useMemo(
    () => sortedProjects
      .filter(isProjectArchived)
      .sort((a, b) => (Date.parse(b.archivedAt ?? '') || 0) - (Date.parse(a.archivedAt ?? '') || 0)),
    [sortedProjects],
  );
  const expandedWorkspacePaths = useMemo(() => {
    const expandedKeys = new Set(preference.expandedWorkspaceKeys);
    return activeProjects
      .filter((project) => expandedKeys.has(normalizeWorkspacePathIdentity(project.path)))
      .map((project) => project.path);
  }, [activeProjects, preference.expandedWorkspaceKeys]);
  const taskCenterData = useGlobalSidebarTaskCenterData(expandedWorkspacePaths, searchOpen);

  useEffect(() => {
    if (projectsLoading) return;
    updatePreference((current) => {
      const seeded = seedDefaultWorkspaceExpansion(
        current,
        config.defaultWorkspacePath,
        activeProjects.map((project) => project.path),
      );
      return pruneRemovedWorkspaceKeys(seeded, activeProjects.map((project) => project.path));
    });
  }, [activeProjects, config.defaultWorkspacePath, projectsLoading, updatePreference]);

  const effectiveMode = resolveGlobalSidebarMode(preference.preferredMode, forceRail);
  const expanded = effectiveMode === 'expanded';

  const clearFlyoutTimers = useCallback(() => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    openTimerRef.current = null;
    closeTimerRef.current = null;
  }, []);

  useEffect(() => clearFlyoutTimers, [clearFlyoutTimers]);

  const openFlyoutNow = useCallback(() => {
    clearFlyoutTimers();
    setFlyoutOpen(true);
  }, [clearFlyoutTimers]);

  const scheduleFlyoutOpen = useCallback(() => {
    if (expanded || flyoutOpen) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    openTimerRef.current = setTimeout(() => setFlyoutOpen(true), 125);
  }, [expanded, flyoutOpen]);

  const scheduleFlyoutClose = useCallback(() => {
    if (expanded) return;
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      if (openNestedLayerKeysRef.current.size > 0 || childLayerOpenRef.current) return;
      const active = document.activeElement;
      if (active && (flyoutRef.current?.contains(active) || flyoutTriggerRef.current?.contains(active))) return;
      setFlyoutOpen(false);
    }, 220);
  }, [expanded]);

  const handleNestedInteractionChange = useCallback((key: string, open: boolean) => {
    if (open) openNestedLayerKeysRef.current.add(key);
    else openNestedLayerKeysRef.current.delete(key);
    if (!open) scheduleFlyoutClose();
  }, [scheduleFlyoutClose]);

  useEffect(() => {
    const wasOpen = previousChildLayerOpenRef.current;
    previousChildLayerOpenRef.current = childLayerOpen;
    if (childLayerOpen && closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    } else if (wasOpen && !childLayerOpen) {
      scheduleFlyoutClose();
    }
  }, [childLayerOpen, scheduleFlyoutClose]);

  const closeFlyout = useCallback((restoreFocus = false) => {
    clearFlyoutTimers();
    openNestedLayerKeysRef.current.clear();
    setFlyoutOpen(false);
    if (restoreFocus) flyoutTriggerRef.current?.focus();
  }, [clearFlyoutTimers]);

  useCloseLayer(() => {
    if (!flyoutOpen) return false;
    closeFlyout(true);
    return true;
  }, flyoutOpen ? 240 : -1);

  useEffect(() => {
    if (expanded && flyoutOpen) closeFlyout();
  }, [closeFlyout, expanded, flyoutOpen]);

  const handleToggleMode = useCallback(() => {
    if (forceRail) return;
    updatePreference((current) => ({
      ...current,
      preferredMode: current.preferredMode === 'expanded' ? 'rail' : 'expanded',
    }));
  }, [forceRail, updatePreference]);

  const handleToggleWorkspace = useCallback((project: Project) => {
    const key = normalizeWorkspacePathIdentity(project.path);
    updatePreference((current) => {
      const keys = new Set(current.expandedWorkspaceKeys);
      if (keys.has(key)) keys.delete(key);
      else keys.add(key);
      return { ...current, expandedWorkspaceKeys: [...keys], hasSeededDefaultExpansion: true };
    });
  }, [updatePreference]);

  const rememberChildLayerOrigin = useCallback((origin?: HTMLElement | null) => {
    childLayerReturnFocusRef.current = origin ?? flyoutTriggerRef.current;
  }, []);

  const restoreChildLayerFocus = useCallback(() => {
    const target = childLayerReturnFocusRef.current;
    childLayerReturnFocusRef.current = null;
    if (target?.isConnected) target.focus();
    else flyoutTriggerRef.current?.focus();
  }, []);

  const handleLoadMore = useCallback((project: Project, total: number) => {
    const key = normalizeWorkspacePathIdentity(project.path);
    setSessionLimits((current) => ({
      ...current,
      [key]: Math.min((current[key] ?? SESSION_PAGE_SIZE) + SESSION_PAGE_SIZE, total),
    }));
  }, []);

  const handleAddFolder = useCallback(async () => {
    try {
      if (isBrowserDevMode()) {
        const folderInfo = await pickFolderForDialog();
        if (!folderInfo) return;
        setPendingFolderName(folderInfo.folderName);
        setPendingDefaultPath(folderInfo.defaultPath);
        rememberChildLayerOrigin();
        setPathDialogOpen(true);
        return;
      }
      const selected = await open({
        directory: true,
        multiple: false,
        title: tLauncher('dialogs.pickProjectFolder'),
      });
      if (typeof selected === 'string') await addProject(selected);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toastRef.current.error(tLauncher('toasts.addProjectFailed', { message }));
    }
  }, [addProject, rememberChildLayerOrigin, tLauncher]);

  const handlePathConfirm = useCallback(async (path: string) => {
    setPathDialogOpen(false);
    try {
      await addProject(path);
      const normalizedPath = path.replace(/\\/g, '/');
      const parentDir = normalizedPath.split('/').slice(0, -1).join('/');
      if (parentDir) window.localStorage.setItem('myagents:lastProjectDir', parentDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toastRef.current.error(tLauncher('toasts.addProjectFailed', { message }));
    } finally {
      restoreChildLayerFocus();
    }
  }, [addProject, restoreChildLayerFocus, tLauncher]);

  const handleCreateFromTemplate = useCallback(async (
    path: string,
    template: WorkspaceTemplate,
    displayName?: string,
  ) => {
    await addProject(path, {
      icon: template.icon,
      displayName,
      templateId: template.id,
      templateSource: template.isBuiltin ? 'builtin' : 'user',
      agentDefaults: template.isBuiltin ? template.agentDefaults : undefined,
    });
    track('workspace_create', { source: 'template' });
  }, [addProject]);

  const handleOpenTaskCenter = useCallback(() => {
    track('task_center_open', {});
    onOpenTaskCenter();
  }, [onOpenTaskCenter]);

  const handleTogglePin = useCallback(async (project: Project) => {
    if (isProjectArchived(project) || pinInFlightRef.current.has(project.id)) return;
    pinInFlightRef.current.add(project.id);
    try {
      const latest = projects.find((candidate) => candidate.id === project.id) ?? project;
      await patchProject(project.id, { pinnedAt: latest.pinnedAt ? undefined : new Date().toISOString() });
    } catch (error) {
      console.error('[GlobalSidebar] Failed to toggle workspace pin:', error);
      toastRef.current.warning(tLauncher('toasts.pinFailed'));
    } finally {
      pinInFlightRef.current.delete(project.id);
    }
  }, [patchProject, projects, tLauncher]);

  const handleArchive = useCallback(async (project: Project) => {
    if (archiveInFlightRef.current.has(project.id)) return;
    archiveInFlightRef.current.add(project.id);
    try {
      const latest = projects.find((candidate) => candidate.id === project.id) ?? project;
      const agent = latest.agentId ? getAgentById(config, latest.agentId) : undefined;
      const wasEnabled = agent?.enabled === true;
      const archived = await archiveProject(latest.id, { agentEnabledBeforeArchive: wasEnabled });
      if (!archived) throw new Error(`Project ${latest.id} not found`);
      if (agent && wasEnabled) await disableAgentAndStopChannels(agent);
      await refreshConfig();
      toastRef.current.success(tLauncher('toasts.workspaceArchived'));
    } catch (error) {
      console.error('[GlobalSidebar] Failed to archive workspace:', error);
      toastRef.current.warning(tLauncher('toasts.archiveFailed'));
    } finally {
      archiveInFlightRef.current.delete(project.id);
    }
  }, [config, projects, refreshConfig, tLauncher]);

  const handleUnarchive = useCallback(async (project: Project) => {
    if (archiveInFlightRef.current.has(project.id)) return;
    archiveInFlightRef.current.add(project.id);
    try {
      const latest = projects.find((candidate) => candidate.id === project.id) ?? project;
      const shouldRestoreAgent = latest.archivedAgentEnabledBeforeArchive === true;
      const restored = await unarchiveProject(latest.id);
      if (!restored) throw new Error(`Project ${latest.id} not found`);
      if (shouldRestoreAgent && latest.agentId) {
        try {
          await enableAgentAndStartChannels(latest.agentId);
        } catch (error) {
          await archiveProject(latest.id, {
            archivedAtIso: latest.archivedAt,
            agentEnabledBeforeArchive: true,
          });
          throw error;
        }
      }
      await refreshConfig();
      toastRef.current.success(tLauncher('toasts.workspaceUnarchived'));
    } catch (error) {
      console.error('[GlobalSidebar] Failed to unarchive workspace:', error);
      toastRef.current.warning(tLauncher('toasts.unarchiveFailed'));
    } finally {
      archiveInFlightRef.current.delete(project.id);
    }
  }, [projects, refreshConfig, tLauncher]);

  const handleOpenFolder = useCallback(async (project: Project) => {
    try {
      await openPathExternal({ fullPath: project.path, workspace: null });
    } catch (error) {
      console.error('[GlobalSidebar] Failed to open workspace folder:', error);
      toastRef.current.error(tLauncher('toasts.openFolderFailed'));
    }
  }, [openPathExternal, tLauncher]);

  const handleConfirmRemoveProject = useCallback(async () => {
    if (!projectToRemove) return;
    await removeProject(projectToRemove.id);
    setProjectToRemove(null);
    restoreChildLayerFocus();
  }, [projectToRemove, removeProject, restoreChildLayerFocus]);

  const handleOpenWorkspace = useCallback(async (
    project: Project,
    initialMessage?: InitialMessage,
    entryIntent: 'open_workspace' | 'workspace_init' = 'open_workspace',
  ) => {
    const opened = await onOpenWorkspace(project, initialMessage, entryIntent);
    if (opened) {
      void touchProject(project.id).catch(() => {});
      closeFlyout();
    }
  }, [closeFlyout, onOpenWorkspace, touchProject]);

  const handleOpenSession = useCallback(async (session: SessionMetadata, project: Project) => {
    const opened = await onOpenSession(session, project);
    if (opened) {
      void touchProject(project.id).catch(() => {});
      setSearchOpen(false);
      closeFlyout();
    }
  }, [closeFlyout, onOpenSession, touchProject]);

  const handleConfirmDeleteSession = useCallback(async () => {
    if (!pendingDeleteSession) return;
    const target = pendingDeleteSession;
    setPendingDeleteSession(null);
    try {
      const success = await taskCenterData.actions.deleteSession(target.id);
      if (success) toastRef.current.success(tLauncher('rightRail.deleted'));
      else toastRef.current.error(tLauncher('rightRail.deleteFailedRetry'));
    } catch (error) {
      console.error('[GlobalSidebar] Failed to delete session:', error);
      toastRef.current.error(tLauncher('rightRail.deleteFailed'));
    } finally {
      restoreChildLayerFocus();
    }
  }, [pendingDeleteSession, restoreChildLayerFocus, tLauncher, taskCenterData.actions]);

  const handleToggleFavorite = useCallback(async (session: SessionMetadata) => {
    const success = await taskCenterData.actions.setSessionFavorite(session.id, !session.favorite);
    if (!success) toastRef.current.error(tLauncher('rightRail.favoriteFailedRetry'));
  }, [tLauncher, taskCenterData.actions]);

  const handleSearchOpen = useCallback(() => {
    if (!isTauriEnvironment()) return;
    setSearchOpen(true);
  }, []);

  const activeView = activeTab?.view;
  const isWindows = typeof navigator !== 'undefined'
    && navigator.platform.toLowerCase().includes('win');
  const tree = (
    <WorkspaceTree
      projects={activeProjects}
      archivedProjects={archivedProjects}
      projectsLoading={projectsLoading}
      projectsError={projectsError}
      taskCenterData={taskCenterData}
      tabs={tabs}
      activeTab={activeTab}
      activeWorkspacePath={activeWorkspacePath}
      expandedWorkspaceKeys={preference.expandedWorkspaceKeys}
      sessionLimits={sessionLimits}
      showAutomationSessions={preference.showAutomationSessions}
      sessionView={preference.sessionView}
      archivedExpanded={archivedExpanded}
      sessionNotificationBadgeCounts={sessionNotificationBadgeCounts}
      onToggleWorkspace={handleToggleWorkspace}
      onRetryProjects={() => { void refreshConfig(); }}
      onLoadMore={handleLoadMore}
      onToggleArchived={() => setArchivedExpanded((value) => !value)}
      onSetSessionView={(sessionView) => updatePreference((current) => ({ ...current, sessionView }))}
      onToggleAutomation={() => updatePreference((current) => ({
        ...current,
        showAutomationSessions: !current.showAutomationSessions,
      }))}
      onAddFolder={handleAddFolder}
      onCreateFromTemplate={() => {
        rememberChildLayerOrigin();
        setTemplateDialogOpen(true);
      }}
      onOpenWorkspace={handleOpenWorkspace}
      onOpenSession={handleOpenSession}
      onTogglePin={handleTogglePin}
      onAgentSettings={(project, origin) => {
        rememberChildLayerOrigin(origin);
        setAgentWorkspacePath(project.path);
      }}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
      onOpenFolder={handleOpenFolder}
      onRemove={(project, origin) => {
        rememberChildLayerOrigin(origin);
        setProjectToRemove(project);
      }}
      onToggleFavorite={handleToggleFavorite}
      onShowStats={(session, origin) => {
        rememberChildLayerOrigin(origin);
        setStatsSession(session);
      }}
      onDeleteSession={(session, origin) => {
        rememberChildLayerOrigin(origin);
        setPendingDeleteSession(session);
      }}
      onNestedInteractionChange={handleNestedInteractionChange}
    />
  );

  return (
    <>
      <aside
        aria-label={t('globalSidebar.navigation')}
        data-global-sidebar-mode={effectiveMode}
        data-global-sidebar-toggle-visible={forceRail ? 'false' : 'true'}
        data-global-sidebar-tabbar-toggle={!isWindows && !forceRail && !expanded ? 'true' : 'false'}
        className={`global-sidebar relative z-40 flex h-screen shrink-0 flex-col border-r border-[var(--line)] bg-[var(--global-sidebar-bg)] text-[var(--ink)] ${
          expanded ? 'w-[var(--global-sidebar-expanded-width)]' : 'w-[var(--global-sidebar-rail-width)]'
        }`}
      >
        <div className="custom-titlebar relative h-11 shrink-0" data-tauri-drag-region>
          {!forceRail && (
            <button
              type="button"
              onClick={handleToggleMode}
              className={`absolute top-1.5 flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                isWindows ? 'left-3' : 'left-[var(--global-sidebar-toggle-left)]'
              }`}
              aria-label={expanded ? t('globalSidebar.collapse') : t('globalSidebar.expand')}
              title={expanded ? t('globalSidebar.collapse') : t('globalSidebar.expand')}
              data-global-sidebar-toggle
              data-no-drag
            >
              {expanded
                ? <PanelLeftClose className="h-4 w-4" />
                : <PanelLeftOpen className="h-4 w-4" />}
            </button>
          )}
        </div>

        <div
          className="global-sidebar-brand-row relative flex h-10 shrink-0 items-center"
          data-global-sidebar-brand-row
        >
          <img
            src={myAgentsLogo}
            alt={expanded ? '' : 'MyAgents'}
            aria-hidden={expanded || undefined}
            className="global-sidebar-brand-icon shrink-0"
            data-global-sidebar-brand-icon
          />
          {expanded && <span className="min-w-0 truncate text-sm font-semibold tracking-wide">MyAgents</span>}
        </div>

        <nav
          className={`shrink-0 ${expanded ? 'px-3 pb-2 pt-1' : 'global-sidebar-rail-stack pb-2 pt-1'}`}
          data-global-sidebar-primary-nav
        >
          <SidebarNavButton
            expanded={expanded}
            icon={<MessageSquarePlus className="h-4 w-4" />}
            label={t('globalSidebar.newChat')}
            onClick={onNewTab}
          />
          {isTauriEnvironment() && (
            <SidebarNavButton
              expanded={expanded}
              icon={<Search className="h-4 w-4" />}
              label={t('globalSidebar.search')}
              onClick={handleSearchOpen}
            />
          )}
          <SidebarNavButton
            expanded={expanded}
            active={activeView === 'taskcenter'}
            icon={<CheckSquare className="h-4 w-4" />}
            label={t('globalSidebar.tasks')}
            onClick={handleOpenTaskCenter}
          />
          <SidebarNavButton
            expanded={expanded}
            active={activeView === 'space'}
            icon={<Cloud className="h-4 w-4" />}
            label={t('globalSidebar.team')}
            onClick={onOpenSpace}
          />
          <SidebarNavButton
            expanded={expanded}
            active={activeView === 'capabilities'}
            icon={<Sparkles className="h-4 w-4" />}
            label={t('globalSidebar.capabilities')}
            onClick={() => onOpenCapabilities()}
          />
        </nav>

        {expanded ? (
          <div className="min-h-0 flex-1 border-t border-[var(--line-subtle)]">{tree}</div>
        ) : (
          <div
            className="global-sidebar-rail-stack min-h-0 flex-1 border-t border-[var(--line-subtle)] pt-3"
            data-global-sidebar-workspace-rail
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !flyoutOpen) return;
              event.preventDefault();
              closeFlyout(true);
            }}
          >
            <div
              onPointerEnter={scheduleFlyoutOpen}
              onPointerLeave={scheduleFlyoutClose}
              onFocusCapture={openFlyoutNow}
              onBlurCapture={scheduleFlyoutClose}
            >
              <button
                ref={flyoutTriggerRef}
                type="button"
                onClick={openFlyoutNow}
                aria-label={t('globalSidebar.workspaces')}
                aria-expanded={flyoutOpen}
                className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  activeWorkspacePath
                    ? 'bg-[var(--hover-bg)] text-[var(--ink)]'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                }`}
              >
                <FolderTree className="h-4 w-4" />
              </button>
            </div>
            {flyoutOpen && (
              <div
                ref={flyoutRef}
                className="absolute bottom-3 left-full top-12 z-[240] ml-2 w-[var(--global-sidebar-flyout-width)] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-md"
                data-global-sidebar-flyout
                onPointerEnter={clearFlyoutTimers}
                onPointerLeave={scheduleFlyoutClose}
                onFocusCapture={clearFlyoutTimers}
                onBlurCapture={scheduleFlyoutClose}
              >
                {tree}
              </div>
            )}
          </div>
        )}

        <div
          className={`shrink-0 border-t border-[var(--line-subtle)] py-3 ${expanded ? 'px-3' : 'global-sidebar-rail-stack'}`}
          data-global-sidebar-footer-actions
        >
          <div ref={feedbackTriggerRef} className={expanded ? '' : 'flex justify-center'}>
            <SidebarNavButton
              expanded={expanded}
              icon={<Bot className="h-4 w-4" />}
              label={t('globalSidebar.helper')}
              onClick={() => setShowFeedback((value) => !value)}
            />
            <FeedbackPopover
              open={showFeedback}
              onClose={() => setShowFeedback(false)}
              onOpenBugReport={() => { setShowFeedback(false); onOpenBugReport(); }}
              triggerRef={feedbackTriggerRef}
            />
          </div>
          <SidebarNavButton
            expanded={expanded}
            active={activeView === 'settings'}
            icon={<Settings className="h-4 w-4" />}
            label={t('globalSidebar.settings')}
            onClick={onOpenSettings}
          />
        </div>
      </aside>

      <PathInputDialog
        isOpen={pathDialogOpen}
        folderName={pendingFolderName}
        defaultPath={pendingDefaultPath}
        onConfirm={handlePathConfirm}
        onCancel={() => {
          setPathDialogOpen(false);
          restoreChildLayerFocus();
        }}
      />

      {templateDialogOpen && (
        <TemplateLibraryDialog
          onCreateWorkspace={handleCreateFromTemplate}
          onClose={() => {
            setTemplateDialogOpen(false);
            restoreChildLayerFocus();
          }}
        />
      )}

      {projectToRemove && (
        <ConfirmDialog
          title={isSystemPresetProject(projectToRemove)
            ? tLauncher('dialogs.hideDefaultWorkspace')
            : tLauncher('dialogs.removeWorkspace')}
          message={isSystemPresetProject(projectToRemove)
            ? tLauncher('dialogs.hideWorkspaceMessage', { name: projectToRemove.displayName || projectToRemove.name })
            : tLauncher('dialogs.removeWorkspaceMessage', { name: projectToRemove.name })}
          confirmText={isSystemPresetProject(projectToRemove) ? tLauncher('dialogs.hide') : tLauncher('dialogs.remove')}
          confirmVariant="danger"
          onConfirm={handleConfirmRemoveProject}
          onCancel={() => {
            setProjectToRemove(null);
            restoreChildLayerFocus();
          }}
        />
      )}

      {pendingDeleteSession && (
        <ConfirmDialog
          title={tLauncher('rightRail.deleteDialogTitle')}
          message={tLauncher('rightRail.deleteDialogMessage', { title: getSessionDisplayText(pendingDeleteSession) })}
          confirmText={tLauncher('rightRail.delete')}
          confirmVariant="danger"
          onConfirm={handleConfirmDeleteSession}
          onCancel={() => {
            setPendingDeleteSession(null);
            restoreChildLayerFocus();
          }}
        />
      )}

      {statsSession && (
        <SessionStatsModal
          sessionId={statsSession.id}
          sessionTitle={getSessionDisplayText(statsSession)}
          onClose={() => {
            setStatsSession(null);
            restoreChildLayerFocus();
          }}
        />
      )}

      {agentWorkspacePath && (
        <Suspense fallback={null}>
          <WorkspaceConfigPanel
            agentDir={agentWorkspacePath}
            initialTab="agent"
            onClose={() => {
              setAgentWorkspacePath(null);
              restoreChildLayerFocus();
            }}
            onRequestInit={() => {
              const project = activeProjects.find((candidate) => workspacePathsEqual(candidate.path, agentWorkspacePath));
              setAgentWorkspacePath(null);
              childLayerReturnFocusRef.current = null;
              if (project) void handleOpenWorkspace(project, { text: '/init' }, 'workspace_init');
            }}
          />
        </Suspense>
      )}

      {searchOpen && (
        <Suspense fallback={null}>
          <TaskCenterOverlay
            projects={activeProjects}
            taskCenterData={taskCenterData}
            initialMode="search"
            onClose={() => setSearchOpen(false)}
            onOpenTask={(session, project) => { void handleOpenSession(session, project); }}
          />
        </Suspense>
      )}
    </>
  );
});

interface WorkspaceTreeProps {
  projects: Project[];
  archivedProjects: Project[];
  projectsLoading: boolean;
  projectsError: string | null;
  taskCenterData: TaskCenterData;
  tabs: readonly Tab[];
  activeTab: Tab | undefined;
  activeWorkspacePath: string | null;
  expandedWorkspaceKeys: string[];
  sessionLimits: Record<string, number>;
  showAutomationSessions: boolean;
  sessionView: 'all' | 'favorites';
  archivedExpanded: boolean;
  sessionNotificationBadgeCounts?: ReadonlyMap<string, number>;
  onToggleWorkspace: (project: Project) => void;
  onRetryProjects: () => void;
  onLoadMore: (project: Project, total: number) => void;
  onToggleArchived: () => void;
  onSetSessionView: (view: 'all' | 'favorites') => void;
  onToggleAutomation: () => void;
  onAddFolder: () => void;
  onCreateFromTemplate: () => void;
  onOpenWorkspace: (project: Project) => void;
  onOpenSession: (session: SessionMetadata, project: Project) => void;
  onTogglePin: (project: Project) => void;
  onAgentSettings: (project: Project, origin?: HTMLElement | null) => void;
  onArchive: (project: Project) => void;
  onUnarchive: (project: Project) => void;
  onOpenFolder: (project: Project) => void;
  onRemove: (project: Project, origin?: HTMLElement | null) => void;
  onToggleFavorite: (session: SessionMetadata) => void;
  onShowStats: (session: SessionMetadata, origin?: HTMLElement | null) => void;
  onDeleteSession: (session: SessionMetadata, origin?: HTMLElement | null) => void;
  onNestedInteractionChange: (key: string, open: boolean) => void;
}

function WorkspaceTree({
  projects,
  archivedProjects,
  projectsLoading,
  projectsError,
  taskCenterData,
  tabs,
  activeTab,
  activeWorkspacePath,
  expandedWorkspaceKeys,
  sessionLimits,
  showAutomationSessions,
  sessionView,
  archivedExpanded,
  sessionNotificationBadgeCounts,
  onToggleWorkspace,
  onRetryProjects,
  onLoadMore,
  onToggleArchived,
  onSetSessionView,
  onToggleAutomation,
  onAddFolder,
  onCreateFromTemplate,
  onOpenWorkspace,
  onOpenSession,
  onTogglePin,
  onAgentSettings,
  onArchive,
  onUnarchive,
  onOpenFolder,
  onRemove,
  onToggleFavorite,
  onShowStats,
  onDeleteSession,
  onNestedInteractionChange,
}: WorkspaceTreeProps) {
  const { t } = useTranslation('app');
  const { t: tLauncher } = useTranslation('launcher');
  const expandedSet = useMemo(() => new Set(expandedWorkspaceKeys), [expandedWorkspaceKeys]);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewMenuRef = useRef<HTMLButtonElement | null>(null);
  const workspaceRefs = useRef(new Map<string, HTMLDivElement>());

  const sessionsByWorkspace = useMemo(() => {
    const map = new Map<string, SessionMetadata[]>();
    for (const session of taskCenterData.sessions) {
      if (!showAutomationSessions && isAutomationHistoryOrigin(session.origin, {
        cronTaskId: session.cronTaskId,
        source: session.source,
      })) continue;
      if (sessionView === 'favorites' && !session.favorite) continue;
      const key = normalizeWorkspacePathIdentity(session.agentDir);
      const list = map.get(key) ?? [];
      list.push(session);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
    }
    return map;
  }, [sessionView, showAutomationSessions, taskCenterData.sessions]);

  const tabBySession = useMemo(() => {
    const map = new Map<string, Tab>();
    for (const tab of tabs) {
      if (tab.sessionId) map.set(tab.sessionId, tab);
    }
    return map;
  }, [tabs]);

  const activeWorkspaceKey = activeWorkspacePath
    ? normalizeWorkspacePathIdentity(activeWorkspacePath)
    : null;

  useEffect(() => {
    if (!activeWorkspaceKey) return;
    const workspaceNode = workspaceRefs.current.get(activeWorkspaceKey);
    if (typeof workspaceNode?.scrollIntoView === 'function') {
      workspaceNode.scrollIntoView({ block: 'nearest' });
    }
  }, [activeWorkspaceKey]);

  const setViewMenu = useCallback((open: boolean) => {
    setViewMenuOpen(open);
    onNestedInteractionChange('view-options', open);
  }, [onNestedInteractionChange]);
  useNestedInteractionCleanup((open) => onNestedInteractionChange('view-options', open));

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('globalSidebar.workspaces')}>
      <div className="flex h-12 shrink-0 items-center gap-1 px-3">
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
          {t('globalSidebar.workspaceSection')}
        </h2>
        <AddWorkspaceMenu
          variant="icon"
          onAddFolder={onAddFolder}
          onCreateFromTemplate={onCreateFromTemplate}
          onOpenChange={(open) => onNestedInteractionChange('add-workspace', open)}
        />
        <button
          ref={viewMenuRef}
          type="button"
          onClick={() => setViewMenu(!viewMenuOpen)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          aria-label={t('globalSidebar.workspaceViewOptions')}
          title={t('globalSidebar.workspaceViewOptions')}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        <Popover
          open={viewMenuOpen}
          onClose={() => setViewMenu(false)}
          anchorRef={viewMenuRef}
          placement="bottom-end"
          className="global-sidebar-nested-layer w-56 py-1"
        >
          <MenuItem
            icon={sessionView === 'all' ? <Check className="h-3.5 w-3.5" /> : <LayoutGrid className="h-3.5 w-3.5" />}
            label={t('globalSidebar.allSessions')}
            active={sessionView === 'all'}
            onClick={() => { onSetSessionView('all'); setViewMenu(false); }}
          />
          <MenuItem
            icon={sessionView === 'favorites' ? <Check className="h-3.5 w-3.5" /> : <Star className="h-3.5 w-3.5" />}
            label={t('globalSidebar.favoriteSessions')}
            active={sessionView === 'favorites'}
            onClick={() => { onSetSessionView('favorites'); setViewMenu(false); }}
          />
          <MenuItem
            icon={showAutomationSessions ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            label={showAutomationSessions
              ? t('globalSidebar.hideAutomationHistory')
              : t('globalSidebar.showAutomationHistory')}
            onClick={() => { onToggleAutomation(); setViewMenu(false); }}
          />
        </Popover>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3" role="tree">
        {projectsLoading ? (
          <div className="space-y-2 px-1 py-2" aria-label={t('common.loading')}>
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-10 animate-pulse rounded-lg bg-[var(--paper-inset)]/70 motion-reduce:animate-none" />
            ))}
          </div>
        ) : projectsError ? (
          <div className="mx-1 my-2 rounded-lg border border-dashed border-[var(--line)] px-3 py-3">
            <div className="flex items-center gap-2 text-xs text-[var(--warning)]">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{projectsError}</span>
              <button
                type="button"
                onClick={onRetryProjects}
                className="rounded-md p-1 hover:bg-[var(--paper-inset)]"
                aria-label={tLauncher('rightRail.retry')}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : projects.length === 0 && archivedProjects.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-sm font-medium text-[var(--ink)]">{tLauncher('rightRail.emptyWorkspaceTitle')}</p>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">{tLauncher('rightRail.emptyWorkspaceDescription')}</p>
            <button
              type="button"
              onClick={onAddFolder}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
            >
              <Plus className="h-3.5 w-3.5" />
              {tLauncher('rightRail.addFolder')}
            </button>
          </div>
        ) : (
          <div data-global-sidebar-workspace-list>
            {projects.map((project) => {
              const key = normalizeWorkspacePathIdentity(project.path);
              const sessions = sessionsByWorkspace.get(key) ?? [];
              const limit = sessionLimits[key] ?? SESSION_PAGE_SIZE;
              const workspaceSessionState = taskCenterData.workspaceSessionStates.get(key);
              return (
                <div
                  key={project.id}
                  ref={(node) => {
                    if (node) workspaceRefs.current.set(key, node);
                    else workspaceRefs.current.delete(key);
                  }}
                >
                  <WorkspaceRow
                    project={project}
                    expanded={expandedSet.has(key)}
                    active={activeWorkspaceKey === key}
                    onToggle={() => onToggleWorkspace(project)}
                    onOpenWorkspace={() => onOpenWorkspace(project)}
                    onTogglePin={() => onTogglePin(project)}
                    onAgentSettings={(origin) => onAgentSettings(project, origin)}
                    onArchive={() => onArchive(project)}
                    onOpenFolder={() => onOpenFolder(project)}
                    onRemove={(origin) => onRemove(project, origin)}
                    onMenuOpenChange={(open) => onNestedInteractionChange(`workspace:${project.id}`, open)}
                  />
                  {expandedSet.has(key) && (
                    <div role="group" className="ml-5 border-l border-[var(--line-subtle)] pl-2">
                      {workspaceSessionState?.isLoading && sessions.length === 0 ? (
                        <div className="space-y-1 py-1">
                          {[0, 1, 2].map((item) => (
                            <div key={item} className="h-9 animate-pulse rounded-lg bg-[var(--paper-inset)]/60 motion-reduce:animate-none" />
                          ))}
                        </div>
                      ) : (
                        <>
                          {workspaceSessionState?.error && (
                            <div className="my-1 rounded-lg border border-dashed border-[var(--line)] px-3 py-2">
                              <div className="flex items-center gap-2 text-xs text-[var(--warning)]">
                                <AlertCircle className="h-3.5 w-3.5" />
                                <span className="min-w-0 flex-1 truncate">{workspaceSessionState.error}</span>
                                <button
                                  type="button"
                                  onClick={() => ensureWorkspaceSessions([project.path], true)}
                                  className="rounded-md p-1 hover:bg-[var(--paper-inset)]"
                                  aria-label={tLauncher('rightRail.retry')}
                                >
                                  <RefreshCw className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          )}
                          {sessions.length === 0 && !workspaceSessionState?.error ? (
                            <p className="px-3 py-2 text-xs text-[var(--ink-muted)]/70">
                              {sessionView === 'favorites'
                                ? tLauncher('rightRail.emptyFavorites')
                                : t('globalSidebar.emptyWorkspaceSessions')}
                            </p>
                          ) : sessions.slice(0, limit).map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              project={project}
                              tab={tabBySession.get(session.id)}
                              active={activeTab?.view === 'chat' && activeTab.sessionId === session.id}
                              tags={taskCenterData.sessionTagsMap.get(session.id) ?? EMPTY_TAGS}
                              unreadNotificationCount={sessionNotificationBadgeCounts?.get(session.id) ?? 0}
                              deleteProtected={taskCenterData.protectedSchedulerSessionIds.has(session.id)}
                              onOpen={() => onOpenSession(session, project)}
                              onToggleFavorite={() => onToggleFavorite(session)}
                              onShowStats={(origin) => onShowStats(session, origin)}
                              onDelete={(origin) => onDeleteSession(session, origin)}
                              onMenuOpenChange={(open) => onNestedInteractionChange(`session:${session.id}`, open)}
                            />
                          ))}
                          {limit < sessions.length && (
                            <button
                              type="button"
                              onClick={() => onLoadMore(project, sessions.length)}
                              className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                            >
                              <ChevronDown className="h-3.5 w-3.5" />
                              {t('globalSidebar.loadMore')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {archivedProjects.length > 0 && (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={onToggleArchived}
                  aria-expanded={archivedExpanded}
                  className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <ChevronRight className={`h-4 w-4 transition-transform ${archivedExpanded ? 'rotate-90' : ''}`} />
                  <Archive className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate text-left">{t('globalSidebar.archived')}</span>
                  <span className="text-xs tabular-nums text-[var(--ink-subtle)]">{archivedProjects.length}</span>
                </button>
                {archivedExpanded && (
                  <div className="ml-5 border-l border-[var(--line-subtle)] pl-2">
                    {archivedProjects.map((project) => (
                      <ArchivedWorkspaceRow
                        key={project.id}
                        project={project}
                        onUnarchive={() => onUnarchive(project)}
                        onAgentSettings={(origin) => onAgentSettings(project, origin)}
                        onOpenFolder={() => onOpenFolder(project)}
                        onRemove={(origin) => onRemove(project, origin)}
                        onMenuOpenChange={(open) => onNestedInteractionChange(`archived:${project.id}`, open)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

interface WorkspaceRowProps {
  project: Project;
  expanded: boolean;
  active: boolean;
  onToggle: () => void;
  onOpenWorkspace: () => void;
  onTogglePin: () => void;
  onAgentSettings: (origin?: HTMLElement | null) => void;
  onArchive: () => void;
  onOpenFolder: () => void;
  onRemove: (origin?: HTMLElement | null) => void;
  onMenuOpenChange: (open: boolean) => void;
}

function WorkspaceRow({
  project,
  expanded,
  active,
  onToggle,
  onOpenWorkspace,
  onTogglePin,
  onAgentSettings,
  onArchive,
  onOpenFolder,
  onRemove,
  onMenuOpenChange,
}: WorkspaceRowProps) {
  const { t } = useTranslation('app');
  const { t: tLauncher } = useTranslation('launcher');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const displayName = project.displayName || project.name;

  const setMenu = useCallback((open: boolean) => {
    setMenuOpen(open);
    onMenuOpenChange(open);
  }, [onMenuOpenChange]);
  useNestedInteractionCleanup(onMenuOpenChange);

  return (
    <div
      role="treeitem"
      aria-expanded={expanded}
      aria-current={active ? 'page' : undefined}
      className={`group/workspace flex h-10 items-center rounded-lg transition-colors hover:bg-[var(--hover-bg)] ${
        active ? 'bg-[var(--hover-bg)]' : ''
      }`}
      data-global-sidebar-workspace-row
      onContextMenu={(event) => {
        event.preventDefault();
        menuRef.current?.focus();
        setMenu(true);
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
      >
        <ChevronRight className={`h-4 w-4 shrink-0 text-[var(--ink-muted)] transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <WorkspaceIcon icon={project.icon} size={16} />
        <span className="min-w-0 flex-1 truncate font-medium">{displayName}</span>
      </button>
      <div className={`flex shrink-0 items-center pr-1 transition-opacity ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover/workspace:opacity-100 group-focus-within/workspace:opacity-100'}`}>
        <button
          type="button"
          onClick={onOpenWorkspace}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          title={t('globalSidebar.newChatHere')}
          aria-label={t('globalSidebar.newChatHere')}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
        </button>
        <button
          ref={menuRef}
          type="button"
          onClick={() => setMenu(!menuOpen)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          title={tLauncher('workspaceCard.more')}
          aria-label={tLauncher('workspaceCard.more')}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      <Popover
        open={menuOpen}
        onClose={() => {
          setMenu(false);
          menuRef.current?.focus();
        }}
        anchorRef={menuRef}
        placement="bottom-end"
        className="global-sidebar-nested-layer w-44 py-1"
      >
        <MenuItem
          icon={project.pinnedAt ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          label={project.pinnedAt ? tLauncher('workspaceCard.unpin') : tLauncher('workspaceCard.pin')}
          onClick={() => { setMenu(false); onTogglePin(); }}
        />
        <MenuItem icon={<Settings2 className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.agentSettings')} onClick={() => { setMenu(false); onAgentSettings(menuRef.current); }} />
        <MenuItem icon={<Archive className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.archive')} onClick={() => { setMenu(false); onArchive(); }} />
        <MenuItem icon={<FolderOpen className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.openFolder')} onClick={() => { setMenu(false); onOpenFolder(); }} />
        <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.remove')} tone="danger" onClick={() => { setMenu(false); onRemove(menuRef.current); }} />
      </Popover>
    </div>
  );
}

interface SessionRowProps {
  session: SessionMetadata;
  project: Project;
  tab: Tab | undefined;
  active: boolean;
  tags: SessionTag[];
  unreadNotificationCount: number;
  deleteProtected: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onShowStats: (origin?: HTMLElement | null) => void;
  onDelete: (origin?: HTMLElement | null) => void;
  onMenuOpenChange: (open: boolean) => void;
}

function SessionRow({
  session,
  tab,
  active,
  tags,
  unreadNotificationCount,
  deleteProtected,
  onOpen,
  onToggleFavorite,
  onShowStats,
  onDelete,
  onMenuOpenChange,
}: SessionRowProps) {
  const { t: tLauncher, i18n } = useTranslation('launcher');
  const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const setMenu = useCallback((open: boolean) => {
    setMenuOpen(open);
    onMenuOpenChange(open);
  }, [onMenuOpenChange]);
  useNestedInteractionCleanup(onMenuOpenChange);

  return (
    <div
      role="treeitem"
      aria-current={active ? 'page' : undefined}
      className={`group/session relative flex h-9 items-center rounded-lg pl-2 pr-1 transition-colors focus-within:bg-[var(--hover-bg)] ${
        active ? 'bg-[var(--hover-bg)] text-[var(--ink)]' : 'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]'
      }`}
      data-global-sidebar-session-row
      onContextMenu={(event) => {
        event.preventDefault();
        menuRef.current?.focus();
        setMenu(true);
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full w-full min-w-0 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
      >
        <SessionStateIcon tab={tab} active={active} />
        <span
          className="min-w-0 flex-1 truncate text-xs"
          data-global-sidebar-session-title
        >
          {getSessionDisplayText(session)}
        </span>
        {session.favorite && <Star className="h-3 w-3 shrink-0 text-[var(--accent)]" fill="currentColor" />}
        {tags.map((tag, index) => <SessionTagBadge key={`${tag.type}-${index}`} tag={tag} />)}
        <UnreadNotificationIndicator
          count={unreadNotificationCount}
          label={tLauncher('rightRail.unreadNotifications', { count: unreadNotificationCount })}
        />
        <span
          className={`ml-auto shrink-0 text-xs tabular-nums text-[var(--ink-muted)]/55 transition-opacity ${
            menuOpen ? 'opacity-0' : 'group-hover/session:opacity-0 group-focus-within/session:opacity-0'
          }`}
          data-global-sidebar-session-date
        >
          {formatTime(session.lastActiveAt, new Date(), locale)}
        </span>
      </button>
      <div
        className={`absolute inset-y-0 right-1 flex w-9 items-center justify-end transition-opacity ${
          menuOpen
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100'
        }`}
        data-global-sidebar-session-action-overlay
      >
        <button
          ref={menuRef}
          type="button"
          onClick={() => setMenu(!menuOpen)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          title={tLauncher('rightRail.more')}
          aria-label={tLauncher('rightRail.more')}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      <Popover
        open={menuOpen}
        onClose={() => {
          setMenu(false);
          menuRef.current?.focus();
        }}
        anchorRef={menuRef}
        placement="bottom-end"
        className="global-sidebar-nested-layer w-44 py-1"
      >
        <MenuItem
          icon={<Star className="h-3.5 w-3.5" fill={session.favorite ? 'currentColor' : 'none'} />}
          label={session.favorite ? tLauncher('rightRail.unfavorite') : tLauncher('rightRail.favorite')}
          onClick={() => { setMenu(false); onToggleFavorite(); }}
        />
        <MenuItem icon={<BarChart2 className="h-3.5 w-3.5" />} label={tLauncher('rightRail.viewStats')} onClick={() => { setMenu(false); onShowStats(menuRef.current); }} />
        <MenuItem
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label={tLauncher('rightRail.delete')}
          tone="danger"
          disabled={deleteProtected}
          title={deleteProtected ? tLauncher('rightRail.stopCronBeforeDelete') : undefined}
          onClick={() => {
            if (deleteProtected) return;
            setMenu(false);
            onDelete(menuRef.current);
          }}
        />
      </Popover>
    </div>
  );
}

function SessionStateIcon({ tab, active }: { tab: Tab | undefined; active: boolean }) {
  if (tab?.isGenerating) return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--accent)] motion-reduce:animate-none" />;
  if (tab?.hasUnread) return <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" aria-hidden="true" />;
  if (active) return <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" aria-hidden="true" />;
  if (tab) return <PanelTop className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />;
  return null;
}

interface ArchivedWorkspaceRowProps {
  project: Project;
  onUnarchive: () => void;
  onAgentSettings: (origin?: HTMLElement | null) => void;
  onOpenFolder: () => void;
  onRemove: (origin?: HTMLElement | null) => void;
  onMenuOpenChange: (open: boolean) => void;
}

function ArchivedWorkspaceRow({ project, onUnarchive, onAgentSettings, onOpenFolder, onRemove, onMenuOpenChange }: ArchivedWorkspaceRowProps) {
  const { t: tLauncher } = useTranslation('launcher');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const setMenu = useCallback((open: boolean) => {
    setMenuOpen(open);
    onMenuOpenChange(open);
  }, [onMenuOpenChange]);
  useNestedInteractionCleanup(onMenuOpenChange);
  return (
    <div className="group/archive flex h-10 items-center gap-2 rounded-lg px-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]">
      <WorkspaceIcon icon={project.icon} size={16} />
      <span className="min-w-0 flex-1 truncate">{project.displayName || project.name}</span>
      <button
        ref={menuRef}
        type="button"
        onClick={() => setMenu(!menuOpen)}
        className={`flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] ${menuOpen ? '' : 'opacity-0 group-hover/archive:opacity-100 group-focus-within/archive:opacity-100'}`}
        aria-label={tLauncher('workspaceCard.more')}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      <Popover
        open={menuOpen}
        onClose={() => {
          setMenu(false);
          menuRef.current?.focus();
        }}
        anchorRef={menuRef}
        placement="bottom-end"
        className="global-sidebar-nested-layer w-44 py-1"
      >
        <MenuItem icon={<RotateCcw className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.unarchive')} onClick={() => { setMenu(false); onUnarchive(); }} />
        <MenuItem icon={<Settings2 className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.agentSettings')} onClick={() => { setMenu(false); onAgentSettings(menuRef.current); }} />
        <MenuItem icon={<FolderOpen className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.openFolder')} onClick={() => { setMenu(false); onOpenFolder(); }} />
        <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} label={tLauncher('workspaceCard.remove')} tone="danger" onClick={() => { setMenu(false); onRemove(menuRef.current); }} />
      </Popover>
    </div>
  );
}
