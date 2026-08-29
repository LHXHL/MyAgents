import { createHash } from 'node:crypto';

import type { UnifiedEvent, UnifiedEventCallback } from '../../runtimes/types';
import type { DshRpcObject } from './protocol-types';

type DshRuntimeEventEnvelope = Readonly<{
  runtimeGeneration: string;
  productSessionId: string;
  runtimeSessionId: string;
  sequence: number;
  emittedAt: string;
  event: DshRpcObject;
  turnId?: string;
  itemId?: string;
  toolCallId?: string;
  parentItemId?: string;
}>;

export type DshProjectedTurnTerminal = Readonly<{
  clientOperationId: string;
  turnId?: string;
  terminal: DshRpcObject;
}>;

export type DshRuntimeEventProjectorOptions = Readonly<{
  productSessionId: string;
  runtimeGeneration: string;
  onEvent: UnifiedEventCallback;
  onTurnTerminal?: (terminal: DshProjectedTurnTerminal) => void;
  clientUserMessageIdForOperation?: (clientOperationId: string) => string | undefined;
}>;

function object(value: unknown, description: string): DshRpcObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as DshRpcObject;
}

function string(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('DSH event contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = object(value, 'DSH event value');
  return `{${Object.keys(row)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(',')}}`;
}

function eventDigest(envelope: DshRuntimeEventEnvelope): string {
  return createHash('sha256').update(canonicalJson(envelope)).digest('hex');
}

function parseEnvelope(value: DshRpcObject): DshRuntimeEventEnvelope {
  const event = object(value.event, 'DSH Runtime event');
  const sequence = value.sequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    throw new Error('DSH Runtime event sequence is invalid');
  }
  const emittedAt = string(value.emittedAt, 'DSH Runtime event emittedAt');
  if (!Number.isFinite(Date.parse(emittedAt))) {
    throw new Error('DSH Runtime event emittedAt is invalid');
  }
  return {
    runtimeGeneration: string(value.runtimeGeneration, 'DSH Runtime generation'),
    productSessionId: string(value.productSessionId, 'DSH Product Session id'),
    runtimeSessionId: string(value.runtimeSessionId, 'DSH Runtime Session id'),
    sequence: sequence as number,
    emittedAt,
    event,
    ...(optionalString(value.turnId) ? { turnId: value.turnId as string } : {}),
    ...(optionalString(value.itemId) ? { itemId: value.itemId as string } : {}),
    ...(optionalString(value.toolCallId) ? { toolCallId: value.toolCallId as string } : {}),
    ...(optionalString(value.parentItemId) ? { parentItemId: value.parentItemId as string } : {}),
  };
}

function terminalStatus(terminal: DshRpcObject): Pick<Extract<UnifiedEvent, { kind: 'turn_complete' }>, 'status' | 'error'> {
  const kind = string(terminal.kind, 'DSH turn terminal kind');
  if (kind === 'succeeded') return { status: 'success' };
  if (kind === 'aborted') return { status: 'stopped' };
  return {
    status: kind,
    error: optionalString(terminal.message) ?? optionalString(terminal.code) ?? kind,
  };
}

function usageEvent(value: unknown, semantics: unknown, contextOccupiedTokens: unknown, runtimeContextWindow: unknown): Extract<UnifiedEvent, { kind: 'usage' }> {
  const usage = object(value, 'DSH token usage');
  const context = contextOccupiedTokens === null
    ? undefined
    : finiteNumber(contextOccupiedTokens);
  const window = finiteNumber(runtimeContextWindow);
  return {
    kind: 'usage',
    inputTokens: finiteNumber(usage.inputTokens),
    outputTokens: finiteNumber(usage.outputTokens),
    cacheReadTokens: finiteNumber(usage.cacheReadTokens),
    cacheCreationTokens: finiteNumber(usage.cacheWriteTokens),
    ...(typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)
      ? { costUsd: usage.costUsd }
      : {}),
    ...(semantics === 'running_total' ? { semantics: 'running_total' as const } : { semantics: 'delta' as const }),
    ...(context === undefined ? {} : { contextOccupiedTokens: context }),
    ...(window > 0 ? { runtimeContextWindow: window } : {}),
  };
}

