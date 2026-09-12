import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_CHANNEL_DELIVERY } from '../session-core/channel-delivery';
import type { TurnTerminalOutcome } from '../session-core/turn-queue';

const state = vi.hoisted(() => ({ home: '', failProductIo: false, query: vi.fn(), sdkRead: vi.fn(), sdkFork: vi.fn(), sdkDelete: vi.fn(), events: [] as [string, unknown][], queuedFollowup: false, exitWithoutResult: false, toolFrames: false, childFrames: false, media: vi.fn() }));
vi.mock('os', async original => ({ ...await original<typeof import('os')>(), homedir: () => state.home }));
vi.mock('../utils/fs-utils', async original => {
  const actual = await original<typeof import('../utils/fs-utils')>();
  return { ...actual, ensureDirSync: (...args: Parameters<typeof actual.ensureDirSync>) => {
    if (state.failProductIo && String(args[0]).endsWith(join('.myagents', 'sessions'))) {
      throw Object.assign(new Error('product directory denied'), { code: 'EACCES' });
    }
    return actual.ensureDirSync(...args);
  } };
});
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: (...args: Parameters<typeof actual.mkdir>) => {
    if (state.failProductIo && String(args[0]).endsWith(join('.myagents', 'sessions-v2'))) {
      return Promise.reject(Object.assign(new Error('product directory denied'), { code: 'EACCES' }));
    }
    return actual.mkdir(...args);
  } };
});
vi.mock('@anthropic-ai/claude-agent-sdk', async original => ({
  ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(), query: (...args: unknown[]) => state.query(...args),
  getSessionMessages: (...args: unknown[]) => state.sdkRead(...args),
  forkSession: (...args: unknown[]) => state.sdkFork(...args),
  deleteSession: (...args: unknown[]) => state.sdkDelete(...args),
}));
vi.mock('../runtimes/builtin-media-attachments', () => ({ buildBuiltinMediaAttachments: (...args: unknown[]) => state.media(...args) }));
vi.mock('../sse', async original => ({
  ...await original<typeof import('../sse')>(),
  broadcast: (event: string, data: unknown) => { state.events.push([event, data]); },
  broadcastLive: (event: string, data: unknown) => { state.events.push([event, data]); },
}));

let agent: typeof import('../agent-session');
let store: typeof import('../SessionStore');
let releaseWrite: (() => void) | undefined;

