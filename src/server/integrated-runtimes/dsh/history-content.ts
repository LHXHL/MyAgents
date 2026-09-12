import { createHash } from 'node:crypto';

import type { SubagentLifecycle } from '../../../shared/types/subagent-lifecycle';
import type { DshNativeHistory } from './mutations';
import { readDshUsage } from './telemetry';

type RecordValue = Readonly<Record<string, unknown>>;
function record(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DSH history content must be an object');
  }
  return value as RecordValue;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('DSH history identity is absent');
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('DSH history ordinal is invalid');
  return Number(value);
}

export function providerIdentity(value: string, prefix: string): string {
  return isProtocolIdentifier(value)
    ? value : `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

export function isProtocolIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

/** Classify only explicit Provider failure evidence; opaque result text remains readable. */
export function providerContentFailed(content: unknown): boolean {
  let visited = 0;
  const failed = (value: unknown, depth: number): boolean => {
    if (++visited > 2_000 || depth > 8) return false;
    if (typeof value === 'string') {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { return false; }
      return parsed !== null && typeof parsed === 'object' && failed(parsed, depth + 1);
    }
    if (Array.isArray(value)) return value.some(item => failed(item, depth + 1));
    if (value === null || typeof value !== 'object') return false;
    const row = value as RecordValue;
    if (row.is_error === true || (typeof row.type === 'string' && (row.type === 'error' || row.type.endsWith('_error')))
      || (row.error !== undefined && row.error !== null && row.error !== false)) return true;
    const status = row.status_code ?? row.statusCode ?? row.status;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) return true;
    return ['content', 'result', 'results'].some(key => row[key] !== undefined && failed(row[key], depth + 1));
  };
  return failed(content, 0);
}

/** Rebuild disposable child UI state solely from the verified root's ProductWork facts. */
export function projectWorkHistory(history: DshNativeHistory, callId: string): SubagentLifecycle | undefined {
  const creations = history.events.filter(event => event.eventType === 'myagents/work/created'
    && record(record(event.data).authority).callId === callId
    && (record(record(event.data).birth).parentSessionId === undefined || record(record(event.data).birth).parentSessionId === history.runtimeSessionId));
  if (creations.length === 0) return undefined;
  if (creations.length !== 1) throw new Error('DSH Agent call has multiple ProductWork owners');
  const creation = creations[0];
  if (!creation) return undefined;
  const created = record(creation.data);
  const authority = record(created.authority);
  const birth = record(created.birth);
  const taskId = identifier(created.taskId);
  const agentId = identifier(created.agentId);
  const accepted = history.events.find(event => event.eventType === 'myagents/operation/accepted'
    && record(event.data).clientOperationId === authority.clientOperationId);
  if (!accepted) throw new Error('DSH ProductWork lacks its accepted operation');
  const startedAt = integer(record(accepted.data).acceptedAt);
  let startSeq = integer(created.initialChildEventSeq ?? 0);
  let ordinal = 1;
  let completedOrdinal = 0;
  let state: NonNullable<SubagentLifecycle['activation']>['state'] = created.admission === 'reserved' && created.initialMessageId === undefined ? 'queued' : 'running';
  let handleRevision = creation.sequence;
  let handleState: SubagentLifecycle['handleState'] = 'open';
  let result: string | undefined;
  let resultTruncated: boolean | undefined;
  let usage: SubagentLifecycle['usage'];
  for (const event of history.events) {
    if (!event.eventType.startsWith('myagents/work/')) continue;
    const row = record(event.data);
    if (row.taskId !== taskId) continue;
    if (row.agentId !== agentId || row.sessionId !== history.runtimeSessionId || row.eventSeq !== event.sequence) {
      throw new Error('DSH ProductWork history changed its durable owner');
    }
    if (event.eventType === 'myagents/work/started') {
      startSeq = integer(row.initialChildEventSeq);
      if (completedOrdinal === 0) state = 'running';
    } else if (event.eventType === 'myagents/work/phase') {
      const next = integer(row.ordinal);
      const phases = ['queued', 'running', 'waiting_interaction', 'waiting_child', 'waiting_delivery'] as const;
      if (next !== completedOrdinal + 1 || handleState !== 'open' || !phases.includes(row.phase as typeof phases[number])) throw new Error('DSH child phase is out of order');
      if (next > ordinal) { result = undefined; resultTruncated = undefined; usage = undefined; }
      ordinal = next; state = row.phase as typeof phases[number];
    } else if (event.eventType === 'myagents/work/activated') {
      ordinal = integer(row.ordinal);
      if (ordinal !== completedOrdinal + 1 || handleState !== 'open') throw new Error('DSH child activation is out of order');
      startSeq = integer(row.childStartSeq);
      state = 'running';
      result = undefined;
      resultTruncated = undefined;
      usage = undefined;
    } else if (event.eventType === 'myagents/work/epoch') {
      const next = integer(row.ordinal);
      if (next !== completedOrdinal + 1) throw new Error('DSH child epoch is out of order');
      completedOrdinal = next;
      ordinal = next;
      startSeq = integer(row.childStartSeq);
      state = row.stopReason === 'completed' ? 'completed' : row.stopReason === 'aborted' ? 'aborted' : 'failed';
      result = typeof row.result === 'string' ? row.result : undefined;
      resultTruncated = typeof row.resultTruncated === 'boolean' ? row.resultTruncated : undefined;
      const value = readDshUsage(row.usage);
      usage = value === undefined ? undefined : {
        inputTokens: value.inputTokens, outputTokens: value.outputTokens,
        ...(value.cacheReadTokens === undefined ? {} : { cacheReadTokens: value.cacheReadTokens }),
        ...(value.cacheWriteTokens === undefined ? {} : { cacheCreationTokens: value.cacheWriteTokens }),
      };
    } else if (event.eventType === 'myagents/work/stopping') {
      handleState = 'stopping'; handleRevision = event.sequence;
    } else if (event.eventType === 'myagents/work/settled') {
      handleState = 'closed'; handleRevision = event.sequence;
      if (state !== 'completed' && state !== 'failed' && state !== 'aborted') state = row.terminal === 'succeeded' ? 'completed' : row.terminal === 'aborted' ? 'aborted' : 'failed';
      if (result === undefined && typeof row.result === 'string') result = row.result;
    } else if (event.eventType === 'myagents/work/reopened') {
      if (handleState !== 'closed' || row.previousSettlementSeq !== handleRevision) throw new Error('DSH child reopen has no exact closed owner');
      handleState = 'open'; handleRevision = event.sequence;
    }
  }
  const hash = createHash('sha256');
  for (const part of created.admission === 'reserved'
    ? ['myagents-work-activation-v2', agentId, String(ordinal)]
    : ['myagents-work-activation-v1', agentId, String(startSeq)]) hash.update(part).update('\0');
  return {
    activation: { id: hash.digest('hex'), ordinal, state },
    handleState, handleRevision, agentId, taskId,
    ...(birth.parentSessionId === undefined ? {} : { tree: { rootAgentId: history.runtimeSessionId, parentAgentId: identifier(birth.parentSessionId), depth: integer(birth.depth) } }),
    ...(birth.provider === undefined || birth.modelProfileRevision === undefined ? {} : { modelRoute: {
      provider: identifier(birth.provider), profileRevision: identifier(birth.selectedModelProfileRevision ?? birth.modelProfileRevision),
      selection: birth.modelSelection === 'fixed' ? 'fixed' as const : birth.modelSelection === 'agent' ? 'agent' as const : 'inherit' as const,
    } }),
    status: state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : state === 'aborted' ? 'interrupted' : 'running',
    // session/read preserves data, not envelope timestamps. Retain the known
    // operation anchor and omit duration claims until a live snapshot supplies timing.
    startedAt, timingVerified: false,
    agentType: identifier(birth.type), description: identifier(created.description),
    mode: created.mode === 'foreground' ? 'foreground' : 'continuable', model: identifier(created.model),
    ...(result === undefined ? {} : { result }),
    ...(resultTruncated === undefined ? {} : { resultTruncated }),
    ...(usage === undefined ? {} : { usage }),
  };
}
