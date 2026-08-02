import {
  AgentWorkspaceIdentityError,
  buildAgentForProject,
  reconcileAgentWorkspaceIdentities,
  type ResolvedAgentWorkspaceIdentity,
} from '../../shared/agentWorkspaceIdentity';
import { type PermissionMode, type Project } from '../../shared/config-types';
import type { AgentConfig } from '../../shared/types/agent';
import { broadcast } from '../sse';
import {
  atomicModifyConfig,
  atomicModifyProjects,
  withAgentConfigIntentLock,
  type AdminAppConfig,
  type AgentConfigSlim,
  type ProjectSlim,
} from './admin-config';

export type PersistedAgentWorkspaceIdentity = ResolvedAgentWorkspaceIdentity<
  ProjectSlim,
  AgentConfigSlim
>;

export interface PersistedAgentWorkspaceRegistry {
  config: AdminAppConfig;
  projects: ProjectSlim[];
  identities: PersistedAgentWorkspaceIdentity[];
  repaired: boolean;
  createdAgentIds: string[];
  relinkedProjectIds: string[];
}

function asProjectBuildSource(project: ProjectSlim): Project {
  const permissionMode = project.permissionMode;
  const normalizedPermissionMode: PermissionMode | null =
    permissionMode === 'auto' || permissionMode === 'plan' || permissionMode === 'fullAgency'
      ? permissionMode
      : null;
  return {
    ...(project as unknown as Project),
    providerId: typeof project.providerId === 'string' ? project.providerId : null,
    permissionMode: normalizedPermissionMode,
    model: typeof project.model === 'string' ? project.model : null,
  };
}

/**
 * Resolve the disk authorities to the required Agent↔Workspace domain.
 * Repairs are serialized by the existing cross-process intent lock; conflicts
 * throw AgentWorkspaceIdentityError and leave both files untouched.
 */
export async function resolvePersistedAgentWorkspaceRegistry(): Promise<PersistedAgentWorkspaceRegistry> {
  return withAgentConfigIntentLock(async () => {
    let registry: PersistedAgentWorkspaceRegistry | undefined;
    await atomicModifyProjects(async projects => {
      let result: ReturnType<typeof reconcileAgentWorkspaceIdentities<ProjectSlim, AgentConfigSlim>> | undefined;
      const config = await atomicModifyConfig(current => {
        result = reconcileAgentWorkspaceIdentities(projects, current.agents ?? [], {
          buildAgent: project => buildAgentForProject(asProjectBuildSource(project), {
            defaultPermissionMode: current.defaultPermissionMode,
          }) as AgentConfig as AgentConfigSlim,
        });
        return result.changed ? { ...current, agents: result.agents } : current;
      });
      if (!result) throw new Error('Agent identity reconciliation did not produce a result.');
      registry = {
        config,
        projects: result.projects,
        identities: result.identities,
        repaired: result.changed,
        createdAgentIds: result.createdAgentIds,
        relinkedProjectIds: result.relinkedProjectIds,
      };
      // Agent is committed before this Project writer returns. If this second
      // atomic write is interrupted, the next call finds the Agent by path.
      return result.projects;
    });
    if (!registry) throw new Error('Agent identity reconciliation did not produce a registry.');
    if (registry.repaired) {
      broadcast('config:changed', {
        section: 'agent-identity',
        action: 'repair',
        createdAgentIds: registry.createdAgentIds,
        relinkedProjectIds: registry.relinkedProjectIds,
      });
    }
    return registry;
  });
}

export function agentWorkspaceIdentityFailure(error: unknown): {
  success: false;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
} {
  if (error instanceof AgentWorkspaceIdentityError) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      details: error.details,
    };
  }
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
