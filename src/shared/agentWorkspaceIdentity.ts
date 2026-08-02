import {
  PRESET_TEMPLATES,
  type Project,
  type WorkspaceTemplate,
  type WorkspaceTemplateAgentDefaults,
} from './config-types';
import type { AgentConfig } from './types/agent';
import { normalizeWorkspacePathIdentity } from './workspacePath';

/**
 * The persisted Project and Agent shapes intentionally remain independently
 * evolvable. This is the required product-domain projection used after the two
 * stores have been reconciled.
 */
export interface ResolvedAgentWorkspaceIdentity<
  P extends AgentWorkspaceProjectRecord = AgentWorkspaceProjectRecord,
  A extends AgentWorkspaceAgentRecord = AgentWorkspaceAgentRecord,
> {
  projectId: string;
  agentId: string;
  workspacePath: string;
  project: P;
  agent: A;
}

export interface AgentWorkspaceProjectRecord {
  id: string;
  name: string;
  path: string;
  agentId?: string;
  isAgent?: boolean;
}

export interface AgentWorkspaceAgentRecord {
  id: string;
  workspacePath?: string;
  enabled?: boolean;
}

export type AgentWorkspaceIdentityErrorCode =
  | 'INVALID_PROJECT_IDENTITY'
  | 'DUPLICATE_PROJECT_ID'
  | 'DUPLICATE_PROJECT_WORKSPACE'
  | 'DUPLICATE_AGENT_ID'
  | 'MULTIPLE_AGENTS_FOR_WORKSPACE'
  | 'AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS'
  | 'CREATED_AGENT_ID_COLLISION';

export class AgentWorkspaceIdentityError extends Error {
  readonly code: AgentWorkspaceIdentityErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: AgentWorkspaceIdentityErrorCode,
    message: string,
    details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentWorkspaceIdentityError';
    this.code = code;
    this.details = details;
  }
}

export interface ReconcileAgentWorkspaceIdentityOptions<
  P extends AgentWorkspaceProjectRecord,
  A extends AgentWorkspaceAgentRecord,
> {
  buildAgent: (project: P) => A;
}

export interface ReconcileAgentWorkspaceIdentityResult<
  P extends AgentWorkspaceProjectRecord,
  A extends AgentWorkspaceAgentRecord,
> {
  projects: P[];
  agents: A[];
  identities: Array<ResolvedAgentWorkspaceIdentity<P, A>>;
  changed: boolean;
  createdAgentIds: string[];
  relinkedProjectIds: string[];
}

/**
 * Pure reconciliation policy for the persisted Project ↔ Agent 1:1 invariant.
 *
 * It never guesses through ambiguity and never deletes orphan Agent records.
 * I/O owners run this while holding agent-config-intent.lock, then persist the
 * returned arrays through their existing per-file atomic writers.
 */
export function reconcileAgentWorkspaceIdentities<
  P extends AgentWorkspaceProjectRecord,
  A extends AgentWorkspaceAgentRecord,
