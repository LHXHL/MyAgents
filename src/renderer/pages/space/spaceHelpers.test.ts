import { describe, expect, it } from 'vitest';

import type { LocalRegisteredAgent, SpaceIssue, SpaceSession } from '@/api/spaceCloud';
import type { Project } from '@/config/types';
import {
  ACTIVE_ISSUE_STATE_FILTER,
  buildIssueCommandPrompt,
  buildIssueQueryKey,
  formatAgentSecondaryLabel,
  getIssueStatusOptions,
  issueDisplayNumber,
  issueDisplayTitle,
  issueStatusLabel,
  isClosedIssue,
  isRegisteredAgentVisibleInList,
  localAgentMatchesCurrentSpaceIdentity,
} from './spaceHelpers';

const session = (role: SpaceSession['membership']['role'], userId = 'user-1'): SpaceSession => ({
  baseUrl: 'https://space.myagents.test',
  user: { id: userId, email: 'user@example.com' },
  space: { id: 'space-1', slug: 'official', name: 'MyAgents社区', joinPolicy: 'open' },
  membership: { id: 'membership-1', role },
  updatedAt: '2026-06-24T00:00:00.000Z',
});

const issue = (overrides: Partial<SpaceIssue> = {}): SpaceIssue => ({
  id: 'iss_123',
  spaceId: 'space-1',
  title: 'Test',
  body: 'Body',
  state: 'todo',
  status: 'open',
  author: { id: 'user-1', name: 'Ethan' },
  commentCount: 0,
  attachmentCount: 0,
  createdAt: '2026-06-24T00:00:00.000Z',
  updatedAt: '2026-06-24T00:00:00.000Z',
  ...overrides,
});

