import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  findProjectForAgent: vi.fn(),
  spaceArchiveGoal: vi.fn(),
  spaceCancelIssueClaim: vi.fn(),
  spaceCloseIssue: vi.fn(),
  spaceCloseOwnIssue: vi.fn(),
  spaceCommentIssue: vi.fn(),
  spaceCreateGoal: vi.fn(),
  spaceCompleteIssue: vi.fn(),
  spaceCreateIssue: vi.fn(),
  spaceDeleteSkill: vi.fn(),
  spaceDownloadIssueAttachment: vi.fn(),
  spaceGetIssue: vi.fn(),
  spaceGetOfficial: vi.fn(),
  spaceGetSession: vi.fn(),
  spaceGetSkill: vi.fn(),
  spaceGetSkillFile: vi.fn(),
  spaceInstallSkill: vi.fn(),
  spaceListGoals: vi.fn(),
  spaceListEvents: vi.fn(),
  spaceListIssues: vi.fn(),
  spaceListLocalAgents: vi.fn(),
  spaceListRegisteredAgents: vi.fn(),
  spaceListSkills: vi.fn(),
  spaceLogout: vi.fn(),
  spaceRegisterAgent: vi.fn(),
  spaceRevokeRegisteredAgent: vi.fn(),
  spaceSetIssueState: vi.fn(),
  spaceUpdateGoal: vi.fn(),
  spaceUpdateRegisteredAgent: vi.fn(),
  spaceUploadIssueAttachments: vi.fn(),
  spaceUploadSkillZip: vi.fn(),
}));

vi.mock('@/api/spaceCloud', () => ({
  DEFAULT_SPACE_ID: 'official',
  findProjectForAgent: apiMocks.findProjectForAgent,
  spaceArchiveGoal: apiMocks.spaceArchiveGoal,
  spaceCancelIssueClaim: apiMocks.spaceCancelIssueClaim,
  spaceCloseIssue: apiMocks.spaceCloseIssue,
  spaceCloseOwnIssue: apiMocks.spaceCloseOwnIssue,
  spaceCommentIssue: apiMocks.spaceCommentIssue,
  spaceCreateGoal: apiMocks.spaceCreateGoal,
  spaceCompleteIssue: apiMocks.spaceCompleteIssue,
  spaceCreateIssue: apiMocks.spaceCreateIssue,
  spaceDeleteSkill: apiMocks.spaceDeleteSkill,
  spaceDownloadIssueAttachment: apiMocks.spaceDownloadIssueAttachment,
  spaceGetIssue: apiMocks.spaceGetIssue,
  spaceGetOfficial: apiMocks.spaceGetOfficial,
  spaceGetSession: apiMocks.spaceGetSession,
  spaceGetSkill: apiMocks.spaceGetSkill,
  spaceGetSkillFile: apiMocks.spaceGetSkillFile,
  spaceInstallSkill: apiMocks.spaceInstallSkill,
  spaceListGoals: apiMocks.spaceListGoals,
  spaceListEvents: apiMocks.spaceListEvents,
  spaceListIssues: apiMocks.spaceListIssues,
  spaceListLocalAgents: apiMocks.spaceListLocalAgents,
  spaceListRegisteredAgents: apiMocks.spaceListRegisteredAgents,
  spaceListSkills: apiMocks.spaceListSkills,
  spaceLogout: apiMocks.spaceLogout,
  spaceRegisterAgent: apiMocks.spaceRegisterAgent,
  spaceRevokeRegisteredAgent: apiMocks.spaceRevokeRegisteredAgent,
  spaceSetIssueState: apiMocks.spaceSetIssueState,
  spaceUpdateGoal: apiMocks.spaceUpdateGoal,
  spaceUpdateRegisteredAgent: apiMocks.spaceUpdateRegisteredAgent,
  spaceUploadIssueAttachments: apiMocks.spaceUploadIssueAttachments,
  spaceUploadSkillZip: apiMocks.spaceUploadSkillZip,
}));