>(
  projects: readonly P[],
  agents: readonly A[],
  options: ReconcileAgentWorkspaceIdentityOptions<P, A>,
): ReconcileAgentWorkspaceIdentityResult<P, A> {
  const nextProjects = projects.map(project => ({ ...project }));
  const nextAgents = [...agents];
  const createdAgentIds: string[] = [];
  const relinkedProjectIds: string[] = [];

  const projectIds = new Set<string>();
  const projectsByWorkspace = new Map<string, P>();
  for (const project of nextProjects) {
    const workspaceIdentity = normalizeWorkspacePathIdentity(project.path);
    if (!project.id || !workspaceIdentity) {
      throw new AgentWorkspaceIdentityError(
        'INVALID_PROJECT_IDENTITY',
        `Project '${project.id || '(missing id)'}' has no canonical workspace path.`,
        { projectId: project.id, workspacePath: project.path },
      );
    }
    if (projectIds.has(project.id)) {
      throw new AgentWorkspaceIdentityError(
        'DUPLICATE_PROJECT_ID',
        `Project id '${project.id}' is duplicated.`,
        { projectId: project.id },
      );
    }
    projectIds.add(project.id);
    const existingProject = projectsByWorkspace.get(workspaceIdentity);
    if (existingProject) {
      throw new AgentWorkspaceIdentityError(
        'DUPLICATE_PROJECT_WORKSPACE',
        `Projects '${existingProject.id}' and '${project.id}' resolve to the same workspace.`,
        {
          projectIds: [existingProject.id, project.id],
          workspacePath: project.path,
        },
      );
    }
    projectsByWorkspace.set(workspaceIdentity, project);
  }

  const agentsById = new Map<string, A>();
  const agentsByWorkspace = new Map<string, A[]>();
  for (const agent of nextAgents) {
    if (!agent.id || agentsById.has(agent.id)) {
      throw new AgentWorkspaceIdentityError(
        'DUPLICATE_AGENT_ID',
        `Agent id '${agent.id || '(missing id)'}' is duplicated.`,
        { agentId: agent.id },
      );
    }
    agentsById.set(agent.id, agent);
    const workspaceIdentity = normalizeWorkspacePathIdentity(agent.workspacePath ?? '');
    if (!workspaceIdentity) continue;
    const matching = agentsByWorkspace.get(workspaceIdentity) ?? [];
    matching.push(agent);
    agentsByWorkspace.set(workspaceIdentity, matching);
  }

  // A duplicated explicit claim is corrupted ownership evidence, not a stale
  // path that may be silently repaired. Reject it before selecting or creating
  // any replacement Agent so the persisted conflict remains diagnosable.
  const rawProjectClaimsByAgent = new Map<string, string[]>();
  for (const project of nextProjects) {
    if (!project.agentId || !agentsById.has(project.agentId)) continue;
    const claims = rawProjectClaimsByAgent.get(project.agentId) ?? [];
    claims.push(project.id);
    rawProjectClaimsByAgent.set(project.agentId, claims);
  }
  for (const [agentId, projectIds] of rawProjectClaimsByAgent) {
    if (projectIds.length < 2) continue;
    throw new AgentWorkspaceIdentityError(
      'AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS',
      `Agent '${agentId}' is explicitly linked by multiple Projects.`,
      { agentId, projectIds },
    );
  }

  const assignedProjectByAgent = new Map<string, string>();
  const identities: Array<ResolvedAgentWorkspaceIdentity<P, A>> = [];
  let changed = false;

  for (let index = 0; index < nextProjects.length; index += 1) {
    let project = nextProjects[index];
    const workspaceIdentity = normalizeWorkspacePathIdentity(project.path);
    const matchingAgents = agentsByWorkspace.get(workspaceIdentity) ?? [];
    if (matchingAgents.length > 1) {
      throw new AgentWorkspaceIdentityError(
        'MULTIPLE_AGENTS_FOR_WORKSPACE',
        `Workspace '${project.path}' matches multiple Agents.`,
        { projectId: project.id, agentIds: matchingAgents.map(agent => agent.id) },
      );
    }

    const linkedAgent = project.agentId ? agentsById.get(project.agentId) : undefined;
    const linkedAgentMatchesWorkspace = linkedAgent
      ? normalizeWorkspacePathIdentity(linkedAgent.workspacePath ?? '') === workspaceIdentity
      : false;
    let selectedAgent = linkedAgentMatchesWorkspace ? linkedAgent : matchingAgents[0];

    if (!selectedAgent) {
      selectedAgent = options.buildAgent(project);
      if (!selectedAgent.id || agentsById.has(selectedAgent.id)) {
        throw new AgentWorkspaceIdentityError(
          'CREATED_AGENT_ID_COLLISION',
          `Generated Agent id '${selectedAgent.id || '(missing id)'}' is not unique.`,
          { projectId: project.id, agentId: selectedAgent.id },
        );
      }
      const createdWorkspaceIdentity = normalizeWorkspacePathIdentity(selectedAgent.workspacePath ?? '');
      if (createdWorkspaceIdentity !== workspaceIdentity) {
        throw new AgentWorkspaceIdentityError(
          'INVALID_PROJECT_IDENTITY',
          `Generated Agent '${selectedAgent.id}' does not belong to Project '${project.id}'.`,
          {
            projectId: project.id,
            projectPath: project.path,
            agentId: selectedAgent.id,
            agentPath: selectedAgent.workspacePath,
          },
        );
      }
      nextAgents.push(selectedAgent);
      agentsById.set(selectedAgent.id, selectedAgent);
      agentsByWorkspace.set(workspaceIdentity, [selectedAgent]);
      createdAgentIds.push(selectedAgent.id);
      changed = true;
    }

    const priorProjectId = assignedProjectByAgent.get(selectedAgent.id);
    if (priorProjectId) {
      throw new AgentWorkspaceIdentityError(
        'AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS',
        `Agent '${selectedAgent.id}' resolves to multiple Projects.`,
        { agentId: selectedAgent.id, projectIds: [priorProjectId, project.id] },
      );
    }
    assignedProjectByAgent.set(selectedAgent.id, project.id);

    if (project.agentId !== selectedAgent.id || project.isAgent !== true) {
      project = { ...project, agentId: selectedAgent.id, isAgent: true };
      nextProjects[index] = project;
      relinkedProjectIds.push(project.id);
      changed = true;
    }

    identities.push({
      projectId: project.id,
      agentId: selectedAgent.id,
      workspacePath: project.path,
      project,
      agent: selectedAgent,
    });
  }

  return {
    projects: nextProjects,
    agents: nextAgents,
    identities,
    changed,
    createdAgentIds,
    relinkedProjectIds,
  };
}

