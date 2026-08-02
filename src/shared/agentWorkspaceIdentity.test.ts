import { describe, expect, it } from 'vitest';

import {
  AgentWorkspaceIdentityError,
  reconcileAgentWorkspaceIdentities,
  type AgentWorkspaceAgentRecord,
  type AgentWorkspaceProjectRecord,
} from './agentWorkspaceIdentity';

interface TestProject extends AgentWorkspaceProjectRecord {
  hidden?: boolean;
  archivedAt?: string;
}

interface TestAgent extends AgentWorkspaceAgentRecord {
  name: string;
  enabled: boolean;
}

function project(id: string, path: string, agentId?: string): TestProject {
  return { id, name: id, path, agentId };
}

function agent(id: string, workspacePath: string): TestAgent {
  return { id, name: id, workspacePath, enabled: false };
}

function reconcile(projects: TestProject[], agents: TestAgent[]) {
  let nextId = 0;
  return reconcileAgentWorkspaceIdentities(projects, agents, {
    buildAgent: source => agent(`created-${++nextId}`, source.path),
  });
}

describe('reconcileAgentWorkspaceIdentities', () => {
  it('creates and links the one required Agent identity without mutating its inputs', () => {
    const projects = [project('project-1', '/work/one')];
    const agents: TestAgent[] = [];

    const result = reconcile(projects, agents);

    expect(result.changed).toBe(true);
    expect(result.createdAgentIds).toEqual(['created-1']);
    expect(result.projects[0]).toMatchObject({
      agentId: 'created-1',
      isAgent: true,
    });
    expect(result.identities[0]).toMatchObject({
      projectId: 'project-1',
      agentId: 'created-1',
      workspacePath: '/work/one',
    });
    expect(projects[0].agentId).toBeUndefined();
    expect(agents).toEqual([]);
  });

  it('repairs a stale link from the unique canonical workspace match', () => {
    const result = reconcile(
      [project('project-1', 'C:\\Users\\Me\\Workspace', 'missing-agent')],
      [agent('agent-1', 'c:/users/me/workspace/')],
    );

    expect(result.createdAgentIds).toEqual([]);
    expect(result.relinkedProjectIds).toEqual(['project-1']);
    expect(result.projects[0].agentId).toBe('agent-1');
  });

  it('preserves orphan Agents while excluding them from resolved identities', () => {
    const orphan = agent('orphan', '/work/orphan');
    const result = reconcile([project('project-1', '/work/one')], [orphan]);

    expect(result.agents.map(item => item.id)).toEqual(['orphan', 'created-1']);
    expect(result.identities.map(item => item.agentId)).toEqual(['created-1']);
  });

  it('fails closed when a workspace matches more than one Agent', () => {
    expect(() => reconcile(
      [project('project-1', '/work/one', 'agent-1')],
      [agent('agent-1', '/work/one'), agent('agent-2', '/work/one/')],
    )).toThrowError(expect.objectContaining<Partial<AgentWorkspaceIdentityError>>({
      code: 'MULTIPLE_AGENTS_FOR_WORKSPACE',
    }));
  });

  it('fails closed when two Projects share one canonical workspace', () => {
    expect(() => reconcile(
      [project('project-1', 'D:\\Work'), project('project-2', 'd:/work/')],
      [],
    )).toThrowError(expect.objectContaining<Partial<AgentWorkspaceIdentityError>>({
      code: 'DUPLICATE_PROJECT_WORKSPACE',
    }));
  });

  it('fails closed before repairing asymmetric duplicate raw Agent links', () => {
    expect(() => reconcile(
      [
        project('project-one', '/one', 'agent-one'),
        project('project-two', '/two', 'agent-one'),
      ],
      [agent('agent-one', '/one')],
    )).toThrowError(expect.objectContaining<Partial<AgentWorkspaceIdentityError>>({
      code: 'AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS',
    }));
  });

  it('keeps hidden and archived Projects in the identity invariant', () => {
    const projects = [
      { ...project('hidden', '/work/hidden'), hidden: true },
      { ...project('archived', '/work/archived'), archivedAt: '2026-08-01T00:00:00.000Z' },
    ];
    const result = reconcile(projects, []);

    expect(result.identities).toHaveLength(2);
    expect(result.projects.every(item => item.agentId && item.isAgent)).toBe(true);
  });
});
