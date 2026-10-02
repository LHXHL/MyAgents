export type SubagentLifecycleStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface SubagentLifecycle {
  timingVerified?: boolean;
  activation?: {
    id: string;
    ordinal: number;
    state: 'queued' | 'running' | 'waiting_interaction' | 'waiting_child' | 'waiting_delivery' | 'completed' | 'failed' | 'aborted';
  };
  handleRevision?: number;
  agentId?: string;
  taskId?: string;
  tree?: { rootAgentId: string; parentAgentId: string; depth: number };
  modelRoute?: { provider: string; profileRevision: string; selection: 'inherit' | 'fixed' | 'agent' };
  lastActivityAt?: number;
  handleState?: 'open' | 'stopping' | 'closed';
  status: SubagentLifecycleStatus;
  startedAt: number;
  finishedAt?: number;
  agentType?: string;
  description?: string;
  mode?: 'foreground' | 'continuable';
  model?: string;
  result?: string;
  resultTruncated?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number | null;
  };
}

/** Preserve terminal facts within one activation while admitting later work on the same handle. */
export function mergeSubagentLifecycleUpdate(
  current: SubagentLifecycle | undefined,
  incoming: SubagentLifecycle,
): SubagentLifecycle {
  if (!current) return incoming;
  if (current.activation) {
    if (!incoming.activation || incoming.activation.ordinal < current.activation.ordinal) return current;
    if (incoming.activation.ordinal > current.activation.ordinal) return incoming;
    if (incoming.activation.id !== current.activation.id) return current;
    if (current.handleRevision !== undefined && (incoming.handleRevision === undefined || incoming.handleRevision < current.handleRevision)) return current;
    if (current.agentId !== undefined && incoming.agentId !== undefined && current.agentId !== incoming.agentId) return current;
    if (current.status !== 'running') {
      const rank = { open: 0, stopping: 1, closed: 2 };
      // Cold session/read has no event timestamps. An exact live baseline may
      // fill those facts without allowing an older activation to rewrite them.
      const verified = current.timingVerified === false && incoming.timingVerified !== false
        && incoming.status === current.status;
      return {
        ...current,
        ...(incoming.lastActivityAt === undefined ? {} : { lastActivityAt: Math.max(current.lastActivityAt ?? 0, incoming.lastActivityAt) }),
        ...(current.tree || !incoming.tree ? {} : { tree: incoming.tree }),
        ...(current.modelRoute || !incoming.modelRoute ? {} : { modelRoute: incoming.modelRoute }),
        ...(current.agentId || !incoming.agentId ? {} : { agentId: incoming.agentId }),
        ...(current.taskId || !incoming.taskId ? {} : { taskId: incoming.taskId }),
        ...(verified ? {
          timingVerified: true,
          startedAt: incoming.startedAt,
          finishedAt: incoming.finishedAt,
          result: current.result ?? incoming.result,
          resultTruncated: current.resultTruncated ?? incoming.resultTruncated,
          usage: current.usage ?? incoming.usage,
        } : {}),
        ...(incoming.handleRevision !== undefined && incoming.handleRevision > (current.handleRevision ?? -1) ? { handleRevision: incoming.handleRevision } : {}),
        handleState: (incoming.handleRevision !== undefined && incoming.handleRevision > (current.handleRevision ?? -1)) || rank[incoming.handleState ?? 'open'] >= rank[current.handleState ?? 'open']
          ? incoming.handleState ?? current.handleState : current.handleState,
      };
    }
    return incoming;
  }
  if (incoming.activation) return incoming;
  return current.status !== 'running' ? current : incoming;
}

export function isTerminalSubagentLifecycleStatus(
  status: SubagentLifecycleStatus,
): status is Exclude<SubagentLifecycleStatus, 'running'> {
  return status !== 'running';
}

type ResidualSubagentCall = {
  isLoading?: boolean;
  result?: string;
  isError?: boolean;
};

/**
 * Root-terminal parity policy for a nested call that never produced a terminal
 * result. Preserve real output, but make a resultless residual visibly
 * interrupted/failed instead of silently presenting it as successful.
 */
export function finalizeResidualSubagentCall<T extends ResidualSubagentCall>(
  call: T,
  status: 'failed' | 'interrupted',
): T {
  if (!call.isLoading) return call;
  return {
    ...call,
    isLoading: false,
    isError: true,
    result: call.result ?? (status === 'interrupted' ? 'Interrupted' : 'Failed'),
  };
}

export interface RuntimeAgentWorkSnapshot extends SubagentLifecycle {
  /** Native DSH catalog identity; legacy work-only fields below are UI adapters. */
  native?: { mode: 'one-shot' | 'continuable'; activity: 'running' | 'inactive' };
  agentId: string;
  taskId: string;
  parentToolUseId: string;
  totalUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; costUsd: number | null };
  context?: { capacity?: number; projectedInputTokens?: number; providerInputTokens?: number };
}
export type RuntimeAgentWorkControl =
  | { kind: 'resume'; agentId: string; clientRequestId: string; expectedHandleRevision: number }
  | { kind: 'stop'; agentId: string; expectedHandleRevision: number }
  | { kind: 'message'; agentId: string; clientMessageId: string; message: string };

/** Effective facts are separate from global desired settings and contain no credentials. */
export interface RuntimeAgentWorkTree {
  items: readonly RuntimeAgentWorkSnapshot[];
  taskLists?: readonly {
    agentId: string;
    list: 'personal' | 'shared';
    tasks: readonly { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; owner?: string; offerTo?: readonly string[]; blockedBy?: readonly string[] }[];
  }[];
  configuration: {
    revision: string; maxDepth: number; maxActiveChildren: number; maxRetainedChildren: number;
    messageDelivery: 'realtime' | 'turn'; modelPolicy: 'inherit' | 'fixed' | 'agent';
    desiredState: 'effective' | 'pending' | 'invalid';
  };
}
