import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeType } from '../../shared/types/runtime';
import type { DesktopMessageRequest } from '../session-engine/types';
import type {
  AgentRuntime,
  RuntimeProcess,
  SessionStartOptions,
  UnifiedEventCallback,
} from './types';

const broadcastEvents: Array<{ event: string; data: unknown }> = [];

type TurnScript =
  | { kind: 'success'; text: string; includeTool?: boolean; completeDelayMs?: number }
  | { kind: 'failure'; error: string }
  | { kind: 'permission'; requestId: string; textAfterAllow: string; failDelivery?: boolean };

class FakeRuntimeProcess implements RuntimeProcess {
  readonly pid = 4242;
  exited = false;

  async writeLine(): Promise<void> {
    return undefined;
  }

  kill(): void {
    this.exited = true;
  }

  async waitForExit(): Promise<number> {
    this.exited = true;
    return 0;
  }
}

class FakeRuntime implements AgentRuntime {
  readonly type: RuntimeType = 'codex';
  readonly sentMessages: string[] = [];
  readonly steeredMessages: Array<{ message: string; clientUserMessageId?: string }> = [];
  readonly permissionResponses: Array<{ requestId: string; decision: string; reason?: string }> = [];
  steerMessage?: AgentRuntime['steerMessage'];
  private callback: UnifiedEventCallback | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly scripts: TurnScript[], options: { realtimeSteering?: boolean; rejectSteer?: boolean } = {}) {
    if (options.realtimeSteering) {
      this.steerMessage = async (_process, message, _images, steerOptions) => {
        this.steeredMessages.push({ message, clientUserMessageId: steerOptions?.clientUserMessageId });
        if (options.rejectSteer) {
          throw new Error('fake steer rejected');
        }
      };
    }
  }

  emitUserMessageAccepted(clientUserMessageId?: string): void {
    this.emit({ kind: 'user_message_accepted', clientUserMessageId });
  }

  async detect() {
    return { installed: true, version: 'fake-runtime' };
  }

  async queryModels() {
    return [];
  }

  getPermissionModes() {
    return [];
  }

  async startSession(options: SessionStartOptions, onEvent: UnifiedEventCallback): Promise<RuntimeProcess> {
    this.callback = onEvent;
    const process = new FakeRuntimeProcess();
    this.defer(() => {
      this.emit({ kind: 'session_init', sessionId: 'fake-thread-1', model: options.model ?? 'fake-model', tools: ['FakeTool'] });
      if (options.initialMessage) this.playTurn(options.initialMessage);
    });
    return process;
  }

  async sendMessage(_process: RuntimeProcess, message: string): Promise<void> {
    this.playTurn(message);
  }

  async respondPermission(
    _process: RuntimeProcess,
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    reason?: string,
  ): Promise<void> {
    this.permissionResponses.push({ requestId, decision, reason });
    const script = this.scripts[0];
    if (script?.kind === 'permission' && script.failDelivery) {
      throw new Error('permission delivery failed');
    }
    const next = this.scripts.shift();
    if (!next || next.kind !== 'permission') {
      throw new Error(`unexpected permission response for ${requestId}`);
    }
    this.defer(() => this.emitSuccessfulTurn(next.textAfterAllow, false));
  }

  async stopSession(process: RuntimeProcess): Promise<void> {
    process.kill();
  }

  clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private playTurn(message: string): void {
    this.sentMessages.push(message);
    const script = this.scripts.shift() ?? { kind: 'success', text: `echo:${message}` };
    this.defer(() => {
      if (script.kind === 'success') {
        this.emitSuccessfulTurn(script.text, Boolean(script.includeTool), script.completeDelayMs);
        return;
      }
      if (script.kind === 'failure') {
        this.emit({
          kind: 'turn_complete',
          status: 'failed',
          error: script.error,
        });
        return;
      }
      this.scripts.unshift(script);
      this.emit({
        kind: 'permission_request',
        requestId: script.requestId,
        toolName: 'Edit',
        toolUseId: 'tool-permission',
        input: { file: 'notes.md' },
        suggestions: [{ toolName: 'Edit' }],
      });
    });
  }

  private emitSuccessfulTurn(text: string, includeTool: boolean, completeDelayMs = 0): void {
    this.emit({ kind: 'text_delta', text });
    if (includeTool) {
      this.emit({
        kind: 'tool_use_start',
        toolUseId: 'tool-1',
        toolName: 'FakeTool',
        input: { value: 1 },
      });
      this.emit({ kind: 'tool_use_stop', toolUseId: 'tool-1' });
      this.emit({ kind: 'tool_result', toolUseId: 'tool-1', content: 'tool ok' });
    }
    this.emit({ kind: 'text_stop' });
    this.defer(() => {
      this.emit({ kind: 'turn_complete', status: 'success', result: text });
    }, completeDelayMs);
  }

  private emit(event: Parameters<UnifiedEventCallback>[0]): void {
    if (!this.callback) throw new Error('fake runtime callback not installed');
    this.callback(event);
  }

  private defer(fn: () => void, delayMs = 0): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, delayMs);
    this.timers.add(timer);
  }
}

