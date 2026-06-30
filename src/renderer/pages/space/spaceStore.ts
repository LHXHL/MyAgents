import {
  DEFAULT_SPACE_ID,
  spaceArchiveGoal,
  spaceCloseOwnIssue,
  spaceCloseIssue,
  spaceCommentIssue,
  spaceCreateGoal,
  spaceCompleteIssue,
  spaceCreateIssue,
  spaceCancelIssueClaim,
  spaceDeleteSkill,
  spaceDownloadIssueAttachment,
  spaceGetIssue,
  spaceGetOfficial,
  spaceGetSession,
  spaceGetSkill,
  spaceGetSkillFile,
  spaceInstallSkill,
  spaceListGoals,
  spaceListIssues,
  spaceListEvents,
  spaceListLocalAgents,
  spaceListRegisteredAgents,
  spaceListSkills,
  spaceLogout,
  spaceRegisterAgent,
  spaceRevokeRegisteredAgent,
  spaceSetIssueState,
  spaceUpdateGoal,
  spaceUpdateRegisteredAgent,
  spaceUploadIssueAttachments,
  spaceUploadSkillZip,
  type LocalRegisteredAgent,
  type SpaceAttachment,
  type SpaceDownloadAttachmentResult,
  type SpaceEvent,
  type SpaceGoal,
  type SpaceIssue,
  type SpaceIssueDetail,
  type SpaceRegisteredAgent,
  type SpaceSession,
  type SpaceSkill,
  type SpaceSkillDetail,
} from '@/api/spaceCloud';
import type { IssueQueryParams } from './spaceHelpers';
import { buildIssueQueryKey } from './spaceHelpers';
import { nowForSpaceMetric, recordSpaceMetric, withSpaceMutationMetric } from './spaceMetrics';

export const SPACE_VISIBLE_REFRESH_TTL_MS = 30_000;
export const SPACE_MAX_ISSUE_LIST_CACHES = 20;
export const SPACE_MAX_ISSUE_DETAIL_CACHES = 100;
export const SPACE_MAX_SKILL_DETAIL_CACHES = 100;
export const SPACE_MAX_SKILL_FILE_CACHES = 50;

type BootState = 'idle' | 'loading' | 'ready' | 'signedOut' | 'error';

