import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  DshMutationController,
  rewindBoundaryBeforeRuntimeTurn,
  stableBoundaryForRuntimeTurn,
  type DshMutationTransport,
} from './mutations';
import type { DshRpcObject } from './protocol-types';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function event(sequence: number, eventType: string, data: unknown): DshRpcObject {
  const bytes = Buffer.from(canonicalJson(data), 'utf8');
  return {
    kind: 'event',
    sequence,
    eventType,
    eventSha256: createHash('sha256').update(bytes).digest('hex'),
    data,
  };
}

function historyPages(): DshRpcObject[] {
  const terminalData = {
    clientOperationId: 'operation-1',
    terminal: { kind: 'succeeded' },
  };
  const bytes = Buffer.from(canonicalJson(terminalData), 'utf8');
  const terminalSha256 = createHash('sha256').update(bytes).digest('hex');
  const split = Math.floor(bytes.length / 2);
  return [
    {
      runtimeSessionId: 'runtime-session-1',
      historyFormat: 'dsh-session-events-v1',
      durableHead: { sequence: 4, stableBoundaryId: 'boundary-2' },
      genesisBoundary: {
        stableBoundaryId: 'genesis-1',
        sequence: 0,
        transcriptPostcondition: 'd'.repeat(64),
      },
      mutationBoundaries: [{
        stableBoundaryId: 'boundary-2',
        sequence: 4,
        turn: 2,
        transcriptPostcondition: 'b'.repeat(64),
      }],
      transcriptPostcondition: 'c'.repeat(64),
      records: [
        event(0, 'myagents/operation/accepted', {
          clientOperationId: 'operation-1',
          clientUserMessageId: 'user-message-1',
          productTurnId: 'product-turn-1',
        }),
        event(1, 'myagents/operation/claimed', {
          clientOperationId: 'operation-1',
          dshTurn: 1,
        }),
        event(2, 'myagents/operation/claimed', {
          clientOperationId: 'operation-1',
          dshTurn: 2,
        }),
        {
          kind: 'event_chunk',
          sequence: 3,
          eventType: 'myagents/operation/terminal',
          eventSha256: terminalSha256,
          chunkIndex: 0,
          chunkCount: 2,
          offsetBytes: 0,
          totalBytes: bytes.length,
          dataBase64: bytes.subarray(0, split).toString('base64'),
        },
      ],
      nextCursor: 'cursor-1',
    },
    {
      runtimeSessionId: 'runtime-session-1',
      historyFormat: 'dsh-session-events-v1',
      durableHead: { sequence: 4, stableBoundaryId: 'boundary-2' },
      records: [{
        kind: 'event_chunk',
        sequence: 3,
        eventType: 'myagents/operation/terminal',
        eventSha256: terminalSha256,
        chunkIndex: 1,
        chunkCount: 2,
        offsetBytes: split,
        totalBytes: bytes.length,
        dataBase64: bytes.subarray(split).toString('base64'),
      }],
    },
  ];
}