interface Harness {
  home: string;
  runtime: FakeRuntime;
  engine: Awaited<ReturnType<typeof import('../session-engine').getSessionEngine>>;
  externalSession: typeof import('./external-session');
  sessionStore: typeof import('../SessionStore');
}

let activeHarness: Harness | null = null;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousRuntime: string | undefined;

async function createHarness(
  scripts: TurnScript[],
  options: { realtimeSteering?: boolean; rejectSteer?: boolean; config?: Record<string, unknown> } = {},
): Promise<Harness> {
  vi.resetModules();
  const home = mkdtempSync(join(tmpdir(), 'myagents-external-mock-'));
  mkdirSync(join(home, '.myagents'), { recursive: true });
  if (options.config) {
    writeFileSync(join(home, '.myagents', 'config.json'), JSON.stringify(options.config));
  }
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousRuntime = process.env.MYAGENTS_RUNTIME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.MYAGENTS_RUNTIME = 'codex';

  const runtime = new FakeRuntime(scripts, {
    realtimeSteering: options.realtimeSteering,
    rejectSteer: options.rejectSteer,
  });
  vi.doMock('./factory', () => ({
    getCurrentRuntimeSource: () => 'system-cli',
    getCurrentRuntimeType: () => 'codex',
    getExternalRuntime: () => runtime,
    isExternalRuntime: (type: RuntimeType | undefined) => Boolean(type && type !== 'builtin'),
    isRuntimeSupported: () => true,
  }));
  vi.doMock('../sse', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../sse')>();
    return {
      ...actual,
      broadcast: (event: string, data: unknown) => {
        broadcastEvents.push({ event, data });
      },
    };
  });

  const [{ getSessionEngine }, externalSession, sessionStore] = await Promise.all([
    import('../session-engine'),
    import('./external-session'),
    import('../SessionStore'),
  ]);
  externalSession.__resetExternalSessionForTests();
  activeHarness = { home, runtime, engine: getSessionEngine(), externalSession, sessionStore };
  return activeHarness;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function restoreEnv(): void {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousRuntime === undefined) delete process.env.MYAGENTS_RUNTIME;
  else process.env.MYAGENTS_RUNTIME = previousRuntime;
  broadcastEvents.length = 0;
}

afterEach(async () => {
  const harness = activeHarness;
  activeHarness = null;
  if (harness) {
    harness.runtime.clearTimers();
    try {
      await harness.externalSession.stopExternalSession();
    } catch {
      // Test cleanup should not mask the assertion failure.
    }
    harness.externalSession.__resetExternalSessionForTests();
    rmSync(harness.home, { recursive: true, force: true });
  }
  restoreEnv();
  vi.doUnmock('./factory');
  vi.doUnmock('../sse');
});

function desktopRequest(sessionId: string, workspacePath: string, text: string): DesktopMessageRequest {
  return {
    text,
    images: [],
    permissionMode: 'fullAgency',
    model: 'gpt-5-codex',
    reasoningEffort: 'medium',
    sessionId,
    workspacePath,
    scenario: { type: 'desktop' } as const,
    analyticsSource: 'desktop' as const,
  };
}