function planTodos(detail: DshRpcObject): Extract<UnifiedEvent, { kind: 'agent_plan_update' }>['todos'] | undefined {
  const candidate = Array.isArray(detail.todos)
    ? detail.todos
    : Array.isArray(detail.tasks)
      ? detail.tasks
      : undefined;
  if (!candidate) return undefined;
  const todos = candidate.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as DshRpcObject;
    const content = optionalString(row.content) ?? optionalString(row.title);
    if (!content) return [];
    const rawStatus = optionalString(row.status);
    const status: 'completed' | 'in_progress' | 'pending' = rawStatus === 'completed' || rawStatus === 'in_progress'
      ? rawStatus
      : 'pending';
    return [{
      key: optionalString(row.id) ?? optionalString(row.key) ?? `dsh-plan-${index}`,
      content,
      activeForm: optionalString(row.activeForm) ?? content,
      status,
    }];
  });
  return todos;
}

/**
 * Serial, generation-fenced projection of the Runtime's durable event stream.
 * The inbox accepts exact replay of an already observed sequence, but a
 * conflicting duplicate or any sequence gap is a fatal projection error.
 */
export class DshRuntimeEventProjector {
  private runtimeSessionIdValue: string | undefined;
  private nextSequence = 1;
  private readonly observedDigests = new Map<number, string>();
  private inbox: Promise<void> = Promise.resolve();
  private failureValue: Error | undefined;

  constructor(private readonly options: DshRuntimeEventProjectorOptions) {}

  get runtimeSessionId(): string | undefined {
    return this.runtimeSessionIdValue;
  }

  get failure(): Error | undefined {
    return this.failureValue;
  }

  accept(params: DshRpcObject): Promise<void> {
    const accepted = this.inbox.then(() => this.project(params));
    this.inbox = accepted.catch(error => {
      this.failureValue = error instanceof Error ? error : new Error('DSH event projection failed');
    });
    return accepted;
  }

  whenIdle(): Promise<void> {
    return this.inbox.then(() => {
      if (this.failureValue) throw this.failureValue;
    });
  }

  private project(params: DshRpcObject): void {
    if (this.failureValue) throw this.failureValue;
    const envelope = parseEnvelope(params);
    if (
      envelope.productSessionId !== this.options.productSessionId
      || envelope.runtimeGeneration !== this.options.runtimeGeneration
    ) {
      throw new Error('DSH Runtime event escaped its active generation authority');
    }
    if (this.runtimeSessionIdValue && envelope.runtimeSessionId !== this.runtimeSessionIdValue) {
      throw new Error('DSH Runtime event changed primary Runtime Session identity');
    }
    this.runtimeSessionIdValue ??= envelope.runtimeSessionId;

    const digest = eventDigest(envelope);
    if (envelope.sequence < this.nextSequence) {
      if (this.observedDigests.get(envelope.sequence) === digest) return;
      throw new Error('DSH Runtime emitted a conflicting duplicate event sequence');
    }
    if (envelope.sequence !== this.nextSequence) {
      throw new Error(`DSH Runtime event sequence gap: expected ${this.nextSequence}, received ${envelope.sequence}`);
    }
    this.observedDigests.set(envelope.sequence, digest);
    if (this.observedDigests.size > 4_096) {
      this.observedDigests.delete(envelope.sequence - 4_096);
    }
    this.nextSequence += 1;
    this.emit(envelope);
  }

