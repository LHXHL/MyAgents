export type McpConnectionStatus =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'pending'
  | 'disabled';

export type McpServerStatusSnapshot = {
  name: string;
  status: McpConnectionStatus;
  error?: string;
};

export type McpReadinessServerDetail = {
  id: string;
  status?: McpConnectionStatus;
  error?: string;
};

export type McpReadinessFailure = {
  code:
    | 'mcp_timeout'
    | 'mcp_failed'
    | 'mcp_auth_required'
    | 'mcp_disabled'
    | 'mcp_missing'
    | 'query_replaced';
  servers: McpReadinessServerDetail[];
};

export type McpReadinessClassification =
  | { state: 'ready' }
  | { state: 'pending'; servers: McpReadinessServerDetail[] }
  | { state: 'failure'; failure: McpReadinessFailure };

/**
 * Classify only the MCP ids that the current Query was actually created with.
 * SDK status entries for project/user MCPs outside that map are deliberately
 * ignored: they are not part of this Query owner's dispatch contract.
 */
export function classifyRequiredMcpStatuses(
  requiredServerIds: readonly string[],
  statuses: readonly McpServerStatusSnapshot[],
): McpReadinessClassification {
  if (requiredServerIds.length === 0) return { state: 'ready' };

  const byName = new Map(statuses.map(status => [status.name, status]));
  const unresolved = requiredServerIds.flatMap<McpReadinessServerDetail>((id) => {
    const status = byName.get(id);
    if (status?.status === 'connected') return [];
    return [{
      id,
      ...(status ? { status: status.status } : {}),
      ...(status?.error ? { error: status.error } : {}),
    }];
  });
  if (unresolved.length === 0) return { state: 'ready' };

  const terminalCode = unresolved.some(server => server.status === 'needs-auth')
    ? 'mcp_auth_required' as const
    : unresolved.some(server => server.status === 'failed')
      ? 'mcp_failed' as const
      : unresolved.some(server => server.status === 'disabled')
        ? 'mcp_disabled' as const
        : unresolved.some(server => server.status === undefined)
          ? 'mcp_missing' as const
          : null;

  if (terminalCode) {
    return {
      state: 'failure',
      failure: { code: terminalCode, servers: unresolved },
    };
  }
  return { state: 'pending', servers: unresolved };
}

export type McpReadinessOwner = {
  /** Object identity of the concrete, persistent Query control handle. */
  identity: object;
  /** Monotonic lifecycle generation assigned when the Query identity changes. */
  generation: number;
  /** Monotonic installed-map revision, including same-id and ABA replacements. */
  revision: number;
  /** Sorted id fingerprint of the MCP map last installed on this Query. */
  fingerprint: string;
  requiredServerIds: readonly string[];
  readStatuses(): Promise<readonly McpServerStatusSnapshot[]>;
};

export type McpReadinessLease = Pick<
  McpReadinessOwner,
  'identity' | 'generation' | 'revision' | 'fingerprint' | 'requiredServerIds'
>;

export type McpReadinessResult =
  | { ready: true; lease: McpReadinessLease }
  | { ready: false; failure: McpReadinessFailure };

function sameOwner(
  left: McpReadinessLease | null,
  right: McpReadinessLease,
): boolean {
  return left !== null
    && left.identity === right.identity
    && left.generation === right.generation
    && left.revision === right.revision
    && left.fingerprint === right.fingerprint;
}

export function isMcpReadinessLeaseCurrent(
  lease: McpReadinessLease,
  owner: McpReadinessOwner | null,
): boolean {
  return sameOwner(owner, lease);
}

function createLease(owner: McpReadinessOwner): McpReadinessLease {
  return {
    identity: owner.identity,
    generation: owner.generation,
    revision: owner.revision,
    fingerprint: owner.fingerprint,
    requiredServerIds: [...owner.requiredServerIds],
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type StatusReadResult =
  | { kind: 'statuses'; statuses: readonly McpServerStatusSnapshot[] }
  | { kind: 'error'; error: unknown }
  | { kind: 'cancelled' }
  | { kind: 'timeout' };

function readStatusesUntil(
  owner: McpReadinessOwner,
  deadlineAt: number,
  now: () => number,
  signal?: AbortSignal,
): Promise<StatusReadResult> {
  if (signal?.aborted) return Promise.resolve({ kind: 'cancelled' });
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) return Promise.resolve({ kind: 'timeout' });
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: StatusReadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => settle({ kind: 'cancelled' });
    const timer = setTimeout(() => {
      settle({ kind: 'timeout' });
    }, remainingMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => owner.readStatuses())
      .then(
        statuses => settle({ kind: 'statuses', statuses }),
        error => settle({ kind: 'error', error }),
      );
  });
}

