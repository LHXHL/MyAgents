import type { LocalRegisteredAgent, SpaceIssue, SpaceSession } from '@/api/spaceCloud';
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
const CLOSED_ISSUE_STATUSES = new Set(['done', 'closed']);

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

export function canCloseOwnIssue(session: SpaceSession | null, issue: SpaceIssue | null): boolean {
  if (!session || !issue || isSpaceAdmin(session) || isClosedIssue(issue.state)) return false;
  return issue.createdByUserId === session.user.id || issue.creator?.id === session.user.id || issue.author?.id === session.user.id;
}

export function getIssueStatusOptions(args: {
  session: SpaceSession | null;
  issue: SpaceIssue | null;
}): Array<{ value: string; label: string; kind: 'set-status' | 'close-own' }> {
  if (!args.session || !args.issue) return [];
  if (isSpaceAdmin(args.session)) {
    return ISSUE_STATUSES
      .filter((state) => state !== 'doing')
      .map((state) => ({
        value: state,
        label: issueStatusLabel(state),
        kind: 'set-status',
      }));
  }
  if (canCloseOwnIssue(args.session, args.issue)) {
    return [{ value: 'closed', label: 'Close issue', kind: 'close-own' }];
  }
  return [];
}

export function issueStatusLabel(status: string): string {
  if (status === 'todo') return 'todo';
  if (status === 'doing') return 'doing';
  if (status === 'done') return 'done';
  return status.replaceAll('_', ' ');
}

function normalizeIssueStatusToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

export function issueDisplayTitle(issue: Pick<SpaceIssue, 'state' | 'title'>): string {
  return issue.title.replace(/^\[([^\]]+)\]\s*/, (match, rawStatus: string) => (
    normalizeIssueStatusToken(rawStatus) === normalizeIssueStatusToken(issue.state) ? '' : match
  ));
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