describe('external SessionEngine with fake runtime', () => {
  it('persists a normal external turn and exposes live overlay plus latest result', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'first fake answer', includeTool: true, completeDelayMs: 40 },
    ]);
    const sessionId = 'session-normal';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'hello'));
    await waitFor(
      () => harness.engine.getLiveSessionOverlay(sessionId).liveStreamingMessage?.content.includes('first fake answer') ?? false,
      'live assistant overlay',
    );

    const live = harness.engine.getLiveSessionOverlay(sessionId);
    expect(live.isActive).toBe(true);
    expect(live.liveStreamingMessage?.content).toContain('first fake answer');

    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    expect(harness.engine.getLatestAssistantResult()).toEqual({
      sessionId,
      latestResult: 'first fake answer',
    });

    const persisted = harness.sessionStore.getSessionData(sessionId);
    expect(persisted?.messages.some((message) => (
      message.role === 'assistant' && message.content.includes('first fake answer')
    ))).toBe(true);
    expect(persisted?.messages.some((message) => (
      message.role === 'assistant' && message.content.includes('FakeTool')
    ))).toBe(true);
  });

  it('does not report failed injected turns as successful', async () => {
    const harness = await createHarness([
      { kind: 'failure', error: 'fake turn failed' },
    ]);
    const sessionId = 'session-failure';

    const result = await harness.engine.runInjectedTurn({
      prompt: 'run sync job',
      sessionId,
      workspacePath: join(harness.home, 'workspace'),
      scenario: { type: 'cron', taskId: 'cron-phase9', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 2_000,
      pollMs: 10,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
    });
    expect(result.error).toContain('External runtime turn failed');
    expect(harness.engine.getLatestAssistantResult().latestResult).not.toContain('fake turn failed');
  });

  it('queues a second desktop send until the current external turn reaches a boundary', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'first queued answer', completeDelayMs: 80 },
      { kind: 'success', text: 'second queued answer' },
    ]);
    const sessionId = 'session-queue';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'first'));
    await waitFor(() => harness.runtime.sentMessages.includes('first'), 'first dispatch');
    const second = await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'second'));

    expect(second.queued).toBe(true);
    expect(second.queueId).toBeDefined();
    expect(harness.runtime.sentMessages).toEqual(['first']);

    await waitFor(() => harness.runtime.sentMessages.includes('second'), 'queued second dispatch');
    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    expect(harness.runtime.sentMessages).toEqual(['first', 'second']);
    expect(harness.engine.getLatestAssistantResult().latestResult).toBe('second queued answer');
  });

  it('steers a second desktop send into the active Codex turn in realtime mode', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'single steered answer', completeDelayMs: 300 },
    ], { realtimeSteering: true });
    const sessionId = 'session-realtime-steer';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'first'));
    await waitFor(() => harness.runtime.sentMessages.includes('first'), 'first dispatch');
    const second = await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'second'));

    expect(second).toMatchObject({
      success: true,
      queued: true,
      isInFlight: true,
      deliveryMode: 'realtime',
    });
    await waitFor(() => harness.runtime.steeredMessages.length === 1, 'realtime steer dispatch');

    expect(harness.runtime.sentMessages).toEqual(['first']);
    expect(harness.runtime.steeredMessages[0]).toMatchObject({ message: 'second' });
    expect(broadcastEvents.find(
      (item) => item.event === 'queue:started'
        && (item.data as { userMessage?: { content?: string } }).userMessage?.content === 'second',
    )).toBeUndefined();

    harness.runtime.emitUserMessageAccepted(harness.runtime.steeredMessages[0].clientUserMessageId);
    await waitFor(
      () => broadcastEvents.some(
        (item) => item.event === 'queue:started'
          && (item.data as { userMessage?: { content?: string } }).userMessage?.content === 'second',
      ),
      'runtime user-message accepted',
    );
    const started = broadcastEvents.find(
      (item) => item.event === 'queue:started'
        && (item.data as { userMessage?: { content?: string } }).userMessage?.content === 'second',
    );
    expect(started?.data).toMatchObject({
      midTurnBreak: true,
      userMessage: { content: 'second' },
    });

    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    const persisted = harness.sessionStore.getSessionData(sessionId);
    expect(persisted?.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([
      'first',
      'second',
    ]);
    expect(persisted?.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(harness.engine.getLatestAssistantResult().latestResult).toBe('single steered answer');
  });

  it('does not split the active stream when realtime Codex steering is rejected', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'answer after rejected steer', completeDelayMs: 80 },
    ], {
      realtimeSteering: true,
      rejectSteer: true,
    });
    const sessionId = 'session-realtime-steer-rejected';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'first'));
    await waitFor(() => harness.runtime.sentMessages.includes('first'), 'first dispatch');
    const second = await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'second'));

    expect(second).toMatchObject({
      success: true,
      queued: true,
      isInFlight: true,
      deliveryMode: 'realtime',
    });
    await waitFor(() => harness.runtime.steeredMessages.length === 1, 'rejected realtime steer dispatch');
    expect(harness.runtime.steeredMessages[0]).toMatchObject({ message: 'second' });
    await waitFor(
      () => broadcastEvents.some((item) => item.event === 'chat:agent-error'),
      'rejected realtime steer error broadcast',
    );
    const started = broadcastEvents.find(
      (item) => item.event === 'queue:started'
        && (item.data as { userMessage?: { content?: string } }).userMessage?.content === 'second',
    );
    expect(started).toBeUndefined();
    await waitFor(
      () => broadcastEvents.some(
        (item) => item.event === 'queue:cancelled'
          && (item.data as { queueId?: string }).queueId === second.queueId,
      ),
      'rejected realtime steer queue cancellation',
    );

    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    const persisted = harness.sessionStore.getSessionData(sessionId);
    expect(persisted?.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([
      'first',
    ]);
    expect(harness.engine.getLatestAssistantResult().latestResult).toBe('answer after rejected steer');
  });

  it('keeps Codex steering-capable runtimes on turn boundaries when configured for turn response', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'first turn-mode answer', completeDelayMs: 80 },
      { kind: 'success', text: 'second turn-mode answer' },
    ], {
      realtimeSteering: true,
      config: { chatQueueResponseMode: 'turn' },
    });
    const sessionId = 'session-turn-mode';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'first'));
    await waitFor(() => harness.runtime.sentMessages.includes('first'), 'first dispatch');
    const second = await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'second'));

    expect(second).toMatchObject({
      success: true,
      queued: true,
      deliveryMode: 'turn',
    });
    expect(harness.runtime.steeredMessages).toEqual([]);
    expect(harness.runtime.sentMessages).toEqual(['first']);

    await waitFor(() => harness.runtime.sentMessages.includes('second'), 'turn-mode queued dispatch');
    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    expect(harness.runtime.sentMessages).toEqual(['first', 'second']);
  });

  it('keeps permission pending until runtime delivery succeeds', async () => {
    const harness = await createHarness([
      { kind: 'permission', requestId: 'perm-ok', textAfterAllow: 'permission approved answer' },
    ]);
    const sessionId = 'session-permission';

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, join(harness.home, 'workspace'), 'needs permission'));
    await waitFor(
      () => harness.engine.getStreamReplaySnapshot().pendingInteractiveRequests.length === 1,
      'permission pending',
    );
    expect(harness.engine.getStreamReplaySnapshot().pendingInteractiveRequests[0]).toMatchObject({
      type: 'permission:request',
      data: { requestId: 'perm-ok' },
    });

    await expect(harness.engine.respondPermission('perm-ok', 'allow_once')).resolves.toBe(true);
    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);

    expect(harness.runtime.permissionResponses).toEqual([
      { requestId: 'perm-ok', decision: 'allow_once', reason: undefined },
    ]);
    expect(harness.engine.getStreamReplaySnapshot().pendingInteractiveRequests).toHaveLength(0);
    expect(harness.engine.getLatestAssistantResult().latestResult).toBe('permission approved answer');
  });

  it('preserves permission pending state when runtime delivery fails', async () => {
    const harness = await createHarness([
      {
        kind: 'permission',
        requestId: 'perm-fail',
        textAfterAllow: 'unreachable',
        failDelivery: true,
      },
    ]);

    await harness.engine.sendDesktopMessage(desktopRequest('session-permission-fail', join(harness.home, 'workspace'), 'needs permission'));
    await waitFor(
      () => harness.engine.getStreamReplaySnapshot().pendingInteractiveRequests.length === 1,
      'permission pending before failed delivery',
    );

    await expect(harness.engine.respondPermission('perm-fail', 'always_allow')).rejects.toThrow('permission delivery failed');
    expect(harness.engine.getStreamReplaySnapshot().pendingInteractiveRequests).toHaveLength(1);
  });
});