export interface SpaceIssueListState {
  items: SpaceIssue[];
  hasMore: boolean;
  nextCursor?: string | null;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

export interface SpaceIssueDetailState {
  detail: SpaceIssueDetail | null;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface SpaceSkillsState {
  items: SpaceSkill[];
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

export interface SpaceSkillDetailState {
  detail: SpaceSkillDetail | null;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

export interface SpaceSkillFileState {
  text: string;
  binary?: boolean;
  mimeType?: string;
  sizeBytes?: number;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface SpaceAgentsState {
  items: LocalRegisteredAgent[];
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface SpaceRegisteredAgentsState {
  items: SpaceRegisteredAgent[];
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface SpaceEventsState {
  items: SpaceEvent[];
  cursor: string | null;
  initialized: boolean;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface StoreState {
  boot: BootState;
  session: SpaceSession | null;
  spaceId: string | null;
  goals: SpaceGoal[];
  bootError: string | null;
  bootLastFetchedAt: number;
  issuesByKey: Record<string, SpaceIssueListState>;
  issueDetails: Record<string, SpaceIssueDetailState>;
  skills: SpaceSkillsState;
  skillDetails: Record<string, SpaceSkillDetailState>;
  skillFiles: Record<string, SpaceSkillFileState>;
  localAgents: SpaceAgentsState;
  registeredAgents: SpaceRegisteredAgentsState;
  events: SpaceEventsState;
}

export interface SpaceDataSnapshot extends StoreState {
  actions: SpaceActions;
}

interface RefreshOptions {
  force?: boolean;
  silent?: boolean;
  maxAgeMs?: number;
}

export interface SpaceActions {
  ensureBootstrapped: (options?: RefreshOptions) => Promise<void>;
  refreshIssues: (params: IssueQueryParams, options?: RefreshOptions) => Promise<void>;
  refreshGoals: (options?: RefreshOptions) => Promise<void>;
  refreshIssueDetail: (issueId: string, options?: RefreshOptions) => Promise<void>;
  refreshSkills: (options?: RefreshOptions) => Promise<void>;
  refreshSkillDetail: (skillId: string, options?: RefreshOptions) => Promise<void>;
  refreshSkillFile: (skillId: string, path: string, options?: RefreshOptions) => Promise<void>;
  refreshLocalAgents: (options?: RefreshOptions) => Promise<void>;
  refreshRegisteredAgents: (options?: RefreshOptions) => Promise<void>;
  syncEvents: (options?: RefreshOptions) => Promise<SpaceEvent[]>;
  createGoal: (input: { parentGoalId: string; title: string; context: string }) => Promise<SpaceGoal>;
  updateGoal: (input: { goalId: string; title: string; context: string }) => Promise<SpaceGoal>;
  archiveGoal: (goalId: string) => Promise<void>;
  createIssue: (input: {
    title: string;
    body: string;
    goalId?: string | null;
    humanOnly?: boolean;
  }) => Promise<SpaceIssue>;
  uploadIssueAttachments: (issueId: string, filePaths: string[]) => Promise<SpaceAttachment[]>;
  downloadIssueAttachment: (input: {
    issueId: string;
    attachmentId: string;
    workspacePath: string;
    fileName?: string;
    output?: string;
  }) => Promise<SpaceDownloadAttachmentResult>;
  commentIssue: (issueId: string, body: string) => Promise<void>;
  setIssueState: (issueId: string, state: string) => Promise<void>;
  closeOwnIssue: (issueId: string) => Promise<void>;
  closeIssue: (issueId: string) => Promise<void>;
  completeIssue: (issueId: string) => Promise<void>;
  cancelIssueClaim: (issueId: string) => Promise<void>;
  uploadSkillZip: (input: {
    filePath: string;
    name?: string;
    description?: string;
    skillId?: string;
  }) => Promise<SpaceSkill>;
  uploadSkillRevision: (skillId: string, filePath: string) => Promise<SpaceSkill>;
  deleteSkill: (skillId: string) => Promise<void>;
  installSkill: (input: {
    skillId: string;
    skillName: string;
    target: 'global' | 'project';
    workspacePath?: string;
  }) => Promise<{
    installedName: string;
    installedPath: string;
    target: string;
    renamed: boolean;
  }>;
  registerAgent: (input: {
    displayName: string;
    workspaceId: string;
    workspacePath: string;
    workspaceLabel?: string;
    goalId: string;
    stateFilter?: string[];
  }) => Promise<LocalRegisteredAgent>;
  updateRegisteredAgent: (input: {
    id: string;
    displayName?: string;
    workspaceLabel?: string;
    status?: 'active' | 'disabled';
  }) => Promise<LocalRegisteredAgent>;
  revokeRegisteredAgent: (id: string) => Promise<LocalRegisteredAgent>;
  logout: () => Promise<void>;
}

const EMPTY_ISSUE_LIST: SpaceIssueListState = {
  items: [],
  hasMore: false,
  nextCursor: null,
  lastFetchedAt: 0,
  isLoading: false,
  error: null,
};

const initialState = (): StoreState => ({
  boot: 'idle',
  session: null,
  spaceId: null,
  goals: [],
  bootError: null,
  bootLastFetchedAt: 0,
  issuesByKey: {},
  issueDetails: {},
  skills: {
    items: [],
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  },
  skillDetails: {},
  skillFiles: {},
  localAgents: {
    items: [],
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  },
  registeredAgents: {
    items: [],
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  },
  events: {
    items: [],
    cursor: null,
    initialized: false,
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  },
});

let state: StoreState = initialState();
const listeners = new Set<() => void>();
let snapshot!: SpaceDataSnapshot;
let bootPromise: Promise<void> | null = null;
let seq = 0;
const latestSeqByKey = new Map<string, number>();
const inFlightRequests = new Map<string, Promise<void>>();

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildSnapshot(): SpaceDataSnapshot {
  return { ...state, actions };
}

function emit(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

function setState(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  emit();
}

function startRequest(key: string): number {
  const next = ++seq;
  latestSeqByKey.set(key, next);
  return next;
}

function isLatest(key: string, requestSeq: number): boolean {
  return latestSeqByKey.get(key) === requestSeq;
}

function isFresh(lastFetchedAt: number, maxAgeMs?: number): boolean {
  return Boolean(maxAgeMs && lastFetchedAt > 0 && Date.now() - lastFetchedAt < maxAgeMs);
}

function trimCacheRecord<T extends { lastFetchedAt: number; isLoading: boolean }>(
  record: Record<string, T>,
  maxEntries: number,
): Record<string, T> {
  const entries = Object.entries(record);
  if (entries.length <= maxEntries) return record;
  return Object.fromEntries(
    entries
      .sort(([, a], [, b]) => {
        if (a.isLoading !== b.isLoading) return a.isLoading ? -1 : 1;
        return b.lastFetchedAt - a.lastFetchedAt;
      })
      .slice(0, maxEntries),
  );
}

function ensureReady(): boolean {
  return state.boot === 'ready' && Boolean(state.session);
}

function spaceRouteSegment(space?: SpaceSession['space'] | null): string {
  return space?.slug || space?.id || DEFAULT_SPACE_ID;
}

function activeSpaceId(): string {
  return state.spaceId || spaceRouteSegment(state.session?.space);
}

function scopedKey(key: string): string {
  return `${activeSpaceId()}\n${key}`;
}

function unscopedKey(key: string): string {
  const separator = key.indexOf('\n');
  return separator === -1 ? key : key.slice(separator + 1);
}

function runRequest(key: string, force: boolean | undefined, task: () => Promise<void>): Promise<void> {
  if (!force) {
    const existing = inFlightRequests.get(key);
    if (existing) return existing;
  }
  const promise = task().finally(() => {
    if (inFlightRequests.get(key) === promise) {
      inFlightRequests.delete(key);
    }
  });
  inFlightRequests.set(key, promise);
  return promise;
}

function invalidatePendingRequests(): void {
  seq += 1;
  bootPromise = null;
  latestSeqByKey.clear();
  inFlightRequests.clear();
}

function normalizeIssueQueryParams(params: IssueQueryParams): IssueQueryParams {
  return {
    q: params.q?.trim() || undefined,
    state: params.state?.trim() || undefined,
    goalId: params.goalId?.trim() || undefined,
    includeSubtree: params.includeSubtree,
    humanOnly: params.humanOnly,
    cursor: params.cursor?.trim() || undefined,
    limit: params.limit ?? 50,
  };
}

function goalMatchesFilter(issueGoalId: string | null | undefined, goalId: string, includeSubtree: boolean): boolean {
  const normalizedIssueGoalId = issueGoalId?.trim();
  if (goalId === 'inbox' || goalId === 'null') return !normalizedIssueGoalId;
  if (!normalizedIssueGoalId) return false;
  if (normalizedIssueGoalId === goalId) return true;
  if (!includeSubtree) return false;

  const goalsById = new Map(state.goals.map((goal) => [goal.id, goal]));
  let current = goalsById.get(normalizedIssueGoalId);
  const visited = new Set<string>();
  for (let depth = 0; current && depth < 64; depth += 1) {
    const currentId = current.id;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const parentGoalId = current.parentGoalId?.trim();
    if (!parentGoalId) return false;
    if (parentGoalId === goalId) return true;
    current = goalsById.get(parentGoalId);
  }

  return false;
}

function issueMatchesListKey(issue: SpaceIssue, key: string): boolean {
  const params = new URLSearchParams(unscopedKey(key));
  const cursor = params.get('cursor')?.trim();
  if (cursor) return false;

  const state = params.get('state')?.trim();
  if (state && state !== 'all' && !state.split(',').some((item) => item.trim() === issue.state)) return false;

  const goalId = params.get('goalId')?.trim();
  if (goalId && !goalMatchesFilter(issue.goalId, goalId, params.get('includeSubtree') === 'true')) return false;

  const humanOnly = params.get('humanOnly')?.trim();
  if (humanOnly === 'true' && !issue.humanOnly) return false;
  if (humanOnly === 'false' && issue.humanOnly) return false;

  const q = params.get('q')?.trim().toLowerCase();
  if (q && !issue.title.toLowerCase().includes(q)) return false;

  return true;
}

export function getIssueListState(params: IssueQueryParams): SpaceIssueListState {
  return state.issuesByKey[scopedKey(buildIssueQueryKey(params))] ?? EMPTY_ISSUE_LIST;
}

function patchIssueInLists(issue: SpaceIssue): void {
  const detailKey = scopedKey(issue.id);
  const issuesByKey = Object.fromEntries(
    Object.entries(state.issuesByKey).map(([key, slice]) => {
      const items = slice.items.flatMap((item) => {
        if (item.id !== issue.id) return [item];
        const next = { ...item, ...issue };
        return issueMatchesListKey(next, key) ? [next] : [];
      });
      const hasIssue = items.some((item) => item.id === issue.id);
      return [
        key,
        {
          ...slice,
          items: !hasIssue && issueMatchesListKey(issue, key) ? [issue, ...items] : items,
        },
      ];
    }),
  );
  const existingDetail = state.issueDetails[detailKey];
  const issueDetails = existingDetail?.detail
    ? {
        ...state.issueDetails,
        [detailKey]: {
          ...existingDetail,
          detail: {
            ...existingDetail.detail,
            issue: { ...existingDetail.detail.issue, ...issue },
          },
        },
      }
    : state.issueDetails;
  setState({ issuesByKey, issueDetails });
}

function prependIssueToLists(issue: SpaceIssue): void {
  const issuesByKey = Object.fromEntries(
    Object.entries(state.issuesByKey).map(([key, slice]) => {
      if (!issueMatchesListKey(issue, key)) return [key, slice];
      const withoutDuplicate = slice.items.filter((item) => item.id !== issue.id);
      return [key, { ...slice, items: [issue, ...withoutDuplicate] }];
    }),
  );
  setState({ issuesByKey });
}

function patchIssueDetail(issueId: string, patch: (detail: SpaceIssueDetail) => SpaceIssueDetail): void {
  const key = scopedKey(issueId);
  const current = state.issueDetails[key];
  if (!current?.detail) return;
  setState({
    issueDetails: {
      ...state.issueDetails,
      [key]: { ...current, detail: patch(current.detail) },
    },
  });
}

function detailKey(id: string): string {
  return scopedKey(id);
}

function skillFileKey(skillId: string, path: string): string {
  return scopedKey(`${skillId}\n${path}`);
}

function localAgentToRegisteredAgent(agent: LocalRegisteredAgent): SpaceRegisteredAgent {
  return {
    id: agent.id,
    spaceId: agent.spaceId,
    clientId: agent.clientId,
    localWorkspaceId: agent.localWorkspaceId,
    localAgentId: agent.localAgentId,
    displayName: agent.displayName,
    workspaceLabel: agent.workspaceLabel,
    subscriptions: agent.goalId
      ? [
          {
            id: `local:${agent.id}:${agent.goalId}`,
            spaceId: agent.spaceId,
            actorType: 'registered_agent',
            actorId: agent.id,
            goalId: agent.goalId,
            includeSubtree: true,
            stateFilter: agent.stateFilter,
            goalPathLabel: agent.goalPathLabel,
            createdAt: agent.createdAt,
          },
        ]
      : [],
    status: agent.status,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

export const actions: SpaceActions = {
  ensureBootstrapped: async (options: RefreshOptions = {}) => {
    if (
      !options.force &&
      (state.boot === 'ready' || state.boot === 'signedOut') &&
      (!options.maxAgeMs || isFresh(state.bootLastFetchedAt, options.maxAgeMs))
    ) {
      return;
    }
    if (bootPromise && !options.force) return bootPromise;
    if (!options.silent) setState({ boot: 'loading', bootError: null });
    const requestSeq = startRequest('boot');
    bootPromise = (async () => {
      const startedAt = nowForSpaceMetric();
      recordSpaceMetric('space_boot_start');
      try {
        const session = await spaceGetSession();
        if (!isLatest('boot', requestSeq)) return;
        if (!session) {
          setState({
            ...initialState(),
            boot: 'signedOut',
            bootLastFetchedAt: Date.now(),
          });
          return;
        }
        const official = await spaceGetOfficial(spaceRouteSegment(session.space));
        if (!isLatest('boot', requestSeq)) return;
        const nextSpaceId = spaceRouteSegment(official.space || session.space);
        const spaceChanged = Boolean(state.spaceId && state.spaceId !== nextSpaceId);
        if (spaceChanged) {
          state = { ...initialState(), boot: state.boot };
        }
        setState({
          boot: 'ready',
          session: {
            ...session,
            space: official.space,
            membership: official.membership,
          },
          spaceId: nextSpaceId,
          goals: official.goals ?? [],
          bootError: null,
          bootLastFetchedAt: Date.now(),
        });
        recordSpaceMetric('space_boot_end', {
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          ok: true,
        });
      } catch (error) {
        if (!isLatest('boot', requestSeq)) return;
        if (options.silent && (state.boot === 'ready' || state.boot === 'signedOut')) {
          setState({ bootError: errMessage(error) });
          recordSpaceMetric('space_boot_end', {
            durationMs: Math.round(nowForSpaceMetric() - startedAt),
            ok: false,
            error: errMessage(error),
          });
          return;
        }
        setState({
          boot: 'error',
          bootError: errMessage(error),
        });
        recordSpaceMetric('space_boot_end', {
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          ok: false,
          error: errMessage(error),
        });
      } finally {
        if (isLatest('boot', requestSeq)) bootPromise = null;
      }
    })();
    return bootPromise;
  },

  refreshIssues: async (params: IssueQueryParams, options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    const normalizedParams = normalizeIssueQueryParams(params);
    const key = scopedKey(buildIssueQueryKey(normalizedParams));
    const current = state.issuesByKey[key] ?? EMPTY_ISSUE_LIST;
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs)) return;
    const requestKey = `issues:${key}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        issuesByKey: {
          ...state.issuesByKey,
          [key]: {
            ...current,
            isLoading: true,
            error: options.silent ? current.error : null,
          },
        },
      });
      try {
        const result = await spaceListIssues(normalizedParams, activeSpaceId());
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          issuesByKey: trimCacheRecord(
            {
              ...state.issuesByKey,
              [key]: {
                items: result.items,
                hasMore: result.hasMore,
                nextCursor: result.nextCursor,
                lastFetchedAt: Date.now(),
                isLoading: false,
                error: null,
              },
            },
            SPACE_MAX_ISSUE_LIST_CACHES,
          ),
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        const latest = state.issuesByKey[key] ?? current;
        setState({
          issuesByKey: {
            ...state.issuesByKey,
            [key]: { ...latest, isLoading: false, error: errMessage(error) },
          },
        });
        throw error;
      }
    });
  },

  refreshGoals: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    if (!options.force && isFresh(state.bootLastFetchedAt, options.maxAgeMs)) return;
    return runRequest('goals', options.force, async () => {
      const requestSeq = startRequest('goals');
      try {
        const result = await spaceListGoals({}, activeSpaceId());
        if (!isLatest('goals', requestSeq)) return;
        setState({
          goals: result.items,
          bootLastFetchedAt: Date.now(),
          bootError: null,
        });
      } catch (error) {
        if (!isLatest('goals', requestSeq)) return;
        setState({ bootError: errMessage(error) });
        throw error;
      }
    });
  },

  refreshIssueDetail: async (issueId: string, options: RefreshOptions = {}) => {
    if (!ensureReady() || !issueId) return;
    const key = detailKey(issueId);
    const current = state.issueDetails[key] ?? {
      detail: null,
      lastFetchedAt: 0,
      isLoading: false,
      error: null,
    };
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs)) return;
    const requestKey = `issue:${key}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        issueDetails: {
          ...state.issueDetails,
          [key]: {
            ...current,
            isLoading: true,
            error: options.silent ? current.error : null,
          },
        },
      });
      try {
        const startedAt = nowForSpaceMetric();
        const detail = await spaceGetIssue(issueId);
        if (!isLatest(requestKey, requestSeq)) return;
        recordSpaceMetric('space_issue_detail_open', {
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          ok: true,
        });
        setState({
          issueDetails: trimCacheRecord(
            {
              ...state.issueDetails,
              [key]: {
                detail,
                lastFetchedAt: Date.now(),
                isLoading: false,
                error: null,
              },
            },
            SPACE_MAX_ISSUE_DETAIL_CACHES,
          ),
        });
        patchIssueInLists(detail.issue);
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        recordSpaceMetric('space_issue_detail_open', {
          ok: false,
          error: errMessage(error),
        });
        const latest = state.issueDetails[key] ?? current;
        setState({
          issueDetails: {
            ...state.issueDetails,
            [key]: { ...latest, isLoading: false, error: errMessage(error) },
          },
        });
        throw error;
      }
    });
  },

  refreshSkills: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    if (!options.force && isFresh(state.skills.lastFetchedAt, options.maxAgeMs)) return;
    return runRequest('skills', options.force, async () => {
      const requestSeq = startRequest('skills');
      setState({
        skills: {
          ...state.skills,
          isLoading: true,
          error: options.silent ? state.skills.error : null,
        },
      });
      try {
        const result = await spaceListSkills(activeSpaceId());
        if (!isLatest('skills', requestSeq)) return;
        setState({
          skills: {
            items: result.items,
            lastFetchedAt: Date.now(),
            isLoading: false,
            error: null,
          },
        });
      } catch (error) {
        if (!isLatest('skills', requestSeq)) return;
        setState({
          skills: {
            ...state.skills,
            isLoading: false,
            error: errMessage(error),
          },
        });
        throw error;
      }
    });
  },

  refreshSkillDetail: async (skillId: string, options: RefreshOptions = {}) => {
    if (!ensureReady() || !skillId) return;
    const key = detailKey(skillId);
    const current = state.skillDetails[key] ?? {
      detail: null,
      lastFetchedAt: 0,
      isLoading: false,
      error: null,
    };
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs)) return;
    const requestKey = `skill:${key}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        skillDetails: {
          ...state.skillDetails,
          [key]: {
            ...current,
            isLoading: true,
            error: options.silent ? current.error : null,
          },
        },
      });
      try {
        const detail = await spaceGetSkill(skillId);
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          skillDetails: trimCacheRecord(
            {
              ...state.skillDetails,
              [key]: {
                detail,
                lastFetchedAt: Date.now(),
                isLoading: false,
                error: null,
              },
            },
            SPACE_MAX_SKILL_DETAIL_CACHES,
          ),
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          skillDetails: {
            ...state.skillDetails,
            [key]: { ...current, isLoading: false, error: errMessage(error) },
          },
        });
        throw error;
      }
    });
  },

  refreshSkillFile: async (skillId: string, path: string, options: RefreshOptions = {}) => {
    if (!ensureReady() || !skillId || !path) return;
    const key = skillFileKey(skillId, path);
    const current = state.skillFiles[key] ?? {
      text: '',
      lastFetchedAt: 0,
      isLoading: false,
      error: null,
    };
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs)) return;
    const requestKey = `skill-file:${key}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        skillFiles: {
          ...state.skillFiles,
          [key]: {
            ...current,
            isLoading: true,
            error: options.silent ? current.error : null,
          },
        },
      });
      try {
        const result = await spaceGetSkillFile(skillId, path);
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          skillFiles: trimCacheRecord(
            {
              ...state.skillFiles,
              [key]: {
                text: result.binary
                  ? `Binary file · ${result.mimeType ?? 'unknown'} · ${formatBytesForStore(result.sizeBytes)}`
                  : (result.text ?? ''),
                binary: result.binary,
                mimeType: result.mimeType,
                sizeBytes: result.sizeBytes,
                lastFetchedAt: Date.now(),
                isLoading: false,
                error: null,
              },
            },
            SPACE_MAX_SKILL_FILE_CACHES,
          ),
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          skillFiles: {
            ...state.skillFiles,
            [key]: { ...current, isLoading: false, error: errMessage(error) },
          },
        });
        throw error;
      }
    });
  },

  refreshLocalAgents: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    if (!options.force && isFresh(state.localAgents.lastFetchedAt, options.maxAgeMs)) return;
    return runRequest('agents', options.force, async () => {
      const requestSeq = startRequest('agents');
      setState({
        localAgents: {
          ...state.localAgents,
          isLoading: true,
          error: options.silent ? state.localAgents.error : null,
        },
      });
      try {
        const items = await spaceListLocalAgents();
        if (!isLatest('agents', requestSeq)) return;
        setState({
          localAgents: {
            items,
            lastFetchedAt: Date.now(),
            isLoading: false,
            error: null,
          },
        });
      } catch (error) {
        if (!isLatest('agents', requestSeq)) return;
        setState({
          localAgents: {
            ...state.localAgents,
            isLoading: false,
            error: errMessage(error),
          },
        });
        throw error;
      }
    });
  },

  refreshRegisteredAgents: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    if (!options.force && isFresh(state.registeredAgents.lastFetchedAt, options.maxAgeMs)) return;
    return runRequest('registered-agents', options.force, async () => {
      const requestSeq = startRequest('registered-agents');
      setState({
        registeredAgents: {
          ...state.registeredAgents,
          isLoading: true,
          error: options.silent ? state.registeredAgents.error : null,
        },
      });
      try {
        const result = await spaceListRegisteredAgents(activeSpaceId());
        if (!isLatest('registered-agents', requestSeq)) return;
        setState({
          registeredAgents: {
            items: result.items,
            lastFetchedAt: Date.now(),
            isLoading: false,
            error: null,
          },
        });
      } catch (error) {
        if (!isLatest('registered-agents', requestSeq)) return;
        setState({
          registeredAgents: {
            ...state.registeredAgents,
            isLoading: false,
            error: errMessage(error),
          },
        });
        throw error;
      }
    });
  },

  syncEvents: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return [];
    const current = state.events;
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs)) return [];
    const requestKey = 'events';
    let delivered: SpaceEvent[] = [];
    await runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        events: {
          ...state.events,
          isLoading: true,
          error: options.silent ? state.events.error : null,
        },
      });
      try {
        const baseline = !state.events.initialized;
        const startedAt = nowForSpaceMetric();
        recordSpaceMetric('space_event_sync_start');
        const result = await spaceListEvents(
          {
            cursor: state.events.cursor,
            limit: 100,
            tail: baseline && !state.events.cursor,
          },
          activeSpaceId(),
        );
        if (!isLatest(requestKey, requestSeq)) return;
        const seenIds = new Set(state.events.items.map((event) => event.id));
        const newItems = result.items.filter((event) => {
          if (seenIds.has(event.id)) return false;
          seenIds.add(event.id);
          return true;
        });
        const nextCursor = result.nextCursor ?? state.events.cursor ?? null;
        delivered = baseline ? [] : newItems;
        recordSpaceMetric('space_event_sync_end', {
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          count: newItems.length,
          ok: true,
        });
        setState({
          events: {
            items: [...state.events.items, ...newItems].slice(-200),
            cursor: nextCursor,
            initialized: true,
            lastFetchedAt: Date.now(),
            isLoading: false,
            error: null,
          },
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        recordSpaceMetric('space_event_sync_end', {
          ok: false,
          error: errMessage(error),
        });
        setState({
          events: {
            ...state.events,
            isLoading: false,
            error: errMessage(error),
          },
        });
        throw error;
      }
    });
    return delivered;
  },

  createIssue: (input) =>
    withSpaceMutationMetric('issue.create', async () => {
      const result = await spaceCreateIssue(input, activeSpaceId());
      prependIssueToLists(result.issue);
      return result.issue;
    }),

  createGoal: (input) =>
    withSpaceMutationMetric('goal.create', async () => {
      const result = await spaceCreateGoal(input, activeSpaceId());
      await actions.refreshGoals({ force: true, silent: true });
      return result.goal;
    }),

  updateGoal: (input) =>
    withSpaceMutationMetric('goal.update', async () => {
      const result = await spaceUpdateGoal(input);
      await actions.refreshGoals({ force: true, silent: true });
      return result.goal;
    }),

  archiveGoal: (goalId) =>
    withSpaceMutationMetric('goal.archive', async () => {
      await spaceArchiveGoal(goalId);
      await actions.refreshGoals({ force: true, silent: true });
      setState({
        issuesByKey: {},
        issueDetails: {},
      });
    }),

  uploadIssueAttachments: (issueId, filePaths) =>
    withSpaceMutationMetric('issue.attachments.upload', async () => {
      const result = await spaceUploadIssueAttachments({ issueId, filePaths });
      patchIssueDetail(issueId, (detail) => ({
        ...detail,
        attachments: [...detail.attachments, ...result.attachments],
        issue: {
          ...detail.issue,
          attachmentCount: (detail.issue.attachmentCount ?? detail.attachments.length) + result.attachments.length,
        },
      }));
      const currentIssue = state.issueDetails[detailKey(issueId)]?.detail?.issue;
      if (currentIssue) patchIssueInLists(currentIssue);
      return result.attachments;
    }),

  downloadIssueAttachment: (input) => spaceDownloadIssueAttachment(input),

  commentIssue: (issueId, body) =>
    withSpaceMutationMetric('issue.comment', async () => {
      const result = await spaceCommentIssue(issueId, body);
      patchIssueDetail(issueId, (detail) => ({
        ...detail,
        comments: {
          ...detail.comments,
          items: [...detail.comments.items, result.comment],
        },
        issue: {
          ...detail.issue,
          commentCount: (detail.issue.commentCount ?? detail.comments.items.length) + 1,
        },
      }));
      const currentIssue = state.issueDetails[detailKey(issueId)]?.detail?.issue;
      if (currentIssue) patchIssueInLists(currentIssue);
    }),

  setIssueState: (issueId, nextState) =>
    withSpaceMutationMetric('issue.state', async () => {
      const result = await spaceSetIssueState(issueId, nextState);
      const current = state.issueDetails[detailKey(issueId)]?.detail?.issue ?? findIssueInLists(issueId);
      if (current)
        patchIssueInLists({
          ...current,
          state: result.state,
          updatedAt: result.updatedAt,
        });
    }),

  closeOwnIssue: (issueId) =>
    withSpaceMutationMetric('issue.close_own', async () => {
      const result = await spaceCloseOwnIssue(issueId);
      const current = state.issueDetails[detailKey(issueId)]?.detail?.issue ?? findIssueInLists(issueId);
      if (current)
        patchIssueInLists({
          ...current,
          state: result.state,
          updatedAt: result.updatedAt,
        });
    }),

  closeIssue: (issueId) =>
    withSpaceMutationMetric('issue.close', async () => {
      const result = await spaceCloseIssue(issueId);
      const current = state.issueDetails[detailKey(issueId)]?.detail?.issue ?? findIssueInLists(issueId);
      if (current)
        patchIssueInLists({
          ...current,
          state: result.state,
          updatedAt: result.updatedAt,
        });
    }),

  completeIssue: (issueId) =>
    withSpaceMutationMetric('issue.complete', async () => {
      const result = await spaceCompleteIssue(issueId);
      const current = state.issueDetails[detailKey(issueId)]?.detail?.issue ?? findIssueInLists(issueId);
      if (current)
        patchIssueInLists({
          ...current,
          state: result.state,
          updatedAt: result.updatedAt,
        });
    }),

  cancelIssueClaim: (issueId) =>
    withSpaceMutationMetric('issue.cancel_claim', async () => {
      const result = await spaceCancelIssueClaim(issueId);
      const current = state.issueDetails[detailKey(issueId)]?.detail?.issue ?? findIssueInLists(issueId);
      if (current)
        patchIssueInLists({
          ...current,
          state: result.state,
          updatedAt: result.updatedAt,
        });
    }),

  uploadSkillZip: (input) =>
    withSpaceMutationMetric('skill.upload', async () => {
      const result = await spaceUploadSkillZip(input);
      setState({
        skills: {
          ...state.skills,
          items: [result.skill, ...state.skills.items.filter((skill) => skill.id !== result.skill.id)],
        },
      });
      return result.skill;
    }),

  uploadSkillRevision: (skillId, filePath) =>
    withSpaceMutationMetric('skill.revision.upload', async () => {
      const result = await spaceUploadSkillZip({ filePath, skillId });
      setState({
        skills: {
          ...state.skills,
          items: [result.skill, ...state.skills.items.filter((skill) => skill.id !== result.skill.id)],
        },
        skillDetails: Object.fromEntries(
          Object.entries(state.skillDetails).filter(([key]) => unscopedKey(key) !== result.skill.id),
        ),
        skillFiles: Object.fromEntries(
          Object.entries(state.skillFiles).filter(([key]) => !unscopedKey(key).startsWith(`${result.skill.id}\n`)),
        ),
      });
      return result.skill;
    }),

  deleteSkill: (skillId) =>
    withSpaceMutationMetric('skill.delete', async () => {
      await spaceDeleteSkill(skillId);
      setState({
        skills: {
          ...state.skills,
          items: state.skills.items.filter((skill) => skill.id !== skillId),
        },
        skillDetails: Object.fromEntries(
          Object.entries(state.skillDetails).filter(([key]) => unscopedKey(key) !== skillId),
        ),
        skillFiles: Object.fromEntries(
          Object.entries(state.skillFiles).filter(([key]) => !unscopedKey(key).startsWith(`${skillId}\n`)),
        ),
      });
    }),

  installSkill: (input) => withSpaceMutationMetric('skill.install', () => spaceInstallSkill(input)),

  registerAgent: (input) =>
    withSpaceMutationMetric('agent.register', async () => {
      const agent = await spaceRegisterAgent(input);
      const registeredAgent = localAgentToRegisteredAgent(agent);
      setState({
        localAgents: {
          ...state.localAgents,
          items: [agent, ...state.localAgents.items.filter((item) => item.id !== agent.id)],
        },
        registeredAgents: {
          ...state.registeredAgents,
          items: [registeredAgent, ...state.registeredAgents.items.filter((item) => item.id !== registeredAgent.id)],
        },
      });
      return agent;
    }),

  updateRegisteredAgent: (input) =>
    withSpaceMutationMetric('agent.update', async () => {
      const agent = await spaceUpdateRegisteredAgent(input);
      const registeredAgent = localAgentToRegisteredAgent(agent);
      setState({
        localAgents: {
          ...state.localAgents,
          items: state.localAgents.items.map((item) => (item.id === agent.id ? agent : item)),
        },
        registeredAgents: {
          ...state.registeredAgents,
          items: state.registeredAgents.items.map((item) =>
            item.id === registeredAgent.id ? { ...item, ...registeredAgent } : item,
          ),
        },
      });
      return agent;
    }),

  revokeRegisteredAgent: (id) =>
    withSpaceMutationMetric('agent.revoke', async () => {
      const agent = await spaceRevokeRegisteredAgent(id);
      const registeredAgent = localAgentToRegisteredAgent(agent);
      setState({
        localAgents: {
          ...state.localAgents,
          items: state.localAgents.items.map((item) => (item.id === agent.id ? agent : item)),
        },
        registeredAgents: {
          ...state.registeredAgents,
          items: state.registeredAgents.items.map((item) =>
            item.id === registeredAgent.id ? { ...item, ...registeredAgent } : item,
          ),
        },
      });
      return agent;
    }),

  logout: async () => {
    invalidatePendingRequests();
    await spaceLogout();
    setState({ ...initialState(), boot: 'signedOut' });
  },
};

function findIssueInLists(issueId: string): SpaceIssue | null {
  for (const list of Object.values(state.issuesByKey)) {
    const found = list.items.find((issue) => issue.id === issueId);
    if (found) return found;
  }
  return null;
}

function formatBytesForStore(value?: number | null): string {
  if (!value || value <= 0) return '0 KB';
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

snapshot = buildSnapshot();

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (state.boot === 'idle') {
    void actions.ensureBootstrapped();
  }
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): SpaceDataSnapshot {
  return snapshot;
}

export function getSkillFileState(skillId: string, path: string): SpaceSkillFileState | null {
  return state.skillFiles[skillFileKey(skillId, path)] ?? null;
}

export function __resetSpaceStoreForTest(): void {
  state = initialState();
  listeners.clear();
  bootPromise = null;
  seq = 0;
  latestSeqByKey.clear();
  inFlightRequests.clear();
  snapshot = buildSnapshot();
}

export function __setSpaceStoreStateForTest(patch: Partial<StoreState>): void {
  setState(patch);
}
