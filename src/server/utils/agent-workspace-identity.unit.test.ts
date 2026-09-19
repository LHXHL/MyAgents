import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminAppConfig, ProjectSlim } from './admin-config';

const state = vi.hoisted(() => ({
  config: { defaultPermissionMode: 'auto', agents: [] } as AdminAppConfig,
  projects: [] as ProjectSlim[],
  writes: [] as string[],
  failProjectOnce: false,
  failConfigOnce: false,
  lockTail: Promise.resolve() as Promise<void>,
}));

vi.mock('../sse', () => ({ broadcast: vi.fn() }));
vi.mock('./admin-config', async importOriginal => {
  const actual = await importOriginal<typeof import('./admin-config')>();
  return {
    ...actual,
    loadConfig: vi.fn(() => state.config),
    loadProjects: vi.fn(() => state.projects),
    withAgentConfigIntentLock: vi.fn(async (run: () => Promise<unknown>) => {
      let release!: () => void;
      const prior = state.lockTail;
      state.lockTail = new Promise<void>(resolve => { release = resolve; });
      await prior;
      try {
        return await run();
      } finally {
        release();
      }
    }),
    atomicModifyProjects: vi.fn(async (modify: (projects: ProjectSlim[]) => ProjectSlim[]) => {
      state.writes.push('projects');
      if (state.failProjectOnce) {
        state.failProjectOnce = false;
        throw new Error('projects write interrupted');
      }
      state.projects = modify(state.projects);
      return state.projects;
    }),
    atomicModifyConfig: vi.fn(async (modify: (config: AdminAppConfig) => AdminAppConfig) => {
      state.writes.push('config');
      if (state.failConfigOnce) {
        state.failConfigOnce = false;
        throw new Error('config write interrupted');
      }
      state.config = modify(state.config);
      return state.config;
    }),
  };
});

import {
  registerWorkspaceAgent,
  resolvePersistedAgentWorkspaceRegistry,
} from './agent-workspace-identity';

function project(overrides: Partial<ProjectSlim> = {}): ProjectSlim {
  return {
    id: 'project-1',
    name: 'Workspace',
    path: '/repo/current',
    ...overrides,
  };
}

