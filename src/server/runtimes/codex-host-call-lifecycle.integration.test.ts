import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Subprocess } from '../utils/subprocess';
import type { RuntimeProcess, UnifiedEvent } from './types';
import type { ProductHostToolCall, ProductHostToolResult } from './product-extensions/contracts';

const fixture = vi.hoisted(() => ({ home: '', spawn: vi.fn() }));
vi.mock('os', async original => ({ ...await original<typeof import('os')>(), homedir: () => fixture.home }));
vi.mock('../utils/subprocess', async original => ({ ...await original<typeof import('../utils/subprocess')>(), spawn: (...args: unknown[]) => fixture.spawn(...args) }));
vi.mock('./codex-command-context', () => ({ resolveCodexCommandContext: async () => ({ commandPath: '/fixture/codex', env: {}, version: '0.163.0' }) }));

describe('Codex native item and Host call lifetime', () => {
  let exit: (code: number) => void;
  let notify: (method: string, params: unknown) => void;
  let request: (id: number | string, method: string, params: unknown) => void;
  let runtime: import('./codex').CodexRuntime;
  let respond: MockInstance<import('./codex').JsonRpcClient['respond']>;
  let events: UnifiedEvent[];
  let resolveDispatch: (result: ProductHostToolResult) => void;
  let rejectDispatch: (error: Error) => void;
  let dispatch: ReturnType<typeof vi.fn<(call: ProductHostToolCall) => Promise<ProductHostToolResult>>>;
  const descriptor = { name: 'myagents__mcp__local__write', description: 'Write', inputSchema: { type: 'object' } };
  const result: ProductHostToolResult = { success: true, contentItems: [{ type: 'text', text: 'done' }] };

  beforeEach(async () => {
    vi.resetModules();
    fixture.home = await mkdtemp(join(tmpdir(), 'codex-host-lifetime-'));
    events = [];
    dispatch = vi.fn(() => new Promise((resolve, reject) => {
      resolveDispatch = resolve;
      rejectDispatch = reject;
    }));
    fixture.spawn.mockReturnValue({
      pid: 987654321,
      exited: new Promise<number>(resolve => { exit = resolve; }),
      stdout: new ReadableStream({ start(controller) { controller.close(); } }),
      stderr: new ReadableStream({ start(controller) { controller.close(); } }),
      stdin: { write: vi.fn(async () => {}), flush: vi.fn(async () => {}), end: async () => { exit(0); } },
      kill: () => { exit(143); },
    } as unknown as Subprocess);
    const { CodexRuntime, JsonRpcClient } = await import('./codex');
    runtime = new CodexRuntime();
    vi.spyOn(JsonRpcClient.prototype, 'startReading').mockResolvedValue();
    vi.spyOn(JsonRpcClient.prototype, 'setNotificationHandler').mockImplementation(handler => { notify = handler; });
    vi.spyOn(JsonRpcClient.prototype, 'setServerRequestHandler').mockImplementation(handler => { request = handler; });
    respond = vi.spyOn(JsonRpcClient.prototype, 'respond').mockImplementation(() => {});
    vi.spyOn(JsonRpcClient.prototype, 'call').mockImplementation(async method => {
      if (method === 'thread/start') return { thread: { id: 'native-thread' }, model: 'fixture-model', approvalsReviewer: 'auto_review' };
      if (method === 'getAuthStatus') return { authMethod: 'apikey' };
      if (method === 'config/read') return { config: {} };
      return { data: [] };
    });
  });

  afterEach(async () => {
    exit?.(0);
    await Promise.resolve();
    vi.restoreAllMocks();
    await rm(fixture.home, { recursive: true, force: true });
  });

  async function start(permissionMode = 'auto-edit'): Promise<RuntimeProcess> {
    const process = await runtime.startSession({
      sessionId: 'product-session', workspacePath: fixture.home, scenario: { type: 'desktop' },
      runtimeSource: 'managed-provider', permissionMode,
      managedCodexExtensions: {
        revision: 'fixture', workspacePath: fixture.home, scenario: { type: 'desktop' },
        skills: [], commands: [], agents: [], dynamicTools: [descriptor], components: [], enabledPluginIds: [], mcpServers: [],
        hostToolDispatcher: { descriptors: [descriptor], dispatch, dispose: vi.fn() },
      },
    }, event => { events.push(event); });
    notify('turn/started', { threadId: 'native-thread', turn: { id: 'native-turn' } });
    request(41, 'item/tool/call', {
      threadId: 'native-thread', turnId: 'native-turn', callId: 'call-one', tool: descriptor.name, arguments: {},
    });
    return process;
  }

  function complete(threadId = 'native-thread', turnId = 'native-turn', id = 'call-one', success = false) {
    notify('item/completed', {
      threadId, turnId,
      item: { type: 'dynamicToolCall', id, tool: descriptor.name, status: success ? 'completed' : 'failed', success, contentItems: [] },
    });
  }

  it('expires approval at cell completion while the root turn continues', async () => {
    const process = await start();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'permission_request', requestId: '41' }));
    complete();
    expect(events).toContainEqual({ kind: 'interactive_request_resolved', requestId: '41' });
    await runtime.respondPermission(process, '41', 'allow_once');
    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledExactlyOnceWith(41, expect.objectContaining({ success: false }));
    expect(events.some(event => event.kind === 'turn_complete')).toBe(false);
  });

  it.each(['result', 'rejection'])('aborts the running call and ignores its late %s', async outcome => {
    await start('no-restrictions');
    const call = dispatch.mock.calls[0][0];
    complete();
    expect(call.signal.aborted).toBe(true);
    if (outcome === 'result') resolveDispatch(result);
    else rejectDispatch(new Error('late failure'));
    await Promise.resolve();
    complete();
    expect(respond).toHaveBeenCalledExactlyOnceWith(41, expect.objectContaining({ success: false }));
    expect(events.some(event => event.kind === 'turn_complete')).toBe(false);
  });

  it.each([
    ['child-thread', 'native-turn', 'call-one'],
    ['native-thread', 'old-turn', 'call-one'],
    ['native-thread', 'native-turn', 'other-call'],
    ['', 'native-turn', 'call-one'],
    ['native-thread', '', 'call-one'],
  ])('does not cancel a call for unrelated item identity %s/%s/%s', async (thread, turn, id) => {
    await start('no-restrictions');
    complete(thread, turn, id);
    expect(dispatch.mock.calls[0][0].signal.aborted).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    resolveDispatch(result);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledExactlyOnceWith(41, expect.objectContaining({ success: true })));
  });

  it('does not settle again when the dispatcher response wins the race', async () => {
    await start('no-restrictions');
    resolveDispatch(result);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    complete();
    expect(dispatch.mock.calls[0][0].signal.aborted).toBe(false);
    expect(respond).toHaveBeenCalledExactlyOnceWith(41, expect.objectContaining({ success: true }));
  });

  it.each(['stop', 'exit', 'turn'] as const)('preserves whole %s boundary cancellation', async boundary => {
    const process = await start('no-restrictions');
    if (boundary === 'stop') await runtime.stopSession(process);
    else if (boundary === 'exit') exit(1);
    else notify('turn/completed', { threadId: 'native-thread', turn: { id: 'native-turn', status: 'interrupted' } });
    await vi.waitFor(() => expect(dispatch.mock.calls[0][0].signal.aborted).toBe(true));
    resolveDispatch(result);
    await Promise.resolve();
    expect(respond).toHaveBeenCalledExactlyOnceWith(41, expect.objectContaining({ success: false }));
  });
});