  private emit(envelope: DshRuntimeEventEnvelope): void {
    const event = envelope.event;
    const kind = string(event.kind, 'DSH Runtime event kind');
    switch (kind) {
      case 'turn_admitted': {
        const admission = object(event.admission, 'DSH turn admission');
        const clientOperationId = string(admission.clientOperationId, 'DSH client operation id');
        const clientUserMessageId = this.options.clientUserMessageIdForOperation?.(clientOperationId);
        if (clientUserMessageId) {
          this.options.onEvent({
            kind: 'root_turn_admitted',
            runtimeTurnId: string(admission.turnId, 'DSH turn id'),
            clientUserMessageId,
          });
        }
        return;
      }
      case 'turn_started':
        this.options.onEvent({ kind: 'turn_started' });
        this.options.onEvent({ kind: 'status_change', state: 'running' });
        return;
      case 'assistant_delta':
        this.options.onEvent({ kind: 'text_delta', text: string(event.delta, 'DSH assistant delta') });
        return;
      case 'thinking_delta':
        this.options.onEvent({ kind: 'thinking_delta', text: string(event.delta, 'DSH thinking delta'), index: 0 });
        return;
      case 'tool': {
        const phase = string(event.phase, 'DSH tool phase');
        const toolUseId = envelope.toolCallId ?? envelope.itemId;
        if (!toolUseId) throw new Error('DSH tool event lacks a stable tool identity');
        const detail = event.detail === undefined ? {} : object(event.detail, 'DSH tool detail');
        if (phase === 'start') {
          this.options.onEvent({ kind: 'tool_use_start', toolUseId, toolName: string(event.name, 'DSH tool name'), input: detail });
          this.options.onEvent({ kind: 'tool_use_stop', toolUseId, input: detail });
          return;
        }
        if (phase === 'end') {
          const content = typeof detail.content === 'string'
            ? detail.content
            : detail.content === undefined
              ? ''
              : canonicalJson(detail.content);
          this.options.onEvent({
            kind: 'tool_result',
            toolUseId,
            content,
            isError: detail.isError === true || detail.state === 'failed',
          });
        }
        return;
      }
      case 'usage':
        this.options.onEvent(usageEvent(event.usage, event.semantics, event.contextOccupiedTokens, event.runtimeContextWindow));
        return;
      case 'context': {
        const occupied = event.contextOccupiedTokens;
        if (occupied !== null) {
          this.options.onEvent({
            kind: 'usage',
            inputTokens: 0,
            outputTokens: 0,
            semantics: 'delta',
            contextOccupiedTokens: finiteNumber(occupied),
            runtimeContextWindow: finiteNumber(event.runtimeContextWindow),
          });
        }
        return;
      }
      case 'queued_message':
        if (event.state === 'delivered') {
          this.options.onEvent({ kind: 'user_message_accepted' });
        }
        return;
      case 'plan':
      case 'task_graph': {
        const todos = planTodos(object(event.detail, 'DSH plan detail'));
        if (todos) this.options.onEvent({ kind: 'agent_plan_update', todos });
        return;
      }
      case 'compaction':
        this.options.onEvent({ kind: 'log', level: event.phase === 'failed' ? 'error' : 'info', message: `DSH compaction ${String(event.phase)}` });
        return;
      case 'warning':
        this.options.onEvent({ kind: 'log', level: 'warn', message: `${string(event.code, 'DSH warning code')}: ${string(event.message, 'DSH warning message')}` });
        return;
      case 'session':
        if (event.phase === 'ready') this.options.onEvent({ kind: 'status_change', state: 'idle' });
        return;
      case 'turn_terminal': {
        const clientOperationId = string(event.clientOperationId, 'DSH terminal operation id');
        const terminal = object(event.terminal, 'DSH turn terminal');
        if (terminal.usage) {
          const summary = object(terminal.usage, 'DSH terminal usage');
          this.options.onEvent(usageEvent(summary, 'delta', summary.contextOccupiedTokens, summary.runtimeContextWindow));
        }
        this.options.onTurnTerminal?.({ clientOperationId, turnId: envelope.turnId, terminal });
        this.options.onEvent({ kind: 'turn_complete', ...terminalStatus(terminal) });
        return;
      }
      case 'message_event':
      case 'interaction':
      case 'work':
      case 'component':
      case 'catalog':
      case 'checkpoint':
      case 'retry':
        return;
      default:
        this.options.onEvent({ kind: 'raw', data: structuredClone(envelope) });
    }
  }
}