function fakeQuery(args: { prompt: AsyncIterable<unknown>; options: { sessionId: string } }) {
  const prompt = args.prompt[Symbol.asyncIterator]();
  let close!: () => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const pending: unknown[] = [];
  let turn = 0;
  const sessionId = args.options.sessionId;
  const iterator = {
    async next(): Promise<IteratorResult<unknown>> {
      if (pending.length) return { done: false, value: pending.shift() };
      if (state.exitWithoutResult && turn > 0) return { done: true, value: undefined };
      const followup = state.queuedFollowup && turn === 1;
      if (followup) {
        const queue = await import('../builtin-session/queue');
        queue.setInFlightQueueItem('queued-followup', { messageText: 'queued question', channelDelivery: NO_CHANNEL_DELIVERY });
        queue.queueState.awaitingAssistantStartAckQueueId = 'queued-followup';
      }
      const next = followup ? { done: false, value: undefined }
        : await Promise.race([prompt.next(), closed.then(() => ({ done: true as const, value: undefined }))]);
      if (next.done) return { done: true, value: undefined };
      turn++;
      const responseId = `response-${turn}`;
      const envelope = { session_id: sessionId, parent_tool_use_id: null };
      const stream = (event: unknown) => ({ ...envelope, type: 'stream_event', uuid: randomUUID(), event });
      const assistant = (content: unknown[], uuid: string) => ({ ...envelope, type: 'assistant', uuid,
        message: { id: responseId, role: 'assistant', model: 'test-model', content, usage: { input_tokens: 4, output_tokens: 5 } },
      });
      pending.push(
        { type: 'system', subtype: 'init', session_id: sessionId, uuid: randomUUID(), model: 'test-model', tools: [], mcp_servers: [] },
        stream({ type: 'message_start', message: { id: responseId } }),
        stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `answer ${turn}` } }),
        assistant([{ type: 'text', text: `answer ${turn}` }], `text-frame-${turn}`),
        stream({ type: 'content_block_stop', index: 0 }),
        assistant([{ type: 'text', text: ' full-only tail' }], `tail-frame-${turn}`),
        { type: 'result', subtype: 'success', is_error: false, result: `answer ${turn} full-only tail`,
          session_id: sessionId, uuid: randomUUID(), duration_ms: 1, duration_api_ms: 1, num_turns: 1,
          total_cost_usd: 0, usage: { input_tokens: 4, output_tokens: 5 }, permission_denials: [],
        },
      );
      if (state.toolFrames) {
        pending.splice(1, 0,
          assistant([{ type: 'tool_use', id: `tool-${turn}`, name: 'Read', input: { file_path: '/synthetic' } }], `tool-frame-${turn}`),
          { ...envelope, type: 'user', uuid: randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${turn}`, content: 'tool result' }] } },
        );
      }
      if (state.childFrames) {
        const childEnvelope = { ...envelope, parent_tool_use_id: `parent-${turn}` };
        const childStream = (event: unknown) => ({ ...childEnvelope, type: 'stream_event', uuid: randomUUID(), event });
        const childFull = { ...childEnvelope, type: 'assistant', uuid: `child-frame-${turn}`, message: {
          id: `child-response-${turn}`, role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'child corrected' }],
          usage: { input_tokens: 1, output_tokens: 2 },
        } };
        pending.splice(1, 0,
          assistant([{ type: 'tool_use', id: `parent-${turn}`, name: 'Task', input: { prompt: 'child' } }], `parent-frame-${turn}`),
          childStream({ type: 'message_start', message: { id: `child-response-${turn}` } }),
          childStream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          childStream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child partial' } }),
          childFull, childFull,
          childStream({ type: 'content_block_stop', index: 0 }),
        );
      }
      if (state.exitWithoutResult) pending.pop();
      return { done: false, value: pending.shift() };
    },
    [Symbol.asyncIterator]() { return this; },
    initializationResult: async () => ({ commands: [] }),
    interrupt: async () => undefined,
    close,
    mcpServerStatus: async () => [],
    setModel: async () => undefined,
    setPermissionMode: async () => undefined,
    setMcpServers: async () => undefined,
  };
  return iterator;
}

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'myagents-builtin-v2-'));
  state.events.length = 0;
  state.failProductIo = false;
  state.queuedFollowup = false;
  state.exitWithoutResult = false;
  state.toolFrames = false;
  state.childFrames = false;
  state.media.mockReset().mockResolvedValue([]);
  state.query.mockReset().mockImplementation(fakeQuery);
  state.sdkRead.mockReset().mockResolvedValue([]);
  state.sdkFork.mockReset();
  state.sdkDelete.mockReset().mockResolvedValue(undefined);
  releaseWrite = undefined;
  vi.resetModules();
  store = await import('../SessionStore');
  agent = await import('../agent-session');
});

afterEach(async () => {
  state.failProductIo = false;
  releaseWrite?.();
  vi.restoreAllMocks();
  await agent.resetSession();
  await store.drainSessionTranscripts();
  await rm(state.home, { recursive: true, force: true });
});

describe('builtin V2 execution independent of product storage', () => {
  it('keeps an existing V1 identity on the legacy path when an Inbox-style request allows missing metadata', async () => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const id = randomUUID();
    await store.saveSessionMetadata({ id, agentDir: workspace, title: 'legacy', createdAt: 't', lastActiveAt: 't', runtime: 'builtin' });
    await agent.initializeAgent(workspace, null, id, { preWarmDisabled: true });
    let finish!: (outcome: TurnTerminalOutcome) => void;
    const terminal = new Promise<TurnTerminalOutcome>(resolve => { finish = resolve; });
    const admission = await agent.enqueueUserMessage('Inbox query', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { channelDelivery: NO_CHANNEL_DELIVERY, allowLazySessionMaterialization: true, onTerminal: finish });
    expect(admission.error).toBeUndefined();
    await expect(terminal).resolves.toMatchObject({ status: 'complete' });
    expect(store.getSessionMetadata(id)?.transcriptFormat).toBeUndefined();
    expect(store.getActiveSessionTranscript(id)).toBeUndefined();
    expect((await store.getSessionData(id))?.messages.map(row => row.role)).toEqual(['user', 'assistant']);
  });

  it.each([false, true])('executes first/next query with product EACCES before birth (provider boundary=%s)', async providerBoundary => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    state.failProductIo = true;
    await agent.initializeAgent(workspace, null, undefined, { preWarmDisabled: true });
    for (const prompt of ['first', 'next']) {
      let finish!: (outcome: TurnTerminalOutcome) => void;
      const terminal = new Promise<TurnTerminalOutcome>(resolve => { finish = resolve; });
      const admission = await agent.enqueueUserMessage(prompt, [], undefined, undefined, providerBoundary
        ? { providerId: 'synthetic-provider', baseUrl: 'https://example.invalid', apiKey: 'synthetic-test-key' } : undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: finish });
      expect(admission.error).toBeUndefined();
      await expect(terminal).resolves.toMatchObject({ status: 'complete' });
    }
    const active = store.getActiveSessionTranscript(agent.getSessionId())!;
    expect(active.writer.projection.messages.size).toBe(4);
    expect(await active.writer.flush(100)).toBe(false);
    expect(active.writer.status.state).not.toBe('healthy');
  });

  it('starts a frozen V2 fork without waiting for optional provider route repair', async () => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    // Existing fork snapshots can carry a pinned provider/model without the
    // newer concrete route. Execution resolves it before its metadata repair.
    const metadata = await store.createSession(workspace, {
      runtime: 'builtin', model: 'claude-sonnet-4-6', providerId: 'anthropic-sub',
      configSnapshotAt: new Date().toISOString(),
    });
    const active = store.getActiveSessionTranscript(metadata.id)!;
    vi.spyOn(active.file, 'append').mockImplementation(() => new Promise<void>(resolve => { releaseWrite = resolve; }));
    expect(await active.writer.flush(20)).toBe(false);
    const config = await import('../utils/admin-config');
    expect(config.resolveWorkspaceConfig(workspace, metadata, { includeMcp: false }).providerRoute)
      .toMatchObject({ providerId: 'anthropic-sub', model: 'claude-sonnet-4-6' });
    const repair = vi.spyOn(store, 'updateSessionMetadata');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = (async () => {
        await agent.initializeAgent(workspace, null, metadata.id);
        let finish!: (outcome: TurnTerminalOutcome) => void;
        const terminal = new Promise<TurnTerminalOutcome>(resolve => { finish = resolve; });
        const admission = await agent.enqueueUserMessage('continue fork', [], undefined, undefined, undefined, undefined,
          undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: finish });
        expect(admission.error).toBeUndefined();
        return terminal;
      })();
      await expect(Promise.race([completed, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('AI waited for optional product route repair')), 1_000);
      })])).resolves.toMatchObject({ status: 'complete' });
      expect(repair).toHaveBeenCalledWith(metadata.id, expect.objectContaining({ providerRoute: expect.any(Object) }), expect.any(Function));
      expect(await active.writer.flush(20)).toBe(false);
    } finally { clearTimeout(timeout); }
  });

  it.each([false, true])('preserves acknowledged queue order and exact fork/rewind boundaries (eager=%s)', async eager => {
    state.queuedFollowup = true;
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
    await agent.enqueueUserMessage('first question', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
    await vi.waitFor(() => expect(agent.getLastBuiltinAssistantText()).toBe('answer 2 full-only tail'));
    const rows = agent.getMessages();
    expect(rows.map(row => row.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(rows[1].sdkUuid).toBe('tail-frame-1');
    expect(rows[3].sdkUuid).toBe('tail-frame-2');
    expect(JSON.stringify(rows[1].content)).not.toContain('response-2');
    expect(rows[2]).toMatchObject({ content: 'queued question', sdkUuid: 'queued-followup' });
    const active = store.getActiveSessionTranscript(metadata.id)!;
    expect(await active.writer.flush()).toBe(true);
    expect((await active.file.read()).projection.messages.get(rows[1].id)?.sdkUuid).toBe('tail-frame-1');
    await vi.waitFor(() => expect(agent.isSessionBusy()).toBe(false));
    const config = await import('../utils/admin-config');
    const currentConfig = config.loadConfig();
    vi.spyOn(config, 'loadConfig').mockReturnValue({ ...currentConfig, eagerFork: eager });
    const newSid = randomUUID();
    const sdkRows = rows.filter(row => row.sdkUuid).map(row => ({ type: row.role, uuid: row.sdkUuid! }));
    const sourcePrefix = sdkRows.slice(0, sdkRows.findIndex(row => row.uuid === 'tail-frame-1') + 1);
    state.sdkRead.mockImplementation(async (id: string) => id === newSid
      ? sourcePrefix.map(row => ({ ...row, uuid: `fork-${row.uuid}` })) : sdkRows);
    state.sdkFork.mockResolvedValue({ sessionId: newSid });
    const forked = await agent.forkSession(rows[1].id);
    expect(forked.success).toBe(true);
    const target = (await store.getSessionData(forked.newSessionId!))!;
    expect(target.messages.map(row => row.role)).toEqual(['user', 'assistant']);
    if (eager) {
      expect(state.sdkFork).toHaveBeenCalledWith(metadata.id, expect.objectContaining({ upToMessageId: 'tail-frame-1' }));
      expect(target.messages[1].sdkUuid).toBe('fork-tail-frame-1');
      expect(target.forkFrom).toBeUndefined();
    } else {
      expect(state.sdkFork).not.toHaveBeenCalled();
      expect(target.forkFrom?.messageUuid).toBe('tail-frame-1');
    }
    state.queuedFollowup = false;
    expect(await agent.rewindSession(rows[2].id)).toMatchObject({ success: true });
    expect(agent.getMessages().map(row => row.id)).toEqual(rows.slice(0, 2).map(row => row.id));
    await agent.enqueueUserMessage('after rewind', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, { channelDelivery: NO_CHANNEL_DELIVERY });
    await vi.waitFor(() => expect(state.query).toHaveBeenCalledTimes(2));
    expect(state.query.mock.calls[1][0].options.resumeSessionAt).toBe('tail-frame-1');
  });

  it('keeps partial/full child content under its parent while the root reuses the same stream index', async () => {
    state.childFrames = true;
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
    let finish!: (outcome: TurnTerminalOutcome) => void;
    const terminal = new Promise<TurnTerminalOutcome>(resolve => { finish = resolve; });
    await agent.enqueueUserMessage('question', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: finish });
    await expect(terminal).resolves.toMatchObject({ status: 'complete' });
    const blocks = agent.getMessages().flatMap(message => typeof message.content === 'string' ? [] : message.content);
    expect(blocks.filter(block => block.type === 'text').map(block => block.text)).toEqual(['answer 1', ' full-only tail']);
    expect(blocks.find(block => block.tool?.id === 'parent-1')?.tool?.subagentCalls).toMatchObject([
      { name: 'AgentMessage', result: 'child corrected', isLoading: false },
    ]);
    expect(blocks.find(block => block.tool?.id === 'parent-1')?.tool?.result).toBeUndefined();
    const active = store.getActiveSessionTranscript(metadata.id)!;
    expect(await active.writer.flush()).toBe(true);
    expect((await active.file.read()).projection.messages).toEqual(active.writer.projection.messages);
  });

  it('publishes full-only tools and completes subsequent turns while attachment archiving is hung', async () => {
    state.toolFrames = true;
    state.media.mockImplementation(() => new Promise(resolve => { releaseWrite = () => resolve([]); }));
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
    for (let turn = 1; turn <= 2; turn++) {
      let finish!: (outcome: TurnTerminalOutcome) => void;
      const terminal = new Promise<TurnTerminalOutcome>(resolve => { finish = resolve; });
      await agent.enqueueUserMessage(`question ${turn}`, [], undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined,
        { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: finish });
      await expect(terminal).resolves.toMatchObject({ status: 'complete' });
      expect(state.events).toContainEqual(['chat:tool-use-start', expect.objectContaining({ id: `tool-${turn}`, name: 'Read' })]);
      expect(state.events).toContainEqual(['chat:content-block-stop', expect.objectContaining({ toolId: `tool-${turn}`, input: { file_path: '/synthetic' } })]);
      expect(agent.getMessages().flatMap(message => typeof message.content === 'string' ? [] : message.content)).toContainEqual(expect.objectContaining({ tool: expect.objectContaining({ id: `tool-${turn}`, result: 'tool result' }) }));
    }
    expect(state.media).toHaveBeenCalledTimes(2);
  });

  it('settles an unexpected native exit without waiting for history IO', async () => {
    state.exitWithoutResult = true;
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    const active = store.getActiveSessionTranscript(metadata.id)!;
    vi.spyOn(active.file, 'append').mockRejectedValue(new Error('disk full'));
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
    let resolveTerminal!: (outcome: TurnTerminalOutcome) => void;
    const terminal = new Promise<TurnTerminalOutcome>(resolve => { resolveTerminal = resolve; });
    await agent.enqueueUserMessage('question', [], undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: outcome => { resolveTerminal(outcome); } });
    await expect(terminal).resolves.toMatchObject({ status: 'error', error: 'AI runtime ended before completing this turn' });
    expect([...active.writer.projection.turns.values()]).toMatchObject([{ status: 'error', usage: { inputTokens: 4, outputTokens: 5 } }]);
    expect(agent.getMessages()[1].content).toMatchObject([
      { text: 'answer 1' }, { text: ' full-only tail' }, { text: 'Error: AI runtime ended before completing this turn' },
    ]);
  });

  it.each(['hung', 'full'] as const)('completes current and subsequent native turns with %s history IO', async failure => {
    const workspace = join(state.home, 'workspace');
    await mkdir(workspace);
    const metadata = await store.createSession(workspace, { runtime: 'builtin' });
    const active = store.getActiveSessionTranscript(metadata.id)!;
    if (failure === 'hung') vi.spyOn(active.file, 'append').mockImplementation(() => new Promise<void>(resolve => { releaseWrite = resolve; }));
    else vi.spyOn(active.file, 'append').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    expect(await active.writer.flush(20)).toBe(false);
    expect(active.file.append).toHaveBeenCalled();
    await agent.initializeAgent(workspace, null, metadata.id, { preWarmDisabled: true });
    for (let turn = 1; turn <= 2; turn++) {
      let resolveTerminal!: (outcome: TurnTerminalOutcome) => void;
      const terminal = new Promise<TurnTerminalOutcome>(resolve => { resolveTerminal = resolve; });
      const result = await agent.enqueueUserMessage(`question ${turn}`, [], undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined,
        { channelDelivery: NO_CHANNEL_DELIVERY, onTerminal: outcome => { resolveTerminal(outcome); } });
      expect(result.error).toBeUndefined();
      const outcome = await Promise.race([terminal, new Promise<never>((_, reject) => {
        const timeout = setTimeout(() => reject(new Error('native turn waited for product storage')), 2_000);
        void terminal.finally(() => clearTimeout(timeout));
      })]);
      expect(outcome).toMatchObject({ status: 'complete' });
      expect(agent.getLastBuiltinAssistantText()).toBe(`answer ${turn} full-only tail`);
      expect(store.getSessionMetadata(metadata.id)).toMatchObject({ stats: { messageCount: turn, totalInputTokens: 4 * turn, totalOutputTokens: 5 * turn }, lastMessagePreview: `question ${turn}` });
    }
    expect(agent.getMessages().map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect([...active.writer.projection.turns.values()].map(turn => turn.status)).toEqual(['complete', 'complete']);
    expect(state.events.some(([event]) => event === 'chat:agent-error')).toBe(false);
  });
});