export interface BuildAgentForProjectOptions {
  agentId?: string;
  defaultPermissionMode?: string;
  agentDefaults?: WorkspaceTemplateAgentDefaults;
  templates?: readonly WorkspaceTemplate[];
}

function cloneHeartbeatConfig(defaults: WorkspaceTemplateAgentDefaults['heartbeat']) {
  if (!defaults) return undefined;
  return {
    ...defaults,
    activeHours: defaults.activeHours ? { ...defaults.activeHours } : undefined,
  };
}

export function resolveAgentDefaultsForProject(
  project: Pick<Project, 'templateSource' | 'templateId'>,
  templates: readonly WorkspaceTemplate[] = PRESET_TEMPLATES,
): WorkspaceTemplateAgentDefaults | undefined {
  if (project.templateSource !== 'builtin' || !project.templateId) return undefined;
  return templates.find(template => template.isBuiltin && template.id === project.templateId)?.agentDefaults;
}

/** Build the existing basic Agent shape from a Project; shared by both I/O owners. */
export function buildAgentForProject(
  project: Project,
  options: BuildAgentForProjectOptions = {},
): AgentConfig {
  const agentDefaults = options.agentDefaults ?? resolveAgentDefaultsForProject(project, options.templates);
  return {
    id: options.agentId ?? crypto.randomUUID(),
    name: project.displayName || project.name,
    icon: project.icon,
    workspacePath: project.path,
    enabled: agentDefaults?.enabled ?? false,
    channels: [],
    providerId: project.providerId ?? undefined,
    model: project.model ?? undefined,
    permissionMode: project.permissionMode || options.defaultPermissionMode || 'plan',
    mcpEnabledServers: project.mcpEnabledServers,
    enabledPluginIds: project.enabledPluginIds,
    enabledOfficialToolIds: project.enabledOfficialToolIds,
    heartbeat: cloneHeartbeatConfig(agentDefaults?.heartbeat),
    memoryAutoUpdate: agentDefaults?.memoryAutoUpdate
      ? { ...agentDefaults.memoryAutoUpdate }
      : undefined,
    memoryEvolution: agentDefaults?.memoryEvolution
      ? { ...agentDefaults.memoryEvolution }
      : undefined,
  };
}
