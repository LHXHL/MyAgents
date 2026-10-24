import { lazy, memo, Suspense } from 'react';
import type { TabModuleDefinition } from '@/tab-workspace/contracts';
import { PAGE_FALLBACK } from '@/tab-workspace/PageFallback';
import type { TeamAiTab } from './tabContract';
import type { Project } from '@/config/types';
import type { SessionMetadata } from '@/api/sessionClient';
const TeamAi = lazy(() => import('@/pages/TeamAi'));
export interface TeamAiBinding {
  onCreate: () => void;
  onOpenSession: (session: SessionMetadata, project: Project) => unknown;
  onOpenWorkspace: (project: Project) => void;
  onSelectProject: (tabId: string, projectId: string) => void;
}
const Renderer = memo(function TeamAiRenderer({ tab, isActive, isDeferred, binding }: {
  tab: TeamAiTab; isActive: boolean; isDeferred: boolean; binding: TeamAiBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return <Suspense fallback={PAGE_FALLBACK}><TeamAi key={tab.projectId} isActive={isActive} {...binding} projectId={tab.projectId} onSelectProject={projectId => binding.onSelectProject(tab.id, projectId)} /></Suspense>;
});
export const teamAiTabModule = {
  kind: 'teamai', render: Renderer,
  chrome: (_tab, { t }) => ({ title: t('tabs.teamAi'), subtitle: t('tabs.teamAi') }),
  identity: () => 'teamai',
  open: { findExisting: tabs => tabs[0], create: (intent, { id }) => ({ id, view: 'teamai', title: intent.title, projectId: intent.projectId }), reopen: (tab, intent) => ({ ...tab, ...(intent.projectId ? { projectId: intent.projectId } : {}) }) },
  initialMount: () => 'deferred-content',
} satisfies TabModuleDefinition<TeamAiTab, { title: string; projectId?: string }, TeamAiBinding>;
