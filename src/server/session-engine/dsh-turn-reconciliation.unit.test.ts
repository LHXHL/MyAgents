import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  DshNativeHistory,
  DshTurnLookup,
  DshVerifiedHistoryEvent,
} from '../integrated-runtimes/dsh/mutations';
import {
  buildDshTurnProjectionSnapshot,
  reconcileDshTurnsAtStartup,
} from './dsh-turn-reconciliation';

const runtimeSessionId = 'runtime-session-ordinary-recovery';

function event(sequence: number, eventType: string, data: unknown): DshVerifiedHistoryEvent {
  return {
    sequence,
    eventType,
    eventSha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    data,
  };
}

function durableEventId(sequence: number): string {
  const sessionHash = createHash('sha256').update(runtimeSessionId).digest('hex').slice(0, 24);
  return `dsh-event-${sessionHash}-${sequence}`;
}

function succeededHistory(): {
  history: DshNativeHistory;
  lookups: ReadonlyMap<string, DshTurnLookup>;
} {
  const terminal = {
    kind: 'succeeded',
    assistantEventId: durableEventId(6),
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    },
  };
  const events = [
    event(0, 'myagents/operation/accepted', {
      clientOperationId: 'operation-1',
      clientUserMessageId: 'user-1',
      productTurnId: 'product-turn-1',
      acceptedAt: 1_000,
    }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'myagents/operation/claimed', {
      clientOperationId: 'operation-1',
      messageId: 'native-user-1',
      dshTurn: 1,
    }),
    event(3, 'assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'native-assistant-1',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        content: [
          { type: 'reasoning', text: 'check the workspace' },
          { type: 'tool-call', id: 'call-1', name: 'Read', arguments: '{"file_path":"/tmp/a"}' },
        ],
      },
      usage: { inputTokens: 5, outputTokens: 3 },
    }),
    event(4, 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'Read',
      arguments: '{"file_path":"/tmp/a"}',
    }),
    event(5, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'native-tool-result-1',
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'file body' }],
        }],
      },
    }),
    event(6, 'assistant/message', {
      turn: 1,
      step: 2,
      message: {
        id: 'native-assistant-2',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        content: [{ type: 'text', text: 'Done.' }],
      },
      usage: { inputTokens: 6, outputTokens: 4 },
    }),
    event(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(8, 'myagents/operation/terminal', {
      clientOperationId: 'operation-1',
      productTurnId: 'product-turn-1',
      terminal,
      finalDshTurn: 1,
      terminalAt: 2_000,
    }),
  ];
  return {
    history: {
      runtimeSessionId,
      durableSequence: events.length,
      events,
      mutationBoundaries: [],
      transcriptPostcondition: 'a'.repeat(64),
    },
    lookups: new Map([[
      'operation-1',
      {
        clientOperationId: 'operation-1',
        admission: {
          clientOperationId: 'operation-1',
          turnId: 'product-turn-1',
          admittedAt: new Date(1_000).toISOString(),
        },
        terminal,
      },
    ]]),
  };
}

describe('DSH ordinary turn reconciliation', () => {
  it('derives one stable Product assistant from matching session/read and turn/get truth', () => {
    const fixture = succeededHistory();
    const snapshot = buildDshTurnProjectionSnapshot(fixture.history, fixture.lookups);

    expect(snapshot.cursor).toEqual({
      schemaVersion: 1,
      runtimeSessionId,
      durableSequence: 9,
      transcriptPostcondition: 'a'.repeat(64),
    });
    expect(snapshot.runtimeUsageTotals).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
    });
    expect(snapshot.assistantTurns).toHaveLength(1);
    const recovered = snapshot.assistantTurns[0]!.assistantMessage;
    expect(recovered.id).toMatch(/^assistant-dsh-[a-f0-9]{32}$/u);
    expect(recovered.runtimeTurnAnchor).toEqual({
      turnId: 'product-turn-1',
      rootUserMessageId: 'user-1',
    });
    expect(recovered.usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
      model: 'deepseek-v4-flash',
    });
    expect(JSON.parse(recovered.content)).toEqual([
      {
        type: 'thinking',
        thinking: 'check the workspace',
        thinkingStreamIndex: 0,
        isComplete: true,
      },
      {
        type: 'tool_use',
        tool: {
          id: 'call-1',
          name: 'Read',
          input: { file_path: '/tmp/a' },
          inputJson: '{\n  "file_path": "/tmp/a"\n}',
          result: '[{"text":"file body","type":"text"}]',
          isError: false,
          streamIndex: 1,
        },
      },
      { type: 'text', text: 'Done.' },
    ]);
  });

  it('does not manufacture an assistant for a failed terminal', () => {
    const fixture = succeededHistory();
    const failed = { kind: 'failed', code: 'provider_error', message: 'failed', retryable: true };
    const events = fixture.history.events.map(candidate => candidate.eventType === 'myagents/operation/terminal'
      ? event(candidate.sequence, candidate.eventType, {
          clientOperationId: 'operation-1',
          productTurnId: 'product-turn-1',
          terminal: failed,
          finalDshTurn: 1,
          terminalAt: 2_000,
        })
      : candidate);
    const snapshot = buildDshTurnProjectionSnapshot(
      { ...fixture.history, events },
      new Map([['operation-1', {
        ...fixture.lookups.get('operation-1')!,
        terminal: failed,
      }]]),
    );
    expect(snapshot.assistantTurns).toEqual([]);
    expect(snapshot.runtimeUsageTotals).toBeUndefined();
  });

  it('fails closed when turn/get disagrees with the durable terminal', () => {
    const fixture = succeededHistory();
    const lookup = fixture.lookups.get('operation-1')!;
    expect(() => buildDshTurnProjectionSnapshot(
      fixture.history,
      new Map([['operation-1', {
        ...lookup,
        terminal: { ...lookup.terminal, assistantEventId: durableEventId(3) },
      }]]),
    )).toThrow(/turn\/get terminal differs/u);
  });

  it('does not publish readiness while a resumed admitted turn remains non-terminal', async () => {
    const fixture = succeededHistory();
    const history = {
      ...fixture.history,
      durableSequence: 8,
      events: fixture.history.events.filter(event => event.eventType !== 'myagents/operation/terminal'),
    };
    const admission = fixture.lookups.get('operation-1')!.admission!;
    const snapshot = buildDshTurnProjectionSnapshot(
      history,
      new Map([['operation-1', { clientOperationId: 'operation-1', admission }]]),
    );
    expect(snapshot.unsettledTurns).toEqual([{
      clientOperationId: 'operation-1',
      clientUserMessageId: 'user-1',
      productTurnId: 'product-turn-1',
    }]);

    await expect(reconcileDshTurnsAtStartup({
      productSessionId: 'product-session-1',
      runtimeSessionId,
      controller: {
        readHistory: async () => history,
        getTurn: async () => ({ clientOperationId: 'operation-1', admission }),
      } as never,
    })).rejects.toThrow(/non-terminal admitted turn/u);
  });
});
