import { describe, expect, it, vi } from 'vitest';

import type { UnifiedEvent } from '../../runtimes/types';
import { DshRuntimeEventProjector } from './event-projector';

function envelope(
  sequence: number,
  event: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    runtimeGeneration: 'runtime-generation-1',
    productSessionId: 'product-session-1',
    runtimeSessionId: 'runtime-session-1',
    sequence,
    emittedAt: '2026-08-30T00:00:00.000Z',
    event,
    ...extra,
  };
}

describe('DshRuntimeEventProjector', () => {
  it('projects one exact durable turn without manufacturing an early idle state', async () => {
    const events: UnifiedEvent[] = [];
    const onTerminal = vi.fn();
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1',
      runtimeGeneration: 'runtime-generation-1',
      onEvent: event => events.push(event),
      onTurnTerminal: onTerminal,
      clientUserMessageIdForOperation: operationId => operationId === 'operation-1'
        ? 'user-message-1'
        : undefined,
    });

    await projector.accept(envelope(1, {
      kind: 'turn_admitted',
      admission: {
        clientOperationId: 'operation-1',
        turnId: 'turn-1',
        admittedAt: '2026-08-30T00:00:00.000Z',
      },
    }));
    await projector.accept(envelope(2, { kind: 'turn_started' }, { turnId: 'turn-1' }));
    await projector.accept(envelope(3, { kind: 'assistant_delta', delta: 'hello' }, { turnId: 'turn-1' }));
    await projector.accept(envelope(4, {
      kind: 'turn_terminal',
      clientOperationId: 'operation-1',
      terminal: {
        kind: 'succeeded',
        assistantEventId: 'assistant-1',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
          totalTokens: 15,
          costUsd: null,
          turnId: 'turn-1',
          normalizedAs: 'turn_total',
          contextOccupiedTokens: 13,
          runtimeContextWindow: 200_000,
          modelProfileRevision: 'profile-1',
        },
      },
    }, { turnId: 'turn-1' }));

    expect(events).toContainEqual({
      kind: 'root_turn_admitted',
      runtimeTurnId: 'turn-1',
      clientUserMessageId: 'user-message-1',
    });
    expect(events).toContainEqual({ kind: 'text_delta', text: 'hello' });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'usage',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      contextOccupiedTokens: 13,
      runtimeContextWindow: 200_000,
    }));
    expect(events.at(-1)).toEqual({
      kind: 'turn_complete',
      clientOperationId: 'operation-1',
      status: 'success',
    });
    expect(events).not.toContainEqual({ kind: 'status_change', state: 'idle' });
    expect(onTerminal).toHaveBeenCalledWith({
      clientOperationId: 'operation-1',
      turnId: 'turn-1',
      terminal: expect.objectContaining({ kind: 'succeeded' }),
    });
  });

  it('accepts exact replay but fails closed on conflicts, gaps, and generation drift', async () => {
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1',
      runtimeGeneration: 'runtime-generation-1',
      onEvent: vi.fn(),
    });
    const first = envelope(1, { kind: 'assistant_delta', delta: 'one' });
    await projector.accept(first);
    await expect(projector.accept(first)).resolves.toBeUndefined();
    await expect(projector.accept(envelope(1, {
      kind: 'assistant_delta',
      delta: 'conflict',
    }))).rejects.toThrow('conflicting duplicate');

    const gap = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1',
      runtimeGeneration: 'runtime-generation-1',
      onEvent: vi.fn(),
    });
    await expect(gap.accept(envelope(2, { kind: 'turn_started' }))).rejects.toThrow('sequence gap');

    const drift = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1',
      runtimeGeneration: 'runtime-generation-1',
      onEvent: vi.fn(),
    });
    await expect(drift.accept({
      ...envelope(1, { kind: 'turn_started' }),
      runtimeGeneration: 'runtime-generation-2',
    })).rejects.toThrow('escaped its active generation authority');
  });

  it('projects correlated tool input and terminal result', async () => {
    const events: UnifiedEvent[] = [];
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1',
      runtimeGeneration: 'runtime-generation-1',
      onEvent: event => events.push(event),
    });
    await projector.accept(envelope(1, {
      kind: 'tool',
      phase: 'start',
      name: 'Read',
      detail: { file_path: '/workspace/a.txt' },
    }, { toolCallId: 'call-1' }));
    await projector.accept(envelope(2, {
      kind: 'tool',
      phase: 'end',
      name: 'Read',
      detail: { state: 'succeeded', isError: false, content: [{ type: 'text', text: 'ok' }] },
    }, { toolCallId: 'call-1' }));

    expect(events).toEqual([
      {
        kind: 'tool_use_start',
        toolUseId: 'call-1',
        toolName: 'Read',
        input: { file_path: '/workspace/a.txt' },
      },
      {
        kind: 'tool_use_stop',
        toolUseId: 'call-1',
        input: { file_path: '/workspace/a.txt' },
      },
      {
        kind: 'tool_result',
        toolUseId: 'call-1',
        content: '[{"text":"ok","type":"text"}]',
        isError: false,
      },
    ]);
  });

  it('projects DSH thinking, Plan, and context metrics into existing Product events', async () => {
    const events: UnifiedEvent[] = [];
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1',
      runtimeGeneration: 'runtime-generation-1',
      onEvent: event => events.push(event),
    });
    await projector.accept(envelope(1, {
      kind: 'thinking_delta',
      delta: 'inspect the exact runtime state',
    }, { turnId: 'turn-1', itemId: 'thinking-1' }));
    await projector.accept(envelope(2, {
      kind: 'plan',
      revision: 'plan-revision-1',
      detail: {
        todos: [
          { id: 'inspect', content: 'Inspect evidence', status: 'completed' },
          { id: 'verify', title: 'Verify package', status: 'in_progress' },
        ],
      },
    }, { turnId: 'turn-1' }));
    await projector.accept(envelope(3, {
      kind: 'context',
      contextOccupiedTokens: 12_345,
      runtimeContextWindow: 200_000,
      modelProfileRevision: 'profile-revision-1',
    }, { turnId: 'turn-1' }));

    expect(events).toEqual([
      {
        kind: 'thinking_delta',
        text: 'inspect the exact runtime state',
        index: 0,
      },
      {
        kind: 'agent_plan_update',
        todos: [
          {
            key: 'inspect',
            content: 'Inspect evidence',
            activeForm: 'Inspect evidence',
            status: 'completed',
          },
          {
            key: 'verify',
            content: 'Verify package',
            activeForm: 'Verify package',
            status: 'in_progress',
          },
        ],
      },
      {
        kind: 'usage',
        inputTokens: 0,
        outputTokens: 0,
        semantics: 'delta',
        contextOccupiedTokens: 12_345,
        runtimeContextWindow: 200_000,
      },
    ]);
  });
});