describe('space issue helpers', () => {
  it('builds a stable issue query key from normalized filters', () => {
    expect(buildIssueQueryKey({ q: '  crash ', goalId: ' goal_runtime ', state: ' todo ', includeSubtree: true, limit: 50 })).toBe(
      'q=crash&state=todo&goalId=goal_runtime&includeSubtree=true&humanOnly=&cursor=&limit=50',
    );
  });

  it('keeps the active issue filter aligned with non-terminal states', () => {
    expect(ACTIVE_ISSUE_STATE_FILTER.split(',')).toEqual(['open', 'todo', 'doing']);
    expect(ACTIVE_ISSUE_STATE_FILTER.split(',')).not.toContain('done');
    expect(ACTIVE_ISSUE_STATE_FILTER.split(',')).not.toContain('closed');
  });

  it('builds the issue command prompt around the short CLI alias', () => {
    const prompt = buildIssueCommandPrompt({ spaceName: 'MyAgents社区', issueId: 'iss_123' });

    expect(prompt).toContain('这是来自「MyAgents社区」团队空间的 issue');
    expect(prompt).toContain('请先读取该 issue');
    expect(prompt).toContain('myagents space issue view iss_123 --comments');
    expect(prompt).toContain('myagents space issue claim iss_123');
    expect(prompt).toContain('myagents issue iss_123 --json');
  });

  it('exposes status options by permission', () => {
    const ownerOptions = getIssueStatusOptions({ session: session('owner'), issue: issue() });
    expect(ownerOptions.map((option) => option.value)).toEqual([
      'open',
      'todo',
      'done',
      'closed',
    ]);

    expect(getIssueStatusOptions({ session: session('member'), issue: issue() })).toEqual([
      { value: 'closed', label: 'Close issue', kind: 'close-own' },
    ]);
    expect(getIssueStatusOptions({ session: session('member', 'other-user'), issue: issue() })).toEqual([]);
    expect(getIssueStatusOptions({ session: session('member'), issue: issue({ state: 'closed' }) })).toEqual([]);
  });

  it('strips duplicated status prefixes from issue display titles', () => {
    expect(issueDisplayTitle(issue({ title: '[todo] Seed issue 1' }))).toBe('Seed issue 1');
    expect(issueDisplayTitle(issue({ title: '[triaged] Seed issue 2' }))).toBe('[triaged] Seed issue 2');
    expect(issueDisplayTitle(issue({ state: 'doing', title: '[doing] Seed issue 3' }))).toBe('Seed issue 3');
  });

  it('formats issue numbers from explicit API fields and stable id suffixes', () => {
    expect(issueDisplayNumber(issue({ number: 42 }))).toBe('#42');
    expect(issueDisplayNumber(issue({ issueNumber: 7 }))).toBe('#7');
    expect(issueDisplayNumber(issue({ id: 'issue_113' }))).toBe('#113');
    expect(issueDisplayNumber(issue({ id: 'iss-mock-114' }))).toBe('#114');
    expect(issueDisplayNumber(issue({ id: 'uuid-like-id', title: 'Seed issue 99' }))).toBeNull();
    expect(issueDisplayNumber(issue({ id: 'uuid-like-id', number: 0 }))).toBeNull();
  });

  it('uses translated status labels with raw-token fallback', () => {
    const t = (key: string, options?: { defaultValue?: string }) => (
      key === 'space.issueStatuses.todo' ? '待办' : options?.defaultValue ?? key
    );

    expect(issueStatusLabel('todo', t)).toBe('待办');
    expect(issueStatusLabel('custom_state', t)).toBe('custom state');
  });

  it('formats agent workspace labels through project identity first', () => {
    const projects = [
      { id: 'project-1', path: '/workspace/a', name: 'Repo A', displayName: 'Workspace A' },
    ] as Project[];
    const agent = {
      id: 'agent-1',
      baseUrl: 'https://space.myagents.test',
      spaceId: 'space-1',
      workspaceId: 'project-1',
      displayName: 'Builder',
      workspacePath: '/workspace/a',
      workspaceLabel: 'Stored label',
      goalId: 'goal_runtime',
      goalPathLabel: 'Runtime',
      stateFilter: ['todo'],
      issueSubscriptionRunMode: 'single_session',
      status: 'active',
      createdAt: '2026-06-24T00:00:00.000Z',
      updatedAt: '2026-06-24T00:00:00.000Z',
    } satisfies LocalRegisteredAgent;

    expect(formatAgentSecondaryLabel(agent, projects)).toBe('Workspace A');
    expect(isClosedIssue('closed')).toBe(true);
  });

  it('hides revoked registered agents from the Agents list', () => {
    expect(isRegisteredAgentVisibleInList({ status: 'active' })).toBe(true);
    expect(isRegisteredAgentVisibleInList({ status: 'disabled' })).toBe(true);
    expect(isRegisteredAgentVisibleInList({ status: ' revoked ' })).toBe(false);
    expect(isRegisteredAgentVisibleInList({ status: 'REVOKED' })).toBe(false);
  });

  it('requires local registered agents to match the current space identity', () => {
    const agent = {
      id: 'agent-1',
      baseUrl: 'https://space.myagents.test',
      spaceId: 'space-1',
      ownerUserId: 'user-1',
      deviceId: 'device-1',
      workspaceId: 'project-1',
      displayName: 'Builder',
      workspacePath: '/workspace/a',
      goalId: 'goal_runtime',
      goalPathLabel: 'Runtime',
      stateFilter: ['todo'],
      issueSubscriptionRunMode: 'single_session',
      status: 'active',
      createdAt: '2026-06-24T00:00:00.000Z',
      updatedAt: '2026-06-24T00:00:00.000Z',
    } satisfies LocalRegisteredAgent;

    expect(localAgentMatchesCurrentSpaceIdentity(agent, 'space-1', 'user-1', 'device-1')).toBe(true);
    expect(localAgentMatchesCurrentSpaceIdentity(agent, 'space-2', 'user-1', 'device-1')).toBe(false);
  });
});
