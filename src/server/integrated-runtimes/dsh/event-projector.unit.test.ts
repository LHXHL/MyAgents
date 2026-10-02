import { describe, expect, it, vi } from 'vitest';

import type { UnifiedEvent } from '../../runtimes/types';
import { DshRuntimeEventProjector, projectDshAgentWorkSnapshot } from './event-projector';

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
  it.each([null, 'raw tool arguments', ['one', 'two'], 42])(
    'keeps a turn usable when tool display input is not an object: %j', async input => {
      const events: UnifiedEvent[] = [];
      const projector = new DshRuntimeEventProjector({
        productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1', onEvent: event => events.push(event),
      });
      await projector.accept(envelope(1, { kind: 'tool', phase: 'start', name: 'Fixture', input }, { toolCallId: 'call-1' }));
      await projector.accept(envelope(2, { kind: 'turn_terminal', clientOperationId: 'operation-1',
        terminal: { kind: 'succeeded', assistantEventId: 'assistant-1' } }));
      expect(events[0]).toMatchObject({ kind: 'tool_use_start', input: { arguments: input } });
      expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', status: 'success' });
    },
  );

  it.each(['available', 'partly-unavailable', 'no-resolver'] as const)(
    'publishes Provider images independently of model modality and isolates attachment failures: %s', async mode => {
    const events: UnifiedEvent[] = [];
    const attachment = { kind: 'image' as const, mimeType: 'image/png',
      refPath: '/api/attachment/tool/product-session-1/turn-1/image.png' };
    const resolveToolImage = vi.fn(async (image: Record<string, unknown>) => {
      if (mode === 'partly-unavailable' && image.attachmentId === 'fixture-image') throw new Error('fixture lease unavailable');
      return attachment;
    });
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1', onEvent: event => events.push(event),
      ...(mode === 'no-resolver' ? {} : { resolveToolImage }),
    });
    await projector.accept(envelope(1, { kind: 'provider_tool', phase: 'end', name: 'Fixture',
      providerRouteId: 'provider-1', providerToolCallId: 'call-1', providerBlockType: 'fixture_result',
      result: { state: 'succeeded', isError: false, content: [
        { type: 'text', text: 'Useful text' },
        { type: 'image_ref', attachmentId: 'fixture-image', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64) },
        { type: 'text', text: 'More text' },
        { type: 'image_ref', attachmentId: 'fixture-image-2', mimeType: 'image/png', sizeBytes: 1, sha256: 'b'.repeat(64) },
      ] } }, { turnId: 'turn-1' }));
    await projector.accept(envelope(2, { kind: 'turn_terminal', clientOperationId: 'operation-1',
      terminal: { kind: 'succeeded', assistantEventId: 'assistant-1' } }));
    const result = events.find(event => event.kind === 'provider_tool_result');
    expect(result).toMatchObject({ kind: 'provider_tool_result', isError: false,
      content: mode === 'available' ? 'Useful text\nMore text'
        : 'Useful text\n[DSH image attachment unavailable]\nMore text'
          + (mode === 'no-resolver' ? '\n[DSH image attachment unavailable]' : ''),
      ...(mode === 'no-resolver' ? {} : { attachments: mode === 'available' ? [attachment, attachment] : [attachment] }),
    });
    if (mode === 'no-resolver') expect(result).not.toHaveProperty('attachments');
    else expect(resolveToolImage).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'fixture-image-2' }), {
      runtimeSessionId: 'runtime-session-1', turnId: 'turn-1', toolUseId: 'call-1', toolName: 'Fixture',
    });
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', status: 'success' });
  });

  it.each(['tool', 'provider_tool'])('isolates unsupported display blocks in %s results', async kind => {
    const events: UnifiedEvent[] = [];
    const projector = new DshRuntimeEventProjector({ productSessionId: 'product-session-1',
      runtimeGeneration: 'runtime-generation-1', onEvent: event => events.push(event) });
    await projector.accept(envelope(1, { kind, phase: 'end', name: 'Fixture',
      providerRouteId: 'provider-1', providerToolCallId: 'call-1', providerBlockType: 'fixture_result',
      result: { state: 'succeeded', content: [{ type: 'text', text: 'Useful text' }, null, { type: 'future-media' }] },
    }, { toolCallId: 'call-1' }));
    await projector.accept(envelope(2, { kind: 'turn_terminal', clientOperationId: 'operation-1',
      terminal: { kind: 'succeeded', assistantEventId: 'assistant-1' } }));
    expect(events[0]).toMatchObject({ kind: kind === 'tool' ? 'tool_result' : 'provider_tool_result',
      content: 'Useful text\n[Unsupported DSH tool result block: undefined]\n[Unsupported DSH tool result block: future-media]', isError: false });
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', status: 'success' });
  });

  it.each([null, 'unavailable', {}, { inputTokens: -1, outputTokens: 2 }])(
    'settles a successful turn despite unusable optional telemetry: %j', async usage => {
      const events: UnifiedEvent[] = [];
      const onTurnTerminal = vi.fn();
      const projector = new DshRuntimeEventProjector({
        productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1',
        onEvent: event => events.push(event), onTurnTerminal,
      });
      await projector.accept(envelope(1, { kind: 'usage', usage, contextOccupiedTokens: null }));
      await projector.accept(envelope(2, { kind: 'context', contextOccupiedTokens: null, runtimeContextWindow: null }));
      await projector.accept(envelope(3, {
        kind: 'turn_terminal', clientOperationId: 'operation-1',
        terminal: { kind: 'succeeded', assistantEventId: 'assistant-1', usage },
      }));
      expect(events).toEqual([{ kind: 'turn_complete', clientOperationId: 'operation-1', status: 'success' }]);
      expect(onTurnTerminal).toHaveBeenCalledOnce();
    },
  );

  it('retains child completion and tools when optional metrics are unavailable', async () => {
    const snapshot = {
      taskId: 'task-1', agentId: 'child-1', agentType: 'Explore', description: 'Inspect fixture',
      parentToolCallId: 'call-1', model: 'fixture-model', mode: 'continuable', state: 'succeeded',
      startedAt: '2026-08-30T00:00:00.000Z', usage: null,
      totalUsage: { inputTokens: 3 }, context: { capacity: null, projectedInputTokens: -1 },
    };
    const child = projectDshAgentWorkSnapshot(snapshot);
    expect(child).toMatchObject({ agentId: 'child-1', status: 'completed' });
    expect(child.usage).toBeUndefined();
    expect(child.totalUsage).toBeUndefined();
    expect(child.context).toBeUndefined();
    const events: UnifiedEvent[] = [];
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1',
      onEvent: event => events.push(event),
    });
    await projector.accept(envelope(1, { kind: 'tool', phase: 'end', name: 'Bash',
      result: { state: 'succeeded', content: [{ type: 'text', text: 'useful output' }], metadata: null },
    }, { turnId: 'turn-1', toolCallId: 'call-1' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', content: 'useful output' }));
  });

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
    await projector.accept(envelope(3, { kind: 'assistant_stream', phase: 'start', streamId: 'stream-1' }, { turnId: 'turn-1' }));
    await projector.accept(envelope(4, { kind: 'assistant_delta', delta: 'hello', streamId: 'stream-1', frameIndex: 0 }, { turnId: 'turn-1' }));
    await projector.accept(envelope(5, { kind: 'assistant_stream', phase: 'end', streamId: 'stream-1', chunkCount: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', eventId: 'assistant-1', messageId: 'message-1' } }, { turnId: 'turn-1' }));
    await projector.accept(envelope(6, {
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

  it('projects root child identities and does not attach deep child calls to the root transcript', async () => {
    const events: UnifiedEvent[] = [];
    const projector = new DshRuntimeEventProjector({ productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1', onEvent: event => events.push(event) });
    const snapshot = { taskId: 'task-1', agentId: 'child-1', agentType: 'general-purpose', description: 'Fixture child',
      parentToolCallId: 'call-reused', model: 'fixture-model', mode: 'continuable', state: 'succeeded',
      startedAt: '2026-08-30T00:00:00.000Z', finishedAt: '2026-08-30T00:00:01.000Z', handleState: 'open', handleRevision: 19,
      activation: { id: 'epoch-1', ordinal: 1, state: 'completed' },
      modelRoute: { provider: 'fixture-provider', profileRevision: 'profile-child', selection: 'fixed' },
      tree: { rootAgentId: 'runtime-session-1', parentAgentId: 'runtime-session-1', depth: 1 } };
    await projector.accept(envelope(1, { kind: 'work', snapshot }));
    await projector.accept(envelope(2, { kind: 'work', snapshot: { ...snapshot, taskId: 'task-2', agentId: 'grandchild',
      tree: { ...snapshot.tree, parentAgentId: 'child-1', depth: 2 } } }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: 'child-1', handleRevision: 19, modelRoute: snapshot.modelRoute, tree: snapshot.tree });
  });

  it('keeps automatic Root admission and user injection receipts distinct', async () => {
    const events: UnifiedEvent[] = [];
    const admitted = vi.fn();
    const emitted = vi.fn((event: UnifiedEvent) => events.push(event));
    const projector = new DshRuntimeEventProjector({ productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1',
      onEvent: emitted, onCollaborationAdmitted: admitted,
      clientUserMessageIdForInjection: id => id === 'product-user-1' ? id : undefined });
    await projector.accept(envelope(1, { kind: 'turn_admitted', admission: {
      clientOperationId: 'auto-1', turnId: 'auto-turn-1', admittedAt: '2026-08-30T00:00:00.000Z', origin: 'collaboration' } }));
    await projector.accept(envelope(2, { kind: 'queued_message', messageId: 'work-report-1', state: 'delivered' }));
    await projector.accept(envelope(3, { kind: 'queued_message', messageId: 'product-user-1', state: 'queued' }));
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ kind: 'root_turn_admitted' }), 'auto-turn-1');
    expect(events).toEqual([{ kind: 'root_turn_admitted', origin: 'collaboration', clientOperationId: 'auto-1', runtimeTurnId: 'auto-turn-1' }]);
    await projector.accept(envelope(4, { kind: 'queued_message', messageId: 'product-user-1', state: 'cancelled' }));
    expect(events.at(-1)).toEqual({ kind: 'user_message_cancelled', clientUserMessageId: 'product-user-1' });
    expect(admitted).toHaveBeenCalledExactlyOnceWith('auto-1', 'auto-turn-1');
  });

  it('accepts exact replay but fails closed on conflicts, gaps, and generation drift', async () => {
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1',
      runtimeGeneration: 'runtime-generation-1',
      onEvent: vi.fn(),
    });
    const first = envelope(1, { kind: 'turn_started' });
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
      input: { file_path: '/workspace/a.txt' },
    }, { toolCallId: 'call-1' }));
    await projector.accept(envelope(2, {
      kind: 'tool',
      phase: 'end',
      name: 'Read',
      result: { state: 'succeeded', isError: false, content: [{ type: 'text', text: 'ok' }] },
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
        content: 'ok',
        isError: false,
      },
    ]);
  });

  it('keeps Provider-owned activity distinct from canonical tool execution', async () => {
    const events: UnifiedEvent[] = [];
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1',
      runtimeGeneration: 'runtime-generation-1',
      onEvent: event => events.push(event),
    });
    await projector.accept(envelope(1, {
      kind: 'provider_tool',
      phase: 'start',
      providerRouteId: 'fixture-provider',
      providerToolCallId: 'provider-call-1',
      providerBlockType: 'server_tool_use',
      name: 'web_search',
      input: { query: 'public reference' },
    }, { turnId: 'turn-1', toolCallId: 'provider-call-1' }));
    await projector.accept(envelope(2, {
      kind: 'provider_tool',
      phase: 'end',
      providerRouteId: 'fixture-provider',
      providerToolCallId: 'provider-call-1',
      providerBlockType: 'web_search_tool_result',
      name: 'web_search',
      result: {
        state: 'succeeded',
        isError: false,
        content: [{ type: 'text', text: '[{"title":"Reference"}]' }],
      },
    }, { turnId: 'turn-1', toolCallId: 'provider-call-1' }));

    expect(events).toEqual([
      {
        kind: 'provider_tool_use_start',
        providerRouteId: 'fixture-provider',
        providerBlockType: 'server_tool_use',
        toolUseId: 'provider-call-1',
        toolName: 'web_search',
        input: { query: 'public reference' },
      },
      {
        kind: 'provider_tool_result',
        providerRouteId: 'fixture-provider',
        providerBlockType: 'web_search_tool_result',
        toolUseId: 'provider-call-1',
        toolName: 'web_search',
        content: '[{"title":"Reference"}]',
        isError: false,
      },
    ]);
    expect(events.some(event => event.kind === 'tool_use_start' || event.kind === 'tool_result')).toBe(false);
  });

  it('keeps Plan, TaskGraph, and context in separate Product domains', async () => {
    const events: UnifiedEvent[] = [];
    const onPlan = vi.fn();
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1',
      runtimeGeneration: 'runtime-generation-1',
      onEvent: event => events.push(event),
      onPlan,
    });
    await projector.accept(envelope(1, { kind: 'assistant_stream', phase: 'start', streamId: 'stream-1' }, { turnId: 'turn-1' }));
    await projector.accept(envelope(2, {
      kind: 'thinking_delta', streamId: 'stream-1', frameIndex: 0,
      delta: 'inspect the exact runtime state',
    }, { turnId: 'turn-1', itemId: 'thinking-1' }));
    await projector.accept(envelope(3, {
      kind: 'plan',
      revision: 'plan-revision-1',
      mode: 'plan',
    }, { turnId: 'turn-1' }));
    await projector.accept(envelope(4, {
      kind: 'task_graph',
      snapshot: {
        revision: 'tasks-revision-1',
        tasks: [
          { id: 'inspect', subject: 'Inspect evidence', status: 'completed' },
          { id: 'verify', subject: 'Verify package', status: 'in_progress' },
          { id: 'old', subject: 'Cancelled task', status: 'cancelled' },
        ],
      },
    }, { turnId: 'turn-1' }));
    await projector.accept(envelope(5, {
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
        kind: 'context_update',
        contextOccupiedTokens: 12_345,
        runtimeContextWindow: 200_000,
      },
    ]);
    expect(onPlan).toHaveBeenCalledWith({ mode: 'plan', revision: 'plan-revision-1' });
  });

  it('projects complete ProductWork lifecycle and resolves ordered rich tool results', async () => {
    const events: UnifiedEvent[] = [];
    const resolveToolImage = vi.fn(async () => ({
      kind: 'image' as const,
      mimeType: 'image/png',
      refPath: '/api/attachment/tool/product-session-1/turn-1/image.png',
    }));
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1',
      runtimeGeneration: 'runtime-generation-1',
      onEvent: event => events.push(event),
      resolveToolImage,
    });

    await projector.accept(envelope(1, {
      kind: 'work',
      snapshot: {
        taskId: 'task-1',
        parentToolCallId: 'agent-call-1',
        agentId: 'agent-1',
        agentType: 'Explore',
        description: 'Inspect the workspace',
        mode: 'continuable',
        model: 'deepseek-chat',
        state: 'aborted',
        handleState: 'closed',
        activation: { id: 'activation-1', ordinal: 1, state: 'completed' },
        startedAt: '2026-08-30T00:00:00.000Z',
        finishedAt: '2026-08-30T00:00:02.000Z',
        result: 'Done',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          totalTokens: 17,
          costUsd: null,
        },
      },
    }));
    await projector.accept(envelope(2, {
      kind: 'tool',
      phase: 'end',
      name: 'Read',
      result: {
        state: 'succeeded',
        isError: false,
        content: [
          { type: 'text', text: 'before' },
          { type: 'image_ref', attachmentId: 'sha256:image', mimeType: 'image/png', sizeBytes: 10, sha256: 'a'.repeat(64) },
          { type: 'text', text: 'after' },
        ],
        metadata: { durationMs: 20, status: 'succeeded' },
      },
    }, { turnId: 'turn-1', toolCallId: 'read-1' }));

    expect(events[0]).toEqual(expect.objectContaining({
      kind: 'subagent_lifecycle',
      parentToolUseId: 'agent-call-1',
      status: 'completed',
      handleState: 'closed',
      activation: { id: 'activation-1', ordinal: 1, state: 'completed' },
      observedAt: Date.parse('2026-08-30T00:00:02.000Z'),
      agentType: 'Explore',
      description: 'Inspect the workspace',
      mode: 'continuable',
      result: 'Done',
      affectsRootActivity: false,
    }));
    expect(events[1]).toEqual(expect.objectContaining({
      kind: 'tool_result',
      toolUseId: 'read-1',
      content: 'before\nafter',
      attachments: [expect.objectContaining({ kind: 'image' })],
      metadata: { durationMs: 20, status: 'succeeded' },
    }));
    expect(resolveToolImage).toHaveBeenCalledOnce();
  });
  it('settles attempts without synthesizing completed content and accepts skipped non-text positions', async () => {
    const events: UnifiedEvent[] = [];
    const projector = new DshRuntimeEventProjector({ productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1', onEvent: event => events.push(event) });
    let sequence = 0;
    const send = (event: Record<string, unknown>) => projector.accept(envelope(++sequence, event, { turnId: 'turn-1' }));
    for (const [streamId, outcome] of [
      ['first', { kind: 'abandoned' }],
      ['second', { kind: 'committed', eventId: 'attempt-1', eventType: 'assistant/attempt' }],
      ['third', { kind: 'committed', eventId: 'assistant-1', eventType: 'assistant/message', messageId: 'message-1' }],
    ] as const) {
      await send({ kind: 'assistant_stream', phase: 'start', streamId });
      await send({ kind: 'assistant_delta', streamId, frameIndex: 2, delta: streamId });
      await send({ kind: 'assistant_stream', phase: 'end', streamId, chunkCount: 4, outcome });
    }
    expect(events).toEqual(['first', 'second', 'third'].map(text => ({ kind: 'text_delta', text })));
  });

  it.each(['thinking_delta', 'assistant_delta'])(
    'accepts an empty %s frame and continues through text and successful settlement', async kind => {
      const events: UnifiedEvent[] = [];
      const projector = new DshRuntimeEventProjector({
        productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1',
        onEvent: event => events.push(event),
      });
      let sequence = 0;
      const send = (event: Record<string, unknown>) => projector.accept(envelope(++sequence, event, { turnId: 'turn-1' }));
      await send({ kind: 'assistant_stream', phase: 'start', streamId: 'stream-1' });
      await send({ kind: 'thinking_delta', streamId: 'stream-1', frameIndex: 1, delta: 'Fixture reasoning' });
      if (kind === 'thinking_delta') {
        await send({ kind, streamId: 'stream-1', frameIndex: 2, delta: '' });
        expect(events).toEqual([{ kind: 'thinking_delta', text: 'Fixture reasoning', index: 0 }]);
      }
      await send({ kind: 'assistant_delta', streamId: 'stream-1', frameIndex: 4, delta: 'Fixture answer' });
      if (kind === 'assistant_delta') {
        await send({ kind, streamId: 'stream-1', frameIndex: 5, delta: '' });
      }
      await send({ kind: 'assistant_stream', phase: 'end', streamId: 'stream-1', chunkCount: 6,
        outcome: { kind: 'committed', eventType: 'assistant/message', eventId: 'assistant-1', messageId: 'message-1' } });
      await send({ kind: 'turn_terminal', clientOperationId: 'operation-1',
        terminal: { kind: 'succeeded', assistantEventId: 'assistant-1' } });
      await projector.whenIdle();
      expect(projector.failure).toBeUndefined();
      expect(events).toEqual([
        { kind: 'thinking_delta', text: 'Fixture reasoning', index: 0 },
        { kind: 'text_delta', text: 'Fixture answer' },
        { kind: 'turn_complete', clientOperationId: 'operation-1', status: 'success' },
      ]);
    },
  );

  it('retains frame ordering after an empty delta', async () => {
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1', onEvent: vi.fn(),
    });
    await projector.accept(envelope(1, { kind: 'assistant_stream', phase: 'start', streamId: 'stream-1' }, { turnId: 'turn-1' }));
    await projector.accept(envelope(2, { kind: 'thinking_delta', streamId: 'stream-1', frameIndex: 2, delta: '' }, { turnId: 'turn-1' }));
    await expect(projector.accept(envelope(3, {
      kind: 'assistant_delta', streamId: 'stream-1', frameIndex: 2, delta: 'Out of order',
    }, { turnId: 'turn-1' }))).rejects.toThrow('not increasing');
  });

  it.each([undefined, null, 0])('rejects a non-string delta: %j', async delta => {
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1', onEvent: vi.fn(),
    });
    await projector.accept(envelope(1, { kind: 'assistant_stream', phase: 'start', streamId: 'stream-1' }, { turnId: 'turn-1' }));
    await expect(projector.accept(envelope(2, {
      kind: 'assistant_delta', streamId: 'stream-1', frameIndex: 0, ...(delta === undefined ? {} : { delta }),
    }, { turnId: 'turn-1' }))).rejects.toThrow('DSH assistant delta must be a string');
  });

  it('projects an empty warning message without failing the session', async () => {
    const onEvent = vi.fn();
    const projector = new DshRuntimeEventProjector({
      productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1', onEvent,
    });
    await projector.accept(envelope(1, { kind: 'warning', code: 'fixture_warning', message: '' }));
    await projector.whenIdle();
    expect(onEvent).toHaveBeenCalledWith({ kind: 'log', level: 'warn', message: 'fixture_warning: ' }, undefined);
  });

  it('filters the confirmed provider control token across text chunks before Product events', async () => {
    const events: UnifiedEvent[] = [];
    const projector = new DshRuntimeEventProjector({ productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1', onEvent: event => events.push(event) });
    let sequence = 0;
    const send = (event: Record<string, unknown>) => projector.accept(envelope(++sequence, event, { turnId: 'turn-1' }));
    await send({ kind: 'assistant_stream', phase: 'start', streamId: 'stream-1' });
    for (const [frameIndex, delta] of ['</', '｜｜DSML｜｜', ' parameter', '>\nPlain DSML text'].entries()) {
      await send({ kind: 'assistant_delta', streamId: 'stream-1', frameIndex, delta });
    }
    await send({ kind: 'assistant_stream', phase: 'end', streamId: 'stream-1', chunkCount: 4, outcome: { kind: 'abandoned' } });
    expect(events.filter(event => event.kind === 'text_delta').map(event => event.text).join(''))
      .toBe('</[invalid provider control token] parameter>\nPlain DSML text');
  });

  it.each([
    [{ kind: 'assistant_delta', streamId: 'other', frameIndex: 1, delta: 'bad' }, 'turn-1', 'active stream'],
    [{ kind: 'assistant_delta', streamId: 'stream-1', frameIndex: 1, delta: 'bad' }, 'turn-other', 'active stream'],
    [{ kind: 'assistant_delta', streamId: 'stream-1', frameIndex: 0, delta: 'bad' }, 'turn-1', 'not increasing'],
    [{ kind: 'assistant_stream', phase: 'start', streamId: 'other' }, 'turn-1', 'overlap'],
    [{ kind: 'assistant_stream', phase: 'end', streamId: 'stream-1', chunkCount: 0, outcome: { kind: 'abandoned' } }, 'turn-1', 'last frame'],
    [{ kind: 'assistant_stream', phase: 'end', streamId: 'stream-1', chunkCount: 1, outcome: { kind: 'committed', eventId: 'bad', eventType: 'user/message' } }, 'turn-1', 'event type'],
  ])('rejects mismatched live assistant boundaries %#', async (event, turnId, message) => {
    const projector = new DshRuntimeEventProjector({ productSessionId: 'product-session-1', runtimeGeneration: 'runtime-generation-1', onEvent: vi.fn() });
    await projector.accept(envelope(1, { kind: 'assistant_stream', phase: 'start', streamId: 'stream-1' }, { turnId: 'turn-1' }));
    await projector.accept(envelope(2, { kind: 'assistant_delta', streamId: 'stream-1', frameIndex: 0, delta: 'preview' }, { turnId: 'turn-1' }));
    await expect(projector.accept(envelope(3, event, { turnId }))).rejects.toThrow(message);
    await expect(projector.whenIdle()).rejects.toThrow(message);
  });

});
