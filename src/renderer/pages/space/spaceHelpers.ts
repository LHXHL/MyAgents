import type { LocalRegisteredAgent, SpaceIssue, SpaceIssueClaim, SpaceSession } from '@/api/spaceCloud';
import type { Project } from '@/config/types';
import { findProjectForAgent } from '@/api/spaceCloud';

export const ISSUE_STATUSES = [
  'open',
  'todo',
  'doing',
  'done',
  'closed',
] as const;

export type IssueStatus = typeof ISSUE_STATUSES[number];
export const ACTIVE_ISSUE_STATE_FILTER = 'open,todo,doing';
const CLOSED_ISSUE_STATUSES = new Set(['done', 'closed']);
const ISSUE_STATUS_LABEL_FALLBACKS: Record<IssueStatus, string> = {
  open: 'open',
  todo: 'todo',
  doing: 'doing',
  done: 'done',
  closed: 'closed',
};

type IssueStatusTranslator = (key: string, options?: { defaultValue?: string }) => string;

export interface IssueQueryParams {
  q?: string;
  state?: string;
  goalId?: string;
  includeSubtree?: boolean;
  humanOnly?: boolean | null;
  cursor?: string;
  limit?: number;
}

export function buildIssueQueryKey(params: IssueQueryParams): string {
  const normalized = {
    q: params.q?.trim() ?? '',
    state: params.state?.trim() ?? '',
    goalId: params.goalId?.trim() ?? '',
    includeSubtree: params.includeSubtree ? 'true' : '',
    humanOnly: params.humanOnly === undefined || params.humanOnly === null ? '' : String(params.humanOnly),
    cursor: params.cursor?.trim() ?? '',
    limit: params.limit ?? 50,
  };
  return new URLSearchParams([
    ['q', normalized.q],
    ['state', normalized.state],
    ['goalId', normalized.goalId],
    ['includeSubtree', normalized.includeSubtree],
    ['humanOnly', normalized.humanOnly],
    ['cursor', normalized.cursor],
    ['limit', String(normalized.limit)],
  ]).toString();
}

export function isSpaceAdmin(session: SpaceSession | null): boolean {
  return session?.membership?.role === 'owner' || session?.membership?.role === 'admin';
}

export function isClosedIssue(status: string): boolean {
  return CLOSED_ISSUE_STATUSES.has(status);
}

export function isRegisteredAgentVisibleInList(
  agent: Pick<LocalRegisteredAgent, 'status'>,
): boolean {
  return agent.status.trim().toLowerCase() !== 'revoked';
}

function normalizeIssueNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function issueDisplayNumber(
  issue: Pick<SpaceIssue, 'id'> & Partial<Pick<SpaceIssue, 'number' | 'issueNumber'>>,
): string | null {
  const number =
    normalizeIssueNumber(issue.number)
    ?? normalizeIssueNumber(issue.issueNumber)
    ?? normalizeIssueNumber(issue.id.match(/(?:^|[_#-])(\d+)$/)?.[1]);
  return number ? `#${number}` : null;
}

export function canCloseOwnIssue(session: SpaceSession | null, issue: SpaceIssue | null): boolean {
  if (!session || !issue || isSpaceAdmin(session) || isClosedIssue(issue.state)) return false;
  return issue.createdByUserId === session.user.id || issue.creator?.id === session.user.id || issue.author?.id === session.user.id;
}

function normalizedIdentityValue(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function localAgentMatchesCurrentSpaceIdentity(
  localAgent: LocalRegisteredAgent | undefined,
  currentSpaceId: string | null | undefined,
  currentUserId: string | null | undefined,
  currentLocalDeviceId: string | null | undefined,
): boolean {
  if (!localAgent || !currentSpaceId || !currentUserId || !currentLocalDeviceId) {
    return false;
  }
  const spaceId = normalizedIdentityValue(localAgent.spaceId);
  const targetSpaceId = normalizedIdentityValue(currentSpaceId);
  const ownerUserId = normalizedIdentityValue(localAgent.ownerUserId);
  const targetUserId = normalizedIdentityValue(currentUserId);
  const deviceId = normalizedIdentityValue(
    localAgent.deviceId ?? localAgent.device?.deviceId,
  );
  const targetDeviceId = normalizedIdentityValue(currentLocalDeviceId);
  return (
    spaceId === targetSpaceId &&
    ownerUserId === targetUserId &&
    deviceId === targetDeviceId
  );
}

export function getIssueStatusOptions(args: {
  session: SpaceSession | null;
  issue: SpaceIssue | null;
  t?: IssueStatusTranslator;
}): Array<{ value: string; label: string; kind: 'set-status' | 'close-own' }> {
  if (!args.session || !args.issue) return [];
  if (isSpaceAdmin(args.session)) {
    return ISSUE_STATUSES
      .filter((state) => state !== 'doing')
      .map((state) => ({
        value: state,
        label: issueStatusLabel(state, args.t),
        kind: 'set-status',
      }));
  }
  if (canCloseOwnIssue(args.session, args.issue)) {
    return [{
      value: 'closed',
      label: args.t?.('space.issueActions.closeIssue', { defaultValue: 'Close issue' }) ?? 'Close issue',
      kind: 'close-own',
    }];
  }
  return [];
}

export function issueStatusLabel(status: string, t?: IssueStatusTranslator): string {
  const normalized = normalizeIssueStatusToken(status);
  const knownStatus = ISSUE_STATUSES.find((item) => item === normalized);
  const fallback = knownStatus ? ISSUE_STATUS_LABEL_FALLBACKS[knownStatus] : status.replaceAll('_', ' ');
  if (!knownStatus || !t) return fallback;
  return t(`space.issueStatuses.${knownStatus}`, { defaultValue: fallback });
}

function normalizeIssueStatusToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

export function issueDisplayTitle(issue: Pick<SpaceIssue, 'state' | 'title'>): string {
  return issue.title.replace(/^\[([^\]]+)\]\s*/, (match, rawStatus: string) => (
    normalizeIssueStatusToken(rawStatus) === normalizeIssueStatusToken(issue.state) ? '' : match
  ));
}

export function claimHandlerLabel(claim: SpaceIssueClaim | null | undefined): string | null {
  if (!claim) return null;
  return claim.actorName
    || claim.actor?.name
    || claim.actor?.id
    || claim.actorId
    || null;
}

export function claimHandlerTypeKey(claim: SpaceIssueClaim | null | undefined): string | null {
  if (!claim) return null;
  if (claim.actorType === 'registered_agent') return 'space.detail.claimHandlerTypeRegisteredAgent';
  if (claim.actorType === 'user') return 'space.detail.claimHandlerTypeUser';
  return null;
}

export function buildIssueCommandPrompt(args: { spaceName: string; issueId: string }): string {
  return [
    `这是来自「${args.spaceName}」团队空间的 issue。`,
    '',
    '请先读取该 issue，理解标题、正文、附件和评论上下文，再与用户讨论并决策下一步动作。不要在未确认前直接开始修改、执行或关闭 issue。',
    '',
    `Issue ID: ${args.issueId}`,
    '',
    '命令：',
    `myagents space issue view ${args.issueId} --comments`,
    '',
    '处理时可按需使用：',
    `myagents space issue comment ${args.issueId} --body "<和用户确认后的处理记录>"`,
    `myagents space issue claim ${args.issueId}`,
    `myagents space issue complete ${args.issueId}`,
    '',
    '兼容命令：',
    `myagents issue ${args.issueId} --json`,
  ].join('\n');
}

export function formatAgentSecondaryLabel(agent: LocalRegisteredAgent, projects: Project[]): string {
  const project = findProjectForAgent(projects, agent);
  return project?.displayName || project?.name || agent.workspaceLabel || agent.workspacePath;
}
