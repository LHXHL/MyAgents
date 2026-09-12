import type { RuntimeAgentWorkSnapshot } from '../../../shared/types/subagent-lifecycle';
import { createHash } from 'node:crypto';

import type { ToolAttachment } from '../../../shared/types/tool-attachment';
import type { SubagentLifecycle } from '../../../shared/types/subagent-lifecycle';
import type { UnifiedEvent } from '../../runtimes/types';
import type { DshRpcObject } from './protocol-types';
import { readDshUsage, readDshUsageTotals, telemetryRecord, tokenCount } from './telemetry';

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
  onEvent: (event: UnifiedEvent, turnId?: string) => void;
  onTurnTerminal?: (terminal: DshProjectedTurnTerminal) => void;
  onCollaborationAdmitted?: (clientOperationId: string, turnId: string) => void;
  clientUserMessageIdForOperation?: (clientOperationId: string) => string | undefined;
  clientUserMessageIdForInjection?: (messageId: string) => string | undefined;
  onPlan?: (snapshot: { mode: 'normal' | 'plan'; revision: string }) => void;
  resolveToolImage?: (
    image: DshRpcObject,
    context: { runtimeSessionId: string; turnId?: string; toolUseId: string; toolName: string },
  ) => Promise<ToolAttachment>;
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

function usageEvent(value: unknown, semantics: unknown, contextOccupiedTokens: unknown, runtimeContextWindow: unknown): Extract<UnifiedEvent, { kind: 'usage' }> | undefined {
  const usage = readDshUsage(value);
  if (!usage) return undefined;
  const context = tokenCount(contextOccupiedTokens);
  const window = tokenCount(runtimeContextWindow);
  return {
    kind: 'usage',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheCreationTokens: usage.cacheWriteTokens }),
    ...(typeof usage.costUsd === 'number'
      ? { costUsd: usage.costUsd }
      : {}),
    ...(semantics === 'running_total' ? { semantics: 'running_total' as const } : { semantics: 'delta' as const }),
    ...(context === undefined ? {} : { contextOccupiedTokens: context }),
    ...(window !== undefined && window > 0 ? { runtimeContextWindow: window } : {}),
  };
}

function taskGraphTodos(snapshot: DshRpcObject): Extract<UnifiedEvent, { kind: 'agent_plan_update' }>['todos'] {
  if (!Array.isArray(snapshot.tasks)) throw new Error('DSH TaskGraph snapshot tasks must be an array');
  return snapshot.tasks.flatMap((entry) => {
    const task = object(entry, 'DSH TaskGraph task');
    if (task.status === 'cancelled') return [];
    const content = string(task.subject, 'DSH TaskGraph task subject');
    const status = task.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      throw new Error('DSH TaskGraph task status is invalid');
    }
    return [{
      key: string(task.id, 'DSH TaskGraph task id'),
      content,
      activeForm: optionalString(task.activeForm) ?? content,
      status,
    }];
  });
}

function optionalFiniteNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toolMetadata(value: unknown): Extract<UnifiedEvent, { kind: 'tool_result' }>['metadata'] {
  const metadata = telemetryRecord(value);
  if (!metadata) return undefined;
  const exitCode = optionalFiniteNumber(metadata.exitCode);
  const durationMs = optionalFiniteNumber(metadata.durationMs);
  const processId = metadata.processId === null ? null : optionalString(metadata.processId);
  const projected = {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(optionalString(metadata.cwd) ? { cwd: metadata.cwd as string } : {}),
    ...(processId === undefined ? {} : { processId }),
    ...(optionalString(metadata.status) ? { status: metadata.status as string } : {}),
  };
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function workStatus(state: unknown): Extract<UnifiedEvent, { kind: 'subagent_lifecycle' }>['status'] {
  if (state === 'running' || state === 'stopping') return 'running';
  if (state === 'succeeded') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'aborted') return 'interrupted';
  throw new Error('DSH ProductWork state is invalid');
}