describe('persisted Agent workspace identity', () => {
  let tempWorkspace: string | null = null;

  beforeEach(() => {
    state.config = { defaultPermissionMode: 'auto', agents: [] };
    state.projects = [project()];
    state.writes = [];
    state.failProjectOnce = false;
    state.failConfigOnce = false;
    state.lockTail = Promise.resolve();
  });

  afterEach(() => {
    if (tempWorkspace) rmSync(tempWorkspace, { recursive: true, force: true });
    tempWorkspace = null;
  });

  function workspace(): string {
    tempWorkspace ??= mkdtempSync(
      join(process.cwd(), '.myagents-agent-register-'),
    );
    return tempWorkspace;
  }

  it('commits Project.agentId before creating the pathless Agent record', async () => {
    const result = await resolvePersistedAgentWorkspaceRegistry();

    expect(state.writes).toEqual(['projects', 'config']);
    expect(result.projects[0].agentId).toBeTruthy();
    expect(result.config.agents).toEqual([
      expect.objectContaining({ id: result.projects[0].agentId, name: 'Workspace' }),
    ]);
    expect(result.config.agents?.[0]).not.toHaveProperty('workspacePath');
    expect(result.agentProjections[0]).toMatchObject({
      agentId: result.projects[0].agentId,
      workspacePath: '/repo/current',
      association: 'project-linked',
    });
  });

  it('rebuilds a stale Project link with the same id after an interrupted Agent write', async () => {
    state.projects = [project({ agentId: 'stale-agent-id' })];

    const result = await resolvePersistedAgentWorkspaceRegistry();

    expect(result.config.agents?.map(agent => agent.id)).toEqual(['stale-agent-id']);
    expect(result.projects[0].agentId).toBe('stale-agent-id');
  });

  it('recovers a Project-first birth after the Agent write is interrupted', async () => {
    state.failConfigOnce = true;

    const interrupted = await resolvePersistedAgentWorkspaceRegistry();
    const persistedAgentId = state.projects[0].agentId;
    expect(persistedAgentId).toBeTruthy();
    expect(state.config.agents).toEqual([]);
    expect(interrupted.repairDeferred).toBe(true);
    expect(interrupted.agentProjections).toEqual([]);

    const retried = await resolvePersistedAgentWorkspaceRegistry();
    expect(retried.projects[0].agentId).toBe(persistedAgentId);
    expect(retried.config.agents?.map(agent => agent.id)).toEqual([persistedAgentId]);
  });

  it('keeps a deterministic legacy match usable when Project repair persistence is deferred', async () => {
    state.projects = [project()];
    state.config = {
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'legacy-agent',
        name: 'Legacy',
        enabled: true,
        workspacePath: '/repo/current',
      } as unknown as NonNullable<AdminAppConfig['agents']>[number]],
    };
    state.failProjectOnce = true;

    const result = await resolvePersistedAgentWorkspaceRegistry();

    expect(result.repairDeferred).toBe(true);
    expect(result.projects[0].agentId).toBe('legacy-agent');
    expect(result.agentProjections).toContainEqual(expect.objectContaining({
      agentId: 'legacy-agent',
      workspacePath: '/repo/current',
    }));
    expect(state.projects[0].agentId).toBeUndefined();
  });

  it('does not create an Agent when the Project link write is interrupted', async () => {
    state.failProjectOnce = true;

    await expect(resolvePersistedAgentWorkspaceRegistry())
      .rejects.toThrow('projects write interrupted');
    expect(state.projects[0].agentId).toBeUndefined();
    expect(state.config.agents).toEqual([]);
  });

  it('serializes concurrent births to one Project link and one Agent id', async () => {
    const [first, second] = await Promise.all([
      resolvePersistedAgentWorkspaceRegistry(),
      resolvePersistedAgentWorkspaceRegistry(),
    ]);

    const persistedAgentId = state.projects[0].agentId;
    expect(persistedAgentId).toBeTruthy();
    expect(state.config.agents?.map(agent => agent.id)).toEqual([persistedAgentId]);
    expect(first.projects[0].agentId).toBe(persistedAgentId);
    expect(second.projects[0].agentId).toBe(persistedAgentId);
  });

  it('keeps an exact id link authoritative when its historical path disagrees', async () => {
    state.projects = [project({ agentId: 'selected' })];
    state.config = {
      defaultPermissionMode: 'auto',
      agents: [{
        id: 'selected',
        name: 'Selected',
        enabled: true,
        workspacePath: '/repo/old',
      } as unknown as NonNullable<AdminAppConfig['agents']>[number]],
    };

    const result = await resolvePersistedAgentWorkspaceRegistry();

    expect(result.agentProjections[0]).toMatchObject({
      agentId: 'selected',
      workspacePath: '/repo/current',
    });
    expect(result.createdAgentIds).toEqual([]);
  });

  it('registers an existing absolute directory Project-first and is idempotent', async () => {
    state.projects = [];

    const first = await registerWorkspaceAgent(workspace());
    const lastOpened = state.projects[0].lastOpened;
    const second = await registerWorkspaceAgent(workspace());

    expect(first).toMatchObject({
      created: true,
      workspacePath: workspace(),
      archived: false,
    });
    expect(second).toMatchObject({
      created: false,
      projectId: first.projectId,
      agentId: first.agentId,
      workspacePath: workspace(),
    });
    expect(state.projects).toHaveLength(1);
    expect(state.config.agents).toHaveLength(1);
    expect(state.projects[0].lastOpened).toBe(lastOpened);
  });

  it('serializes concurrent registration to one Project and Agent identity', async () => {
    state.projects = [];

    const [first, second] = await Promise.all([
      registerWorkspaceAgent(workspace()),
      registerWorkspaceAgent(workspace()),
    ]);

    expect(first.agentId).toBe(second.agentId);
    expect(first.projectId).toBe(second.projectId);
    expect(state.projects).toHaveLength(1);
    expect(state.config.agents?.map((agent) => agent.id)).toEqual([
      first.agentId,
    ]);
  });

  it('reuses the committed Project identity after an interrupted Agent materialization', async () => {
    state.projects = [];
    state.failConfigOnce = true;

    await expect(registerWorkspaceAgent(workspace())).rejects.toMatchObject({
      code: 'AGENT_MATERIALIZATION_DEFERRED',
    });
    const committedAgentId = state.projects[0].agentId;
    const retried = await registerWorkspaceAgent(workspace());

    expect(retried.agentId).toBe(committedAgentId);
    expect(state.projects).toHaveLength(1);
    expect(state.config.agents?.map((agent) => agent.id)).toEqual([
      committedAgentId,
    ]);
  });

  it('reuses a legacy path-backed Agent id when creating its Project selector', async () => {
    const workspacePath = workspace();
    state.projects = [];
    state.config = {
      defaultPermissionMode: 'auto',
      agents: [
        {
          id: 'legacy-agent',
          name: 'Legacy',
          enabled: false,
          workspacePath,
        } as unknown as NonNullable<AdminAppConfig['agents']>[number],
      ],
    };

    const result = await registerWorkspaceAgent(workspacePath);

    expect(result.agentId).toBe('legacy-agent');
    expect(state.projects).toEqual([
      expect.objectContaining({ agentId: 'legacy-agent', path: workspacePath }),
    ]);
    expect(state.config.agents).toHaveLength(1);
  });

  it('fails closed for invalid, non-directory, and archived workspaces', async () => {
    await expect(registerWorkspaceAgent('relative/path')).rejects.toMatchObject(
      {
        code: 'WORKSPACE_PATH_NOT_ABSOLUTE',
      },
    );
    const file = join(workspace(), 'file.txt');
    writeFileSync(file, 'not a directory');
    await expect(registerWorkspaceAgent(file)).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_NOT_DIRECTORY',
    });
    await expect(registerWorkspaceAgent('/etc')).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_UNSAFE',
    });

    state.projects = [
      project({ path: workspace(), archivedAt: '2026-09-19T00:00:00.000Z' }),
    ];
    await expect(registerWorkspaceAgent(workspace())).rejects.toMatchObject({
      code: 'WORKSPACE_ARCHIVED',
    });
  });
});