import type { LocalRegisteredAgent, SpaceEvent, SpaceGoal, SpaceIssue, SpaceIssueComment, SpaceIssueDetail, SpaceSession, SpaceSkill } from '@/api/spaceCloud';
import {
  SPACE_MAX_ISSUE_DETAIL_CACHES,
  SPACE_MAX_SKILL_FILE_CACHES,
  __resetSpaceStoreForTest,
  __setSpaceStoreStateForTest,
  actions,
  getIssueListState,
  getSkillFileState,
  getSnapshot,
} from './spaceStore';

const fakeSession: SpaceSession = {
  baseUrl: 'https://space.myagents.test',
  user: { id: 'user-1', email: 'user@example.com' },
  space: { id: 'space-1', slug: 'official', name: 'MyAgents社区', joinPolicy: 'open' },
  membership: { id: 'membership-1', role: 'owner' },
  updatedAt: '2026-06-24T00:00:00.000Z',
};

const fakeIssue: SpaceIssue = {
  id: 'iss_123',
  spaceId: 'space-1',
  title: 'Test',
  body: 'Body',
  state: 'todo',
  goalId: 'goal-1',
  goalPathLabel: 'Runtime',
  humanOnly: false,
  creator: { id: 'user-1', name: 'Ethan' },
  status: 'open',
  author: { id: 'user-1', name: 'Ethan' },
  commentCount: 0,
  attachmentCount: 0,
  createdAt: '2026-06-24T00:00:00.000Z',
  updatedAt: '2026-06-24T00:00:00.000Z',
};

const fakeGoal: SpaceGoal = {
  id: 'goal-1',
  spaceId: 'space-1',
  parentGoalId: null,
  path: '/goal-1/',
  depth: 0,
  title: 'Runtime',
  context: 'Runtime work',
  createdAt: '2026-06-24T00:00:00.000Z',
  updatedAt: '2026-06-24T00:00:00.000Z',
  goalPathLabel: 'Runtime',
};

const fakeDetail: SpaceIssueDetail = {
  issue: fakeIssue,
  comments: {
    items: [],
    hasMore: false,
    nextCursor: null,
    limit: 5,
  },
  attachments: [],
};

const fakeSkill: SpaceSkill = {
  id: 'skl_123',
  name: 'PRD Writer',
  slug: 'prd-writer',
  description: 'Write product specs',
  latestRevision: 1,
  createdAt: '2026-06-24T00:00:00.000Z',
  updatedAt: '2026-06-24T00:00:00.000Z',
};

const fakeAgent: LocalRegisteredAgent = {
  id: 'rag_123',
  baseUrl: 'https://space.myagents.test',
  spaceId: 'space-1',
  workspaceId: 'project-1',
  displayName: 'Frontend Agent',
  workspacePath: '/tmp/workspace',
  workspaceLabel: 'Workspace',
  goalId: 'goal-1',
  goalPathLabel: 'Runtime',
  stateFilter: ['todo'],
  status: 'active',
  createdAt: '2026-06-24T00:00:00.000Z',
  updatedAt: '2026-06-24T00:00:00.000Z',
};