async function sleepWithSignal(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) throw new Error('MCP readiness wait cancelled');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error('MCP readiness wait cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms).then(() => finish(), error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

/**
 * Wait for the MCP set owned by one live Query to become dispatchable.
 *
 * Every status read is validated against Query identity + generation + MCP
 * fingerprint after the async control response returns. A response from an
 * old Query can therefore never release a turn owned by its replacement.
 */
export async function awaitRequiredMcpReadiness(params: {
  deadlineAt: number;
  getOwner(): McpReadinessOwner | null;
  ensureOwner(): void;
  maxWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<McpReadinessResult> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadlineAt = Math.min(params.deadlineAt, now() + (params.maxWaitMs ?? 30_000));
  const pollMs = Math.max(200, Math.min(500, params.pollMs ?? 250));
  let sawReplacement = false;
  let observedOwner: McpReadinessOwner | null = null;
  let lastRequiredServerIds: readonly string[] = [];
  let lastPendingServers: McpReadinessServerDetail[] = [];

  while (now() < deadlineAt) {
    if (params.signal?.aborted) throw new Error('MCP readiness wait cancelled');
    const owner = params.getOwner();
    if (!owner) {
      if (observedOwner) {
        sawReplacement = true;
        observedOwner = null;
        lastPendingServers = [];
      }
      params.ensureOwner();
      await sleepWithSignal(sleep, Math.min(pollMs, Math.max(0, deadlineAt - now())), params.signal);
      continue;
    }

    if (observedOwner && !sameOwner(owner, observedOwner)) {
      sawReplacement = true;
      lastPendingServers = [];
    }
    observedOwner = owner;

    lastRequiredServerIds = owner.requiredServerIds;
    if (owner.requiredServerIds.length === 0) {
      return { ready: true, lease: createLease(owner) };
    }

    const read = await readStatusesUntil(owner, deadlineAt, now, params.signal);
    if (read.kind === 'cancelled') throw new Error('MCP readiness wait cancelled');
    const currentOwner = params.getOwner();
    if (!sameOwner(currentOwner, owner)) {
      sawReplacement = true;
      observedOwner = currentOwner;
      lastPendingServers = [];
      continue;
    }
    if (read.kind === 'timeout') {
      return {
        ready: false,
        failure: {
          code: 'mcp_timeout',
          servers: lastPendingServers.length > 0
            ? lastPendingServers
            : owner.requiredServerIds.map(id => ({ id })),
        },
      };
    }
    if (read.kind === 'error') {
      return {
        ready: false,
        failure: {
          code: 'mcp_failed',
          servers: owner.requiredServerIds.map(id => ({ id, error: errorText(read.error) })),
        },
      };
    }

    const classification = classifyRequiredMcpStatuses(owner.requiredServerIds, read.statuses);
    if (classification.state === 'ready') {
      return { ready: true, lease: createLease(owner) };
    }
    if (classification.state === 'failure') {
      return { ready: false, failure: classification.failure };
    }
    lastPendingServers = classification.servers;
    await sleepWithSignal(sleep, Math.min(pollMs, Math.max(0, deadlineAt - now())), params.signal);
  }

  const finalRequiredServerIds = lastRequiredServerIds.length > 0
    ? lastRequiredServerIds
    : params.getOwner()?.requiredServerIds ?? [];
  if (sawReplacement && lastPendingServers.length === 0) {
    return {
      ready: false,
      failure: {
        code: 'query_replaced',
        servers: finalRequiredServerIds.map(id => ({ id })),
      },
    };
  }
  return {
    ready: false,
    failure: {
      code: 'mcp_timeout',
      servers: lastPendingServers.length > 0
        ? lastPendingServers
        : finalRequiredServerIds.map(id => ({ id })),
    },
  };
}

export function formatMcpReadinessFailure(failure: McpReadinessFailure): string {
  const serverText = failure.servers.length > 0
    ? failure.servers.map(server => {
      const status = server.status ? ` (${server.status})` : '';
      const error = server.error ? `: ${server.error}` : '';
      return `${server.id}${status}${error}`;
    }).join(', ')
    : 'unknown MCP server';
  switch (failure.code) {
    case 'mcp_timeout':
      return `MCP readiness timed out: ${serverText}`;
    case 'mcp_failed':
      return `MCP startup failed: ${serverText}`;
    case 'mcp_auth_required':
      return `MCP authentication required: ${serverText}`;
    case 'mcp_disabled':
      return `Required MCP server is disabled: ${serverText}`;
    case 'mcp_missing':
      return `Required MCP server is missing from SDK status: ${serverText}`;
    case 'query_replaced':
      return `MCP readiness owner changed before dispatch: ${serverText}`;
  }
}