function timestamp(value: unknown, description: string): number {
  const raw = string(value, description);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${description} is invalid`);
  return parsed;
}

function nonNegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Agent metric is invalid');
  return Number(value);
}

function workLifecycle(snapshot: DshRpcObject): Extract<UnifiedEvent, { kind: 'subagent_lifecycle' }> {
  const tree = snapshot.tree === undefined ? undefined : object(snapshot.tree, 'Agent tree');
  const route = snapshot.modelRoute === undefined ? undefined : object(snapshot.modelRoute, 'Agent model route');
  if (tree && (nonNegative(tree.depth) < 1 || Number(tree.depth) > 8)) throw new Error('Agent depth is invalid');
  if (route && !['inherit', 'fixed', 'agent'].includes(String(route.selection))) throw new Error('Agent model selection is invalid');
  let activation: SubagentLifecycle['activation'];
  if (snapshot.activation !== undefined) {
    const value = object(snapshot.activation, 'DSH ProductWork activation');
    const states = ['queued', 'running', 'waiting_interaction', 'waiting_child', 'waiting_delivery', 'completed', 'failed', 'aborted'];
    if (!states.includes(String(value.state)) || !Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 1) {
      throw new Error('DSH ProductWork activation is invalid');
    }
    activation = {
      id: string(value.id, 'DSH ProductWork activation identity'),
      ordinal: Number(value.ordinal),
      state: value.state as NonNullable<SubagentLifecycle['activation']>['state'],
    };
  }
  const handleState = snapshot.handleState;
  if (handleState !== undefined && handleState !== 'open' && handleState !== 'stopping' && handleState !== 'closed') {
    throw new Error('DSH ProductWork handle state is invalid');
  }
  const state = activation === undefined ? workStatus(snapshot.state)
    : activation.state === 'completed' ? 'completed'
      : activation.state === 'failed' ? 'failed'
        : activation.state === 'aborted' ? 'interrupted' : 'running';
  const startedAt = timestamp(snapshot.startedAt, 'DSH ProductWork start time');
  const finishedAt = snapshot.finishedAt === undefined
    ? undefined
    : timestamp(snapshot.finishedAt, 'DSH ProductWork finish time');
  const usage = readDshUsage(snapshot.usage);
  return {
    kind: 'subagent_lifecycle',
    agentId: string(snapshot.agentId, 'Agent ID'), taskId: string(snapshot.taskId, 'Agent task ID'),
    ...(snapshot.handleRevision === undefined ? {} : { handleRevision: nonNegative(snapshot.handleRevision) }),
    ...(snapshot.lastActivityAt === undefined ? {} : { lastActivityAt: timestamp(snapshot.lastActivityAt, 'Agent activity time') }),
    ...(tree ? { tree: { rootAgentId: string(tree.rootAgentId, 'Root ID'), parentAgentId: string(tree.parentAgentId, 'Parent ID'), depth: Number(tree.depth) } } : {}),
    ...(route ? { modelRoute: { provider: string(route.provider, 'Agent Provider'), profileRevision: string(route.profileRevision, 'Agent profile'), selection: route.selection as 'inherit' | 'fixed' | 'agent' } } : {}),
    ...(activation === undefined ? {} : { activation }),
    ...(handleState === undefined ? {} : { handleState }),
    startedAt,
    parentToolUseId: string(snapshot.parentToolCallId, 'DSH ProductWork parent tool call'),
    status: state,
    observedAt: state === 'running' ? startedAt : finishedAt ?? startedAt,
    agentType: string(snapshot.agentType, 'DSH ProductWork agent type'),
    description: string(snapshot.description, 'DSH ProductWork description'),
    mode: snapshot.mode === 'foreground' ? 'foreground' : 'continuable',
    model: string(snapshot.model, 'DSH ProductWork model'),
    ...(optionalString(snapshot.result) ? { result: snapshot.result as string } : {}),
    ...(typeof snapshot.resultTruncated === 'boolean' ? { resultTruncated: snapshot.resultTruncated } : {}),
    ...(usage ? {
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
        ...(usage.cacheWriteTokens === undefined ? {} : { cacheCreationTokens: usage.cacheWriteTokens }),
        ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
      },
    } : {}),
    affectsRootActivity: false,
  };
}

export function projectDshAgentWorkSnapshot(snapshot: DshRpcObject): RuntimeAgentWorkSnapshot {
  const lifecycle = workLifecycle(snapshot);
  const usage = readDshUsageTotals(snapshot.totalUsage);
  const pressure = telemetryRecord(snapshot.context);
  const capacity = tokenCount(pressure?.capacity);
  const projectedInputTokens = tokenCount(pressure?.projectedInputTokens);
  const providerInputTokens = tokenCount(pressure?.providerInputTokens);
  const context = {
    ...(capacity === undefined ? {} : { capacity }),
    ...(projectedInputTokens === undefined ? {} : { projectedInputTokens }),
    ...(providerInputTokens === undefined ? {} : { providerInputTokens }),
  };
  return {
    ...lifecycle,
    startedAt: lifecycle.startedAt ?? lifecycle.observedAt,
    ...(snapshot.finishedAt === undefined ? {} : { finishedAt: timestamp(snapshot.finishedAt, 'Agent completion time') }),
    agentId: string(snapshot.agentId, 'Agent ID'), taskId: string(snapshot.taskId, 'Agent task ID'),
    ...(usage ? { totalUsage: usage } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
}

/**
 * Serial, generation-fenced projection of the Runtime's durable event stream.
 * The inbox accepts exact replay of an already observed sequence, but a
 * conflicting duplicate or any sequence gap is a fatal projection error.
 */
export class DshRuntimeEventProjector {
  private runtimeSessionIdValue: string | undefined;
  private nextSequence = 1;
  // Correlation only: final content belongs to native history reconciliation.
  private assistantStream: { id: string; turnId: string; lastFrameIndex: number } | undefined;
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

  private async project(params: DshRpcObject): Promise<void> {
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
    await this.emit(envelope);
  }

  private requireAssistantStream(id: string, turnId: string) {
    const active = this.assistantStream;
    if (!active || active.id !== id || active.turnId !== turnId) {
      throw new Error('DSH assistant frame differs from its active stream or turn');
    }
    return active;
  }

  private async emit(envelope: DshRuntimeEventEnvelope): Promise<void> {
    const onEvent = (event: UnifiedEvent): void => this.options.onEvent(event,
      envelope.turnId ?? (event.kind === 'root_turn_admitted' ? event.runtimeTurnId : undefined));
    const event = envelope.event;
    const kind = string(event.kind, 'DSH Runtime event kind');
    switch (kind) {
      case 'turn_admitted': {
        const admission = object(event.admission, 'DSH turn admission');
        const clientOperationId = string(admission.clientOperationId, 'DSH client operation id');
        const clientUserMessageId = this.options.clientUserMessageIdForOperation?.(clientOperationId);
        if (admission.origin === 'collaboration') {
          if (clientUserMessageId !== undefined) throw new Error('DSH collaboration operation conflicts with a Product user');
          this.options.onCollaborationAdmitted?.(clientOperationId, string(admission.turnId, 'DSH collaboration turn id'));
          onEvent({ kind: 'root_turn_admitted', origin: 'collaboration', clientOperationId,
            runtimeTurnId: string(admission.turnId, 'DSH collaboration turn id') });
        } else if (clientUserMessageId) {
          onEvent({
            kind: 'root_turn_admitted',
            runtimeTurnId: string(admission.turnId, 'DSH turn id'),
            clientUserMessageId,
          });
        }
        return;
      }
      case 'turn_started':
        onEvent({ kind: 'turn_started' });
        onEvent({ kind: 'status_change', state: 'running' });
        return;
      case 'assistant_stream': {
        const id = string(event.streamId, 'DSH assistant stream id');
        const turnId = string(envelope.turnId, 'DSH assistant stream turn');
        if (event.phase === 'start') {
          if (this.assistantStream) throw new Error('DSH assistant streams overlap');
          this.assistantStream = { id, turnId, lastFrameIndex: -1 };
          return;
        }
        if (event.phase !== 'end') throw new Error('DSH assistant stream phase is invalid');
        const active = this.requireAssistantStream(id, turnId);
        const chunkCount = nonNegative(event.chunkCount);
        if (chunkCount <= active.lastFrameIndex) throw new Error('DSH assistant stream ended before its last frame');
        const outcome = object(event.outcome, 'DSH assistant stream outcome');
        if (outcome.kind === 'committed') {
          string(outcome.eventId, 'DSH committed assistant event');
          if (outcome.eventType !== 'assistant/message' && outcome.eventType !== 'assistant/attempt') {
            throw new Error('DSH assistant stream committed an invalid event type');
          }
          if (outcome.eventType === 'assistant/message') string(outcome.messageId, 'DSH committed assistant message');
        } else if (outcome.kind !== 'abandoned') {
          throw new Error('DSH assistant stream outcome is invalid');
        }
        this.assistantStream = undefined;
        return;
      }
      case 'assistant_delta':
      case 'thinking_delta': {
        const active = this.requireAssistantStream(
          string(event.streamId, 'DSH assistant delta stream'),
          string(envelope.turnId, 'DSH assistant delta turn'),
        );
        const frameIndex = nonNegative(event.frameIndex);
        // Non-text native chunks are omitted from the Product notification stream.
        if (frameIndex <= active.lastFrameIndex) throw new Error('DSH assistant delta position is not increasing');
        active.lastFrameIndex = frameIndex;
        const text = string(event.delta, 'DSH assistant delta');
        onEvent(kind === 'assistant_delta'
          ? { kind: 'text_delta', text }
          : { kind: 'thinking_delta', text, index: 0 });
        return;
      }
      case 'tool': {
        const phase = string(event.phase, 'DSH tool phase');
        const toolUseId = envelope.toolCallId ?? envelope.itemId;
        if (!toolUseId) throw new Error('DSH tool event lacks a stable tool identity');
        if (phase === 'start') {
          const input = event.input === undefined ? {} : object(event.input, 'DSH tool input');
          onEvent({ kind: 'tool_use_start', toolUseId, toolName: string(event.name, 'DSH tool name'), input });
          onEvent({ kind: 'tool_use_stop', toolUseId, input });
          return;
        }
        if (phase === 'end') {
          const result = object(event.result, 'DSH tool result');
          if (!Array.isArray(result.content)) throw new Error('DSH tool result content must be an array');
          const textBlocks: string[] = [];
          const attachments: ToolAttachment[] = [];
          for (const candidate of result.content) {
            const block = object(candidate, 'DSH tool result block');
            if (block.type === 'text') {
              textBlocks.push(typeof block.text === 'string' ? block.text : '');
              continue;
            }
            if (block.type === 'image_ref' && this.options.resolveToolImage) {
              try {
                attachments.push(await this.options.resolveToolImage(block, {
                  runtimeSessionId: envelope.runtimeSessionId,
                  turnId: envelope.turnId,
                  toolUseId,
                  toolName: string(event.name, 'DSH tool name'),
                }));
              } catch {
                textBlocks.push('[DSH image attachment unavailable]');
                onEvent({
                  kind: 'log',
                  level: 'warn',
                  message: `DSH tool image could not be registered for ${toolUseId}`,
                });
              }
              continue;
            }
            textBlocks.push(`[Unsupported DSH tool result block: ${String(block.type)}]`);
          }
          const metadata = toolMetadata(result.metadata);
          onEvent({
            kind: 'tool_result',
            toolUseId,
            content: textBlocks.join('\n'),
            ...(attachments.length > 0 ? { attachments } : {}),
            isError: result.isError === true || result.state === 'failed',
            ...(metadata ? { metadata } : {}),
          });
        }
        return;
      }
      case 'provider_tool': {
        const phase = string(event.phase, 'DSH Provider tool phase');
        const toolUseId = string(event.providerToolCallId, 'DSH Provider tool call id');
        const providerRouteId = string(event.providerRouteId, 'DSH Provider route id');
        const providerBlockType = string(event.providerBlockType, 'DSH Provider block type');
        const toolName = string(event.name, 'DSH Provider tool name');
        if (phase === 'start') {
          onEvent({
            kind: 'provider_tool_use_start',
            providerRouteId,
            providerBlockType,
            toolUseId,
            toolName,
            input: object(event.input, 'DSH Provider tool input'),
          });
          return;
        }
        if (phase === 'end') {
          const result = object(event.result, 'DSH Provider tool result');
          if (!Array.isArray(result.content)) {
            throw new Error('DSH Provider tool result content must be an array');
          }
          const content = result.content.map((candidate) => {
            const block = object(candidate, 'DSH Provider tool result block');
            if (block.type !== 'text' || typeof block.text !== 'string') {
              throw new Error('DSH Provider tool result supports bounded text blocks only');
            }
            return block.text;
          }).join('\n');
          onEvent({
            kind: 'provider_tool_result',
            providerRouteId,
            providerBlockType,
            toolUseId,
            toolName,
            content,
            isError: result.isError === true || result.state === 'failed',
          });
          return;
        }
        throw new Error(`DSH Provider tool phase is unsupported: ${phase}`);
      }
      case 'usage': {
        const usage = usageEvent(event.usage, event.semantics, event.contextOccupiedTokens, event.runtimeContextWindow);
        if (usage) onEvent(usage);
        return;
      }
      case 'context': {
        const contextOccupiedTokens = tokenCount(event.contextOccupiedTokens);
        const runtimeContextWindow = tokenCount(event.runtimeContextWindow);
        if (contextOccupiedTokens === undefined || runtimeContextWindow === undefined) return;
        onEvent({
          kind: 'context_update',
          contextOccupiedTokens,
          runtimeContextWindow,
        });
        return;
      }
      case 'queued_message': {
        const clientUserMessageId = this.options.clientUserMessageIdForInjection?.(string(event.messageId, 'DSH queued message id'));
        if (clientUserMessageId !== undefined && event.state === 'delivered') {
          onEvent({ kind: 'user_message_accepted', clientUserMessageId });
        } else if (clientUserMessageId !== undefined && event.state === 'cancelled') {
          onEvent({ kind: 'user_message_cancelled', clientUserMessageId });
        }
        return;
      }
      case 'task_graph': {
        onEvent({
          kind: 'agent_plan_update',
          todos: taskGraphTodos(object(event.snapshot, 'DSH TaskGraph snapshot')),
        });
        return;
      }
      case 'plan': {
        const mode = event.mode;
        if (mode !== 'normal' && mode !== 'plan') throw new Error('DSH Plan mode is invalid');
        this.options.onPlan?.({ mode, revision: string(event.revision, 'DSH Plan revision') });
        return;
      }
      case 'work': {
        const lifecycle = workLifecycle(object(event.snapshot, 'DSH ProductWork snapshot'));
        // Only direct children own tools in the root conversation. Deeper
        // nodes are read through the Runtime tree, never keyed by a root call ID.
        if (lifecycle.tree === undefined || lifecycle.tree.parentAgentId === envelope.runtimeSessionId) onEvent(lifecycle);
        return;
      }
      case 'compaction':
        onEvent({ kind: 'log', level: event.phase === 'failed' ? 'error' : 'info', message: `DSH compaction ${String(event.phase)}` });
        return;
      case 'warning':
        onEvent({ kind: 'log', level: 'warn', message: `${string(event.code, 'DSH warning code')}: ${string(event.message, 'DSH warning message')}` });
        return;
      case 'session':
        if (event.phase === 'ready') onEvent({ kind: 'status_change', state: 'idle' });
        return;
      case 'turn_terminal': {
        const clientOperationId = string(event.clientOperationId, 'DSH terminal operation id');
        const terminal = object(event.terminal, 'DSH turn terminal');
        const summary = telemetryRecord(terminal.usage);
        const usage = usageEvent(summary, 'delta', summary?.contextOccupiedTokens, summary?.runtimeContextWindow);
        if (usage) onEvent(usage);
        this.options.onTurnTerminal?.({ clientOperationId, turnId: envelope.turnId, terminal });
        onEvent({
          kind: 'turn_complete',
          clientOperationId,
          ...terminalStatus(terminal),
        });
        return;
      }
      case 'message_event':
      case 'interaction':
      case 'component':
      case 'catalog':
      case 'checkpoint':
      case 'retry':
        return;
      default:
        onEvent({ kind: 'raw', data: structuredClone(envelope) });
    }
  }
}