function scoped(id: string): string {
  return `official\n${id}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetSpaceStoreForTest();
  vi.clearAllMocks();
});

describe('spaceStore snapshot', () => {
  it('returns a stable snapshot reference until state changes', () => {
    const first = getSnapshot();
    const second = getSnapshot();

    expect(first).toBe(second);

    __setSpaceStoreStateForTest({
      goals: [{
        id: 'goal-1',
        spaceId: 'space-1',
        parentGoalId: null,
        path: 'runtime',
        depth: 0,
        title: 'Runtime',
        context: 'Runtime work',
        createdAt: '2026-06-24T00:00:00.000Z',
        updatedAt: '2026-06-24T00:00:00.000Z',
      }],
    });

    expect(getSnapshot()).not.toBe(first);
  });
});

describe('spaceStore boot', () => {
  it('uses the stable space slug for API routes even when the session contains a database id', async () => {
    apiMocks.spaceGetSession.mockResolvedValueOnce(fakeSession);
    apiMocks.spaceGetOfficial.mockResolvedValueOnce({
      space: fakeSession.space,
      membership: fakeSession.membership,
      goals: [],
    });

    await actions.ensureBootstrapped({ force: true });

    expect(apiMocks.spaceGetOfficial).toHaveBeenCalledWith('official');
    expect(getSnapshot().spaceId).toBe('official');
  });
});

describe('spaceStore issue refresh', () => {
  it('dedupes same-key issue refreshes while a request is in flight', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    const pending = deferred<{ items: SpaceIssue[]; hasMore: boolean; nextCursor: null }>();
    apiMocks.spaceListIssues.mockReturnValueOnce(pending.promise);

    const first = actions.refreshIssues({ q: ' Test ', limit: 50 }, { maxAgeMs: 30_000 });
    const second = actions.refreshIssues({ q: 'Test', limit: 50 }, { maxAgeMs: 30_000 });

    expect(apiMocks.spaceListIssues).toHaveBeenCalledTimes(1);
    expect(apiMocks.spaceListIssues).toHaveBeenCalledWith(
      {
        q: 'Test',
        state: undefined,
        goalId: undefined,
        includeSubtree: undefined,
        humanOnly: undefined,
        cursor: undefined,
        limit: 50,
      },
      'official',
    );

    pending.resolve({ items: [fakeIssue], hasMore: false, nextCursor: null });
    await Promise.all([first, second]);

    expect(getIssueListState({ q: 'Test', limit: 50 }).items).toEqual([fakeIssue]);
  });

  it('keeps the previous issue list visible when revalidation fails', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    apiMocks.spaceListIssues.mockResolvedValueOnce({ items: [fakeIssue], hasMore: false, nextCursor: null });

    await actions.refreshIssues({ limit: 50 }, { force: true });
    expect(getIssueListState({ limit: 50 }).items).toEqual([fakeIssue]);

    apiMocks.spaceListIssues.mockRejectedValueOnce(new Error('network down'));

    await expect(actions.refreshIssues({ limit: 50 }, { force: true, silent: true })).rejects.toThrow('network down');

    const state = getIssueListState({ limit: 50 });
    expect(state.items).toEqual([fakeIssue]);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBe('network down');
  });

  it('prepends a newly created issue into already loaded lists', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    apiMocks.spaceListIssues.mockResolvedValueOnce({ items: [fakeIssue], hasMore: false, nextCursor: null });
    await actions.refreshIssues({ limit: 50 }, { force: true });

    const newIssue = { ...fakeIssue, id: 'iss_456', title: 'Second' };
    apiMocks.spaceCreateIssue.mockResolvedValueOnce({ issue: newIssue });

    await actions.createIssue({ title: 'Second', body: 'Body' });

    expect(getIssueListState({ limit: 50 }).items.map((issue) => issue.id)).toEqual(['iss_456', 'iss_123']);
  });

  it('does not inject created issues into cached lists with non-matching filters', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    const runtimeIssue = { ...fakeIssue, goalId: 'goal-runtime', goalPathLabel: 'Runtime' };
    apiMocks.spaceListIssues.mockResolvedValueOnce({ items: [runtimeIssue], hasMore: false, nextCursor: null });
    await actions.refreshIssues({ goalId: 'goal-runtime', limit: 50 }, { force: true });

    const uiIssue = {
      ...fakeIssue,
      id: 'iss_456',
      title: 'UI',
      goalId: 'goal-ui',
      goalPathLabel: 'UI',
    };
    apiMocks.spaceCreateIssue.mockResolvedValueOnce({ issue: uiIssue });

    await actions.createIssue({ title: 'UI', body: 'Body', goalId: 'goal-ui' });

    expect(getIssueListState({ goalId: 'goal-runtime', limit: 50 }).items.map((issue) => issue.id)).toEqual(['iss_123']);
  });

  it('matches filtered issue lists by goal id', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    const runtimeIssue = { ...fakeIssue, goalId: 'goal-runtime', goalPathLabel: 'Runtime' };
    apiMocks.spaceListIssues
      .mockResolvedValueOnce({ items: [runtimeIssue], hasMore: false, nextCursor: null })
      .mockResolvedValueOnce({ items: [runtimeIssue], hasMore: false, nextCursor: null });
    await actions.refreshIssues({ goalId: 'goal-runtime', limit: 50 }, { force: true });
    await actions.refreshIssues({ goalId: 'goal-runtime', includeSubtree: true, limit: 50 }, { force: true });

    const nextIssue = { ...runtimeIssue, id: 'iss_456', title: 'Patched' };
    apiMocks.spaceCreateIssue.mockResolvedValueOnce({ issue: nextIssue });

    await actions.createIssue({ title: nextIssue.title, body: nextIssue.body, goalId: 'goal-runtime' });

    expect(getIssueListState({ goalId: 'goal-runtime', limit: 50 }).items.map((issue) => issue.id)).toEqual(['iss_456', 'iss_123']);
    expect(getIssueListState({ goalId: 'goal-runtime', includeSubtree: true, limit: 50 }).items.map((issue) => issue.id)).toEqual(['iss_456', 'iss_123']);
  });

  it('moves a state-mutated issue between cached filtered lists', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    apiMocks.spaceListIssues
      .mockResolvedValueOnce({ items: [fakeIssue], hasMore: false, nextCursor: null })
      .mockResolvedValueOnce({ items: [], hasMore: false, nextCursor: null });

    await actions.refreshIssues({ state: 'todo', limit: 50 }, { force: true });
    await actions.refreshIssues({ state: 'doing', limit: 50 }, { force: true });

    apiMocks.spaceSetIssueState.mockResolvedValueOnce({
      state: 'doing',
      updatedAt: '2026-06-24T01:00:00.000Z',
    });

    await actions.setIssueState('iss_123', 'doing');

    expect(getIssueListState({ state: 'todo', limit: 50 }).items).toEqual([]);
    expect(getIssueListState({ state: 'doing', limit: 50 }).items.map((issue) => issue.id)).toEqual(['iss_123']);
    expect(getIssueListState({ state: 'doing', limit: 50 }).items[0]?.state).toBe('doing');
  });

  it('patches issue detail comments and list counters after a successful comment', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    apiMocks.spaceListIssues.mockResolvedValueOnce({ items: [fakeIssue], hasMore: false, nextCursor: null });
    await actions.refreshIssues({ limit: 50 }, { force: true });
    __setSpaceStoreStateForTest({
      issueDetails: {
        [scoped('iss_123')]: {
          detail: fakeDetail,
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    const comment: SpaceIssueComment = {
      id: 'cmt_123',
      author: { id: 'user-1', type: 'user' },
      body: '效果咋样呢？',
      createdAt: '2026-06-24T02:00:00.000Z',
    };
    apiMocks.spaceCommentIssue.mockResolvedValueOnce({ comment });

    await actions.commentIssue('iss_123', '效果咋样呢？');

    const detail = getSnapshot().issueDetails[scoped('iss_123')]?.detail;
    expect(detail?.comments.items).toEqual([comment]);
    expect(detail?.issue.commentCount).toBe(1);
    expect(getIssueListState({ limit: 50 }).items[0]?.commentCount).toBe(1);
  });

  it('does not patch comments when comment submission fails', async () => {
    __setSpaceStoreStateForTest({
      boot: 'ready',
      session: fakeSession,
      issueDetails: {
        [scoped('iss_123')]: {
          detail: fakeDetail,
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    apiMocks.spaceCommentIssue.mockRejectedValueOnce(new Error('network down'));

    await expect(actions.commentIssue('iss_123', 'will fail')).rejects.toThrow('network down');

    const detail = getSnapshot().issueDetails[scoped('iss_123')]?.detail;
    expect(detail?.comments.items).toEqual([]);
    expect(detail?.issue.commentCount).toBe(0);
  });

  it('downloads an issue attachment through the workspace-safe Space command', async () => {
    apiMocks.spaceDownloadIssueAttachment.mockResolvedValueOnce({
      name: 'trace.log',
      relativePath: 'myagents_files/space/issues/iss_123/attachments/att_1/trace.log',
      fullPath: '/tmp/workspace/myagents_files/space/issues/iss_123/attachments/att_1/trace.log',
      sizeBytes: 42,
    });

    const result = await actions.downloadIssueAttachment({
      issueId: 'iss_123',
      attachmentId: 'att_1',
      workspacePath: '/tmp/workspace',
      fileName: 'trace.log',
    });

    expect(apiMocks.spaceDownloadIssueAttachment).toHaveBeenCalledWith({
      issueId: 'iss_123',
      attachmentId: 'att_1',
      workspacePath: '/tmp/workspace',
      fileName: 'trace.log',
    });
    expect(result.relativePath).toBe('myagents_files/space/issues/iss_123/attachments/att_1/trace.log');
  });
});

describe('spaceStore goal mutations', () => {
  it('refreshes the goal tree after creating a child goal', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession, goals: [fakeGoal] });
    const child = {
      ...fakeGoal,
      id: 'goal-child',
      parentGoalId: fakeGoal.id,
      path: '/goal-1/goal-child/',
      depth: 1,
      title: 'Renderer',
      goalPathLabel: 'Runtime / Renderer',
    };
    apiMocks.spaceCreateGoal.mockResolvedValueOnce({ goal: child });
    apiMocks.spaceListGoals.mockResolvedValueOnce({ items: [fakeGoal, child] });

    await actions.createGoal({ parentGoalId: fakeGoal.id, title: child.title, context: child.context });

    expect(apiMocks.spaceCreateGoal).toHaveBeenCalledWith(
      { parentGoalId: fakeGoal.id, title: child.title, context: child.context },
      'official',
    );
    expect(getSnapshot().goals.map((goal) => goal.id)).toEqual(['goal-1', 'goal-child']);
  });
});

describe('spaceStore skill actions', () => {
  it('uploads a skill revision and invalidates cached detail/files', async () => {
    const updatedSkill = {
      ...fakeSkill,
      latestRevision: 2,
      updatedAt: '2026-06-24T03:00:00.000Z',
    };
    __setSpaceStoreStateForTest({
      skills: { items: [fakeSkill], lastFetchedAt: Date.now(), isLoading: false, error: null },
      skillDetails: {
        skl_123: {
          detail: { skill: fakeSkill, revision: { revision: 1 }, files: [] },
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
      skillFiles: {
        'skl_123\nSKILL.md': {
          text: '# old',
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    apiMocks.spaceUploadSkillZip.mockResolvedValueOnce({ skill: updatedSkill });

    await expect(actions.uploadSkillRevision('skl_123', '/tmp/prd-writer.zip')).resolves.toEqual(updatedSkill);

    expect(apiMocks.spaceUploadSkillZip).toHaveBeenCalledWith({ filePath: '/tmp/prd-writer.zip', skillId: 'skl_123' });
    expect(getSnapshot().skills.items[0]).toEqual(updatedSkill);
    expect(getSnapshot().skillDetails.skl_123).toBeUndefined();
    expect(getSkillFileState('skl_123', 'SKILL.md')).toBeNull();
  });

  it('deletes a skill from list and cached detail state', async () => {
    __setSpaceStoreStateForTest({
      skills: { items: [fakeSkill], lastFetchedAt: Date.now(), isLoading: false, error: null },
      skillDetails: {
        skl_123: {
          detail: { skill: fakeSkill, revision: { revision: 1 }, files: [] },
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    apiMocks.spaceDeleteSkill.mockResolvedValueOnce({ deleted: true });

    await actions.deleteSkill('skl_123');

    expect(apiMocks.spaceDeleteSkill).toHaveBeenCalledWith('skl_123');
    expect(getSnapshot().skills.items).toEqual([]);
    expect(getSnapshot().skillDetails.skl_123).toBeUndefined();
  });
});

describe('spaceStore registered agent actions', () => {
  it('patches a registered agent in the local list after update', async () => {
    const updatedAgent = { ...fakeAgent, status: 'disabled', updatedAt: '2026-06-24T04:00:00.000Z' } satisfies LocalRegisteredAgent;
    __setSpaceStoreStateForTest({
      localAgents: { items: [fakeAgent], lastFetchedAt: Date.now(), isLoading: false, error: null },
    });
    apiMocks.spaceUpdateRegisteredAgent.mockResolvedValueOnce(updatedAgent);

    await expect(actions.updateRegisteredAgent({ id: 'rag_123', status: 'disabled' })).resolves.toEqual(updatedAgent);

    expect(apiMocks.spaceUpdateRegisteredAgent).toHaveBeenCalledWith({ id: 'rag_123', status: 'disabled' });
    expect(getSnapshot().localAgents.items).toEqual([updatedAgent]);
  });

  it('marks a registered agent as revoked in the local list', async () => {
    const revokedAgent = { ...fakeAgent, status: 'revoked', updatedAt: '2026-06-24T04:05:00.000Z' } satisfies LocalRegisteredAgent;
    __setSpaceStoreStateForTest({
      localAgents: { items: [fakeAgent], lastFetchedAt: Date.now(), isLoading: false, error: null },
    });
    apiMocks.spaceRevokeRegisteredAgent.mockResolvedValueOnce(revokedAgent);

    await actions.revokeRegisteredAgent('rag_123');

    expect(apiMocks.spaceRevokeRegisteredAgent).toHaveBeenCalledWith('rag_123');
    expect(getSnapshot().localAgents.items).toEqual([revokedAgent]);
  });
});

describe('spaceStore event sync', () => {
  it('uses the first event request as a baseline and returns only later events', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    const oldEvent: SpaceEvent = {
      id: 'evt_1',
      type: 'issue.created',
      resourceType: 'issue',
      resourceId: 'iss_123',
      createdAt: '2026-06-24T01:00:00.000Z',
    };
    const newEvent: SpaceEvent = {
      ...oldEvent,
      id: 'evt_2',
      type: 'comment.created',
      createdAt: '2026-06-24T02:00:00.000Z',
    };
    const oldCursor = `${oldEvent.createdAt}|${oldEvent.id}`;
    const newCursor = `${newEvent.createdAt}|${newEvent.id}`;
    apiMocks.spaceListEvents
      .mockResolvedValueOnce({ items: [oldEvent], hasMore: false, nextCursor: oldCursor })
      .mockResolvedValueOnce({ items: [newEvent], hasMore: false, nextCursor: newCursor });

    await expect(actions.syncEvents({ force: true })).resolves.toEqual([]);
    await expect(actions.syncEvents({ force: true })).resolves.toEqual([newEvent]);

    expect(apiMocks.spaceListEvents).toHaveBeenNthCalledWith(1, { cursor: null, limit: 100, tail: true }, 'official');
    expect(apiMocks.spaceListEvents).toHaveBeenNthCalledWith(2, { cursor: oldCursor, limit: 100, tail: false }, 'official');
    expect(getSnapshot().events.cursor).toBe(newCursor);
  });

  it('dedupes repeated event ids across cursor windows', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    const oldEvent: SpaceEvent = {
      id: 'evt_1',
      type: 'issue.created',
      resourceType: 'issue',
      resourceId: 'iss_123',
      createdAt: '2026-06-24T01:00:00.000Z',
    };
    const newEvent: SpaceEvent = {
      ...oldEvent,
      id: 'evt_2',
      type: 'issue.commented',
      createdAt: '2026-06-24T02:00:00.000Z',
    };
    const oldCursor = `${oldEvent.createdAt}|${oldEvent.id}`;
    const newCursor = `${newEvent.createdAt}|${newEvent.id}`;
    apiMocks.spaceListEvents
      .mockResolvedValueOnce({ items: [oldEvent], hasMore: false, nextCursor: oldCursor })
      .mockResolvedValueOnce({ items: [oldEvent, newEvent], hasMore: false, nextCursor: newCursor });

    await expect(actions.syncEvents({ force: true })).resolves.toEqual([]);
    await expect(actions.syncEvents({ force: true })).resolves.toEqual([newEvent]);

    expect(getSnapshot().events.items.map((event) => event.id)).toEqual(['evt_1', 'evt_2']);
  });

  it('keeps composite event cursors so same-timestamp windows can advance by event id', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    const firstEvent: SpaceEvent = {
      id: 'evt_same_001',
      type: 'issue.created',
      resourceType: 'issue',
      resourceId: 'iss_123',
      createdAt: '2026-06-24T01:00:00.000Z',
    };
    const secondEvent: SpaceEvent = {
      ...firstEvent,
      id: 'evt_same_002',
      type: 'issue.commented',
    };
    const firstCursor = `${firstEvent.createdAt}|${firstEvent.id}`;
    const secondCursor = `${secondEvent.createdAt}|${secondEvent.id}`;
    apiMocks.spaceListEvents
      .mockResolvedValueOnce({ items: [firstEvent], hasMore: true, nextCursor: firstCursor })
      .mockResolvedValueOnce({ items: [secondEvent], hasMore: false, nextCursor: secondCursor });

    await expect(actions.syncEvents({ force: true })).resolves.toEqual([]);
    await expect(actions.syncEvents({ force: true })).resolves.toEqual([secondEvent]);

    expect(apiMocks.spaceListEvents).toHaveBeenNthCalledWith(2, { cursor: firstCursor, limit: 100, tail: false }, 'official');
    expect(getSnapshot().events.cursor).toBe(secondCursor);
  });
});

describe('spaceStore cache bounds', () => {
  it('bounds issue detail cache by recency', async () => {
    __setSpaceStoreStateForTest({
      boot: 'ready',
      session: fakeSession,
      issueDetails: Object.fromEntries(
        Array.from({ length: SPACE_MAX_ISSUE_DETAIL_CACHES }, (_, index) => [
          `iss_old_${index}`,
          {
            detail: {
              ...fakeDetail,
              issue: { ...fakeIssue, id: `iss_old_${index}` },
            },
            lastFetchedAt: index + 1,
            isLoading: false,
            error: null,
          },
        ]),
      ),
    });
    apiMocks.spaceGetIssue.mockResolvedValueOnce({
      ...fakeDetail,
      issue: { ...fakeIssue, id: 'iss_new' },
    });

    await actions.refreshIssueDetail('iss_new', { force: true });

    const keys = Object.keys(getSnapshot().issueDetails);
    expect(keys).toHaveLength(SPACE_MAX_ISSUE_DETAIL_CACHES);
    expect(keys).toContain(scoped('iss_new'));
    expect(keys).not.toContain(scoped('iss_old_0'));
  });

  it('bounds skill file cache by recency', async () => {
    __setSpaceStoreStateForTest({
      boot: 'ready',
      session: fakeSession,
      skillFiles: Object.fromEntries(
        Array.from({ length: SPACE_MAX_SKILL_FILE_CACHES }, (_, index) => [
          `skl_123\nold-${index}.md`,
          {
            text: `old ${index}`,
            lastFetchedAt: index + 1,
            isLoading: false,
            error: null,
          },
        ]),
      ),
    });
    apiMocks.spaceGetSkillFile.mockResolvedValueOnce({ text: 'new file' });

    await actions.refreshSkillFile('skl_123', 'new.md', { force: true });

    const keys = Object.keys(getSnapshot().skillFiles);
    expect(keys).toHaveLength(SPACE_MAX_SKILL_FILE_CACHES);
    expect(keys).toContain(scoped('skl_123\nnew.md'));
    expect(keys).not.toContain(scoped('skl_123\nold-0.md'));
  });
});
