import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRuntime, JsonRpcClient } from './codex';
import type { RuntimeProcess, UnifiedEvent } from './types';
import type { Subprocess } from '../utils/subprocess';

describe('Codex input acknowledgement lifecycle', () => {
  let output: ReadableStreamDefaultController<Uint8Array>;
  let rpc: JsonRpcClient;
  let reading: Promise<void>;
  let write: ReturnType<typeof vi.fn>;
  let requests: Array<{ id: number; method: string }>;
  const encoder = new TextEncoder();
  const reply = (result: unknown) => output.enqueue(encoder.encode(
    JSON.stringify({ id: requests.at(-1)!.id, result }) + '\n',
  ));

  beforeEach(() => {
    vi.useFakeTimers();
    requests = [];
    write = vi.fn(async (bytes: Uint8Array) => {
      requests.push(JSON.parse(new TextDecoder().decode(bytes)));
    });
    rpc = new JsonRpcClient({
      stdin: { write },
      stdout: new ReadableStream({ start(controller) { output = controller; } }),
    } as unknown as Subprocess);
    reading = rpc.startReading();
  });

  afterEach(async () => {
    rpc.destroy();
    try { output.close(); } catch { /* test already closed stdout */ }
    await reading;
    vi.useRealTimers();
  });

  it.each(['managed-provider', 'system-cli'] as const)(
    'keeps root and steer input waiting for their actual response (%s)',
    async runtimeSource => {
      const events: UnifiedEvent[] = [];
      const process = {
        rpc, exited: false, runtimeSource, threadId: 'thread', workspacePath: '/fixture',
        model: 'fixture', models: [], reasoningEffort: 'low', sandbox: 'read-only', approvalPolicy: 'never',
        rootEventHandler: (event: UnifiedEvent) => events.push(event),
        activeSteerTurnId: '', activeRootTurnAdmission: null,
      } as unknown as RuntimeProcess;
      const runtime = new CodexRuntime();
      let state = 'pending';
      const root = runtime.sendMessage(process, 'fixture', undefined, { clientUserMessageId: 'user' });
      void root.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(state).toBe('pending');
      expect(requests).toHaveLength(1);
      reply({ turn: { id: 'turn' } });
      await root;
      expect(events).toContainEqual({ kind: 'root_turn_admitted', runtimeTurnId: 'turn', clientUserMessageId: 'user' });

      state = 'pending';
      const steer = runtime.steerMessage(process, 'follow-up', undefined, { clientUserMessageId: 'follow-up' });
      void steer.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(state).toBe('pending');
      expect(requests.map(request => request.method)).toEqual(['turn/start', 'turn/steer']);
      reply({ turnId: 'turn' });
      await steer;
    },
  );

  it('reports a real write error without waiting for an RPC deadline', async () => {
    write.mockRejectedValueOnce(new Error('fixture broken pipe'));
    const result = rpc.call('turn/start', {}, null);
    const assertion = expect(result).rejects.toThrow('fixture broken pipe');
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it('keeps the deadline for bounded control requests', async () => {
    const result = rpc.call('model/list', {}, 100);
    const assertion = expect(result).rejects.toThrow('timed out after 100ms');
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
  });

  it.each(['exit', 'stop'] as const)('releases unbounded requests on %s and ignores late responses', async reason => {
    const result = rpc.call('turn/start', {}, null);
    const assertion = expect(result).rejects.toThrow(reason === 'exit' ? 'process exited' : 'Client destroyed');
    if (reason === 'exit') output.close();
    else {
      rpc.destroy();
      reply({ turn: { id: 'too-late' } });
    }
    await assertion;
  });
});