describe('DSH native mutation controller', () => {
  it('validates the independent durable turn lookup identity', async () => {
    const request = vi.fn(async () => ({
      clientOperationId: 'operation-1',
      admission: {
        clientOperationId: 'operation-1',
        turnId: 'product-turn-1',
        admittedAt: '2026-08-30T00:00:00.000Z',
      },
      terminal: { kind: 'aborted', reason: 'user' },
    }));
    const controller = new DshMutationController(
      { request } as DshMutationTransport,
      'runtime-session-1',
    );

    await expect(controller.getTurn('operation-1')).resolves.toEqual({
      clientOperationId: 'operation-1',
      admission: {
        clientOperationId: 'operation-1',
        turnId: 'product-turn-1',
        admittedAt: '2026-08-30T00:00:00.000Z',
      },
      terminal: { kind: 'aborted', reason: 'user' },
    });
    expect(request).toHaveBeenCalledWith(
      'turn/get',
      { clientOperationId: 'operation-1' },
      undefined,
    );
  });

  it('verifies paginated durable history and prepares a fork at the terminal DSH turn', async () => {
    const pages = historyPages();
    const request = vi.fn(async (method: string, params: DshRpcObject) => {
      if (method === 'session/read') return params.cursor ? pages[1]! : pages[0]!;
      if (method === 'session/fork/prepare') {
        return { token: 'fork-token-1', state: 'prepared', receipt: { staged: true } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const controller = new DshMutationController({ request } as DshMutationTransport, 'runtime-session-1');

    const prepared = await controller.prepareFork({
      clientMutationId: 'fork-mutation-1',
      sourceRuntimeTurnId: 'product-turn-1',
      targetRuntimeHome: '/absolute/runtime-target',
      targetPersistenceRef: 'product-target-1',
      targetWorkspaceIdentity: 'workspace-1',
      targetRuntimeSessionId: 'runtime-target-1',
    });

    expect(prepared).toMatchObject({
      boundary: { stableBoundaryId: 'boundary-2', turn: 2 },
      mutation: { token: 'fork-token-1', state: 'prepared' },
    });
    expect(request).toHaveBeenNthCalledWith(1, 'session/read', {}, undefined);
    expect(request).toHaveBeenNthCalledWith(2, 'session/read', { cursor: 'cursor-1' }, undefined);
    expect(request).toHaveBeenNthCalledWith(3, 'session/fork/prepare', {
      clientMutationId: 'fork-mutation-1',
      sourceStableBoundaryId: 'boundary-2',
      targetRuntimeHome: '/absolute/runtime-target',
      targetPersistenceRef: 'product-target-1',
      targetWorkspaceIdentity: 'workspace-1',
      targetRuntimeSessionId: 'runtime-target-1',
    }, undefined);
  });

  it('uses exact transcript postconditions for rewind and fences settlement tokens', async () => {
    const request = vi.fn(async (method: string, params: DshRpcObject) => {
      if (method === 'session/rewind/prepare') {
        return { token: 'rewind-token-1', state: 'prepared' };
      }
      if (method === 'session/rewind/commit') {
        return { token: params.token, state: 'committed', receipt: { durableSequence: 5 } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const controller = new DshMutationController({ request } as DshMutationTransport, 'runtime-session-1');
    const target = {
      stableBoundaryId: 'boundary-1',
      sequence: 2,
      turn: 1,
      transcriptPostcondition: 'a'.repeat(64),
    };

    await expect(controller.prepareRewind({
      clientMutationId: 'rewind-mutation-1',
      target,
      sourceTranscriptPostcondition: 'b'.repeat(64),
    })).resolves.toMatchObject({ token: 'rewind-token-1', state: 'prepared' });
    await expect(controller.commitRewind('rewind-mutation-1', 'rewind-token-1'))
      .resolves.toMatchObject({ token: 'rewind-token-1', state: 'committed' });
    expect(request).toHaveBeenNthCalledWith(1, 'session/rewind/prepare', {
      clientMutationId: 'rewind-mutation-1',
      targetStableBoundaryId: 'boundary-1',
      sourceTranscriptPostcondition: 'b'.repeat(64),
      targetTranscriptPostcondition: 'a'.repeat(64),
    }, undefined);
  });

  it('fails closed on history digest drift and ambiguous stable boundaries', async () => {
    const pages = historyPages();
    const first = structuredClone(pages[0]!);
    const records = first.records as DshRpcObject[];
    records[0] = { ...records[0], eventSha256: '0'.repeat(64) };
    const controller = new DshMutationController({
      request: vi.fn(async () => first),
    } as DshMutationTransport, 'runtime-session-1');
    await expect(controller.readHistory()).rejects.toThrow(/digest mismatch/u);

    const validController = new DshMutationController({
      request: vi.fn(async (_method: string, params: DshRpcObject) => params.cursor ? pages[1]! : pages[0]!),
    } as DshMutationTransport, 'runtime-session-1');
    const history = await validController.readHistory();
    expect(rewindBoundaryBeforeRuntimeTurn(history, null)).toEqual({
      stableBoundaryId: 'genesis-1',
      sequence: 0,
      transcriptPostcondition: 'd'.repeat(64),
    });
    expect(() => stableBoundaryForRuntimeTurn({
      ...history,
      mutationBoundaries: [...history.mutationBoundaries, history.mutationBoundaries[0]!],
    }, 'product-turn-1')).toThrow(/one stable mutation boundary/u);
  });
});
