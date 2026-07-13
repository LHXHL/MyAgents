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
  | {
    kind: 'success';
    text: string;
    includeTool?: boolean;
    completeDelayMs?: number;
    usage?: { inputTokens: number; outputTokens: number };
  }
  | {
    kind: 'failure';
    error: string;
    usage?: { inputTokens: number; outputTokens: number };
  }
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
  readonly startSessionInitialMessages: Array<string | undefined> = [];
  readonly steeredMessages: Array<{ message: string; clientUserMessageId?: string }> = [];
  readonly permissionResponses: Array<{ requestId: string; decision: string; reason?: string }> = [];
  steerMessage?: AgentRuntime['steerMessage'];
  private callback: UnifiedEventCallback | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private startGate: Promise<void> | null = null;
  private releaseStartGate: (() => void) | null = null;
  private rejectDispatchAck: boolean;
  private rejectStop: boolean;

  constructor(private readonly scripts: TurnScript[], options: {
    realtimeSteering?: boolean;
    rejectSteer?: boolean;
    deferStart?: boolean;
    rejectDispatchAck?: boolean;
    rejectStop?: boolean;
  } = {}) {
    this.rejectDispatchAck = options.rejectDispatchAck === true;
    this.rejectStop = options.rejectStop === true;
    if (options.realtimeSteering) {
      this.steerMessage = async (_process, message, _images, steerOptions) => {
        this.steeredMessages.push({ message, clientUserMessageId: steerOptions?.clientUserMessageId });
        if (options.rejectSteer) {
          throw new Error('fake steer rejected');
        }
      };
    }
    if (options.deferStart) this.deferNextStart();
  }

  deferNextStart(): void {
    this.startGate = new Promise<void>((resolve) => {
      this.releaseStartGate = resolve;
    });
  }

  releaseStart(): void {
    this.releaseStartGate?.();
    this.releaseStartGate = null;
  }

  allowStop(): void {
    this.rejectStop = false;
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
    this.startSessionInitialMessages.push(options.initialMessage);
    const gate = this.startGate;
    if (gate) {
      await gate;
      if (this.startGate === gate) this.startGate = null;
    }
    this.callback = onEvent;
    const process = new FakeRuntimeProcess();
    this.defer(() => {
      this.emit({ kind: 'session_init', sessionId: 'fake-thread-1', model: options.model ?? 'fake-model', tools: ['FakeTool'] });
      if (options.initialMessage) this.playTurn(options.initialMessage);
    });
    return process;
  }

  async sendMessage(_process: RuntimeProcess, message: string): Promise<void> {
    if (this.rejectDispatchAck) {
      this.sentMessages.push(message);
      throw new Error('fake dispatch acknowledgement lost');
    }
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
    if (this.rejectStop) throw new Error('fake stop did not terminate process');
    process.kill();
  }

  clearTimers(): void {
    this.releaseStart();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private playTurn(message: string): void {
    this.sentMessages.push(message);
    const script = this.scripts.shift() ?? { kind: 'success', text: `echo:${message}` };
    this.defer(() => {
      if (script.kind === 'success') {
        this.emitSuccessfulTurn(
          script.text,
          Boolean(script.includeTool),
          script.completeDelayMs,
          script.usage,
        );
        return;
      }
      if (script.kind === 'failure') {
        if (script.usage) {
          this.emit({ kind: 'usage', ...script.usage, semantics: 'delta' });
        }
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

  private emitSuccessfulTurn(
    text: string,
    includeTool: boolean,
    completeDelayMs = 0,
    usage?: { inputTokens: number; outputTokens: number },
  ): void {
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
    if (usage) {
      this.emit({ kind: 'usage', ...usage, semantics: 'delta' });
    }
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
  options: {
    realtimeSteering?: boolean;
    rejectSteer?: boolean;
    deferStart?: boolean;
    unconfirmedDispatchStop?: boolean;
    config?: Record<string, unknown>;
  } = {},
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
    deferStart: options.deferStart,
    rejectDispatchAck: options.unconfirmedDispatchStop,
    rejectStop: options.unconfirmedDispatchStop,
  });
  if (options.unconfirmedDispatchStop) {
    vi.doMock('./utils/kill-with-escalation', () => ({
      killWithEscalation: vi.fn(async () => ({
        exited: false,
        signalUsed: 'hard' as const,
        orphanRisk: true,
        elapsedMs: 0,
      })),
    }));
  }
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
  vi.doUnmock('./utils/kill-with-escalation');
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
  it('treats an idle pre-warmed persistent process as turn-idle', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-prewarm-idle';
    const workspacePath = join(harness.home, 'workspace');

    await expect(harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    })).resolves.toEqual({ prewarmed: true });

    await expect(harness.engine.waitIdle(100, 10)).resolves.toBe(true);
    expect(harness.engine.isBusy()).toBe(false);
    expect(harness.engine.getLiveSessionState()).toMatchObject({
      sessionState: 'idle',
      isBusy: false,
    });
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(true);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it('rejects a stale Goal turn after pre-warm without surfacing or persisting it', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-prewarm-stale-goal';
    const workspacePath = join(harness.home, 'workspace');
    const prompt = 'stale automatic Goal turn';
    const beforeDispatch = vi.fn(async () => ({
      accepted: false,
      code: 'terminal',
      error: 'Goal is no longer active',
    }));

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
    });
    broadcastEvents.length = 0;

    const result = await harness.engine.runInjectedTurn({
      prompt,
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: 'goal-stale', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 500,
      pollMs: 10,
      beforeDispatch,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: false,
      error: 'Goal is no longer active',
    });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(broadcastEvents.some((item) => (
      item.event === 'chat:message-replay'
        && (item.data as { message?: { content?: string } }).message?.content === prompt
    ))).toBe(false);
    expect(harness.sessionStore.getSessionData(sessionId)?.messages ?? []).toEqual([]);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(true);
  });

  it('rejects a stale Goal turn before a fresh external process has any side effects', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-fresh-stale-goal';
    const workspacePath = join(harness.home, 'workspace');
    const prompt = 'stale fresh Goal turn';

    const result = await harness.engine.runInjectedTurn({
      prompt,
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: 'goal-fresh-stale', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 500,
      pollMs: 10,
      beforeDispatch: async () => ({ accepted: false, code: 'terminal', error: 'Goal is paused' }),
    });

    expect(result).toMatchObject({ success: false, enqueued: false, error: 'Goal is paused' });
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(broadcastEvents.some((item) => (
      item.event === 'chat:message-replay'
        && (item.data as { message?: { content?: string } }).message?.content === prompt
    ))).toBe(false);
    expect(harness.sessionStore.getSessionData(sessionId)).toBeNull();
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(false);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it('keeps a guarded promotion busy and lets Stop invalidate it before dispatch', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-promotion-stop';
    const workspacePath = join(harness.home, 'workspace');
    let resolveGuard!: (value: { accepted: true }) => void;
    const guardResult = new Promise<{ accepted: true }>((resolve) => {
      resolveGuard = resolve;
    });
    const beforeDispatch = vi.fn(() => guardResult);

    const run = harness.engine.runInjectedTurn({
      prompt: 'must be canceled before dispatch',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: 'goal-promotion-stop', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 500,
      pollMs: 10,
      beforeDispatch,
    });
    await waitFor(() => beforeDispatch.mock.calls.length === 1, 'Goal dispatch guard');

    expect(harness.engine.isBusy()).toBe(true);
    await expect(harness.engine.waitIdle(30, 5)).resolves.toBe(false);
    await expect(harness.engine.stopTurn()).resolves.toEqual({ success: true, alreadyStopped: false });
    resolveGuard({ accepted: true });

    await expect(run).resolves.toMatchObject({ success: false, enqueued: false });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(harness.sessionStore.getSessionData(sessionId)).toBeNull();
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it('starts a guarded fresh runtime idle so Stop can win during startup', async () => {
    const harness = await createHarness([], { deferStart: true });
    const sessionId = 'session-fresh-start-stop';
    const workspacePath = join(harness.home, 'workspace');
    const beforeDispatch = vi.fn(async () => ({ accepted: true }));

    const run = harness.engine.runInjectedTurn({
      prompt: 'must not enter opaque startSession transport',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: 'goal-fresh-start-stop', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 1_000,
      pollMs: 10,
      beforeDispatch,
    });
    await waitFor(
      () => harness.runtime.startSessionInitialMessages.length === 1,
      'guarded idle runtime startup',
    );

    expect(harness.runtime.startSessionInitialMessages).toEqual([undefined]);
    expect(harness.engine.isBusy()).toBe(true);
    const stop = harness.engine.stopTurn();
    harness.runtime.releaseStart();
    await expect(stop).resolves.toEqual({ success: true, alreadyStopped: false });

    await expect(run).resolves.toMatchObject({ success: false, enqueued: false });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(false);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it('does not confirm Stop when a canceled fresh startup process cannot be terminated', async () => {
    const harness = await createHarness([], {
      deferStart: true,
      unconfirmedDispatchStop: true,
    });
    const sessionId = 'session-fresh-start-stop-unconfirmed';
    const workspacePath = join(harness.home, 'workspace');
    const queueId = 'task-fresh-start-stop-unconfirmed';
    const owner = { kind: 'task' as const, id: 'task-start-stop-unconfirmed' };

    const run = harness.engine.runInjectedTurn({
      prompt: 'must remain addressable until termination is confirmed',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: owner.id, intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 1_000,
      pollMs: 10,
      queueId,
      turnOwner: owner,
      beforeDispatch: async () => ({ accepted: true }),
    });
    await waitFor(
      () => harness.runtime.startSessionInitialMessages.length === 1,
      'guarded runtime startup before failed Stop',
    );

    const stop = harness.engine.stopTurn();
    harness.runtime.releaseStart();
    await expect(stop).resolves.toEqual({
      success: false,
      error: 'External runtime process did not stop',
    });
    await expect(run).resolves.toMatchObject({
      success: false,
      enqueued: true,
      terminationUnconfirmed: true,
    });
    expect(harness.externalSession.getExternalCurrentTurnIdentity()).toEqual({ queueId, owner });

    harness.runtime.allowStop();
    await expect(harness.engine.stopOwnedTurn(owner)).resolves.toEqual({
      success: true,
      alreadyStopped: false,
    });
    expect(harness.externalSession.getExternalCurrentTurnIdentity()).toBeNull();
  });

  it('preserves and drains later external work when exact Stop cancels guarded startup', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'later turn completed' },
    ], { deferStart: true });
    const sessionId = 'session-exact-stop-preserve-queue';
    const workspacePath = join(harness.home, 'workspace');

    const taskRun = harness.engine.runInjectedTurn({
      prompt: 'task turn canceled during startup',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: 'task-1', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 1_000,
      pollMs: 10,
      queueId: 'task-turn-1',
      turnOwner: { kind: 'task', id: 'task-1' },
      beforeDispatch: async () => ({ accepted: true }),
    });
    await waitFor(
      () => harness.runtime.startSessionInitialMessages.length === 1,
      'guarded Task runtime startup',
    );

    const later = await harness.engine.sendDesktopMessage(
      desktopRequest(sessionId, workspacePath, 'later desktop turn'),
    );
    expect(later.queued).toBe(true);
    const stop = harness.engine.stopTurn({ preserveQueue: true });
    harness.runtime.releaseStart();
    await expect(stop).resolves.toEqual({
      success: true,
      alreadyStopped: false,
    });

    await expect(taskRun).resolves.toMatchObject({ success: false, enqueued: false });
    await waitFor(
      () => harness.runtime.sentMessages.includes('later desktop turn'),
      'preserved external queue drain',
    );
    expect(harness.runtime.sentMessages).toEqual(['later desktop turn']);
  });

  it('does not dispatch a pre-warmed Goal turn when Stop wins after guard acceptance', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-prewarm-accepted-stop';
    const workspacePath = join(harness.home, 'workspace');
    let stopPromise: Promise<unknown> | null = null;
    const beforeDispatch = vi.fn(async () => {
      queueMicrotask(() => {
        stopPromise = harness.engine.stopTurn();
      });
      return { accepted: true };
    });

    await harness.externalSession.prewarmExternalSession({
      sessionId,
      workspacePath,
      scenario: { type: 'desktop' },
    });
    broadcastEvents.length = 0;
    const result = await harness.engine.runInjectedTurn({
      prompt: 'accepted but stopped Goal turn',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: 'goal-accepted-stop', intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 500,
      pollMs: 10,
      beforeDispatch,
    });
    await stopPromise;

    expect(result).toMatchObject({ success: false, enqueued: false });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(broadcastEvents.some((item) => (
      item.event === 'chat:message-replay'
        && (item.data as { message?: { content?: string } }).message?.content === 'accepted but stopped Goal turn'
    ))).toBe(false);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
  });

  it.each([
    { path: 'fresh start', prewarm: false },
    { path: 'active pre-warmed process', prewarm: true },
  ])('retains exact ownership after a lost dispatch acknowledgement on $path', async ({ prewarm }) => {
    const harness = await createHarness([], { unconfirmedDispatchStop: true });
    const sessionId = `session-dispatch-ambiguous-${prewarm ? 'prewarm' : 'fresh'}`;
    const workspacePath = join(harness.home, 'workspace');
    const queueId = `task-dispatch-ambiguous-${prewarm ? 'prewarm' : 'fresh'}`;
    const owner = { kind: 'task' as const, id: 'task-dispatch-ambiguous' };

    if (prewarm) {
      await harness.externalSession.prewarmExternalSession({
        sessionId,
        workspacePath,
        scenario: { type: 'desktop' },
      });
    }

    const result = await harness.engine.runInjectedTurn({
      prompt: 'possibly consumed task turn',
      sessionId,
      workspacePath,
      scenario: { type: 'cron', taskId: owner.id, intervalMinutes: 15, aiCanExit: false },
      timeoutMs: 1_000,
      pollMs: 10,
      queueId,
      turnOwner: owner,
      beforeDispatch: async () => ({ accepted: true }),
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      terminationUnconfirmed: true,
      status: 503,
    });
    expect(harness.runtime.sentMessages).toEqual(['possibly consumed task turn']);
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(true);
    expect(harness.externalSession.getExternalCurrentTurnIdentity()).toEqual({ queueId, owner });

    harness.runtime.allowStop();
    await expect(harness.engine.stopOwnedTurn(owner)).resolves.toEqual({
      success: true,
      alreadyStopped: false,
    });
    expect(harness.externalSession.hasExternalRuntimeProcess()).toBe(false);
    expect(harness.externalSession.getExternalCurrentTurnIdentity()).toBeNull();
  });

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
    expect(broadcastEvents).toContainEqual(expect.objectContaining({
      event: 'chat:message-replay',
      data: expect.objectContaining({
        replayKind: 'live-user-echo',
        sessionId,
        message: expect.objectContaining({ role: 'user', content: 'hello' }),
      }),
    }));
  });

  it('materializes a birth-pending Agent Channel session through an injected turn', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'cron relay ready' },
    ]);
    const sessionId = 'session-agent-channel-birth-pending';
    const workspacePath = join(harness.home, 'workspace');

    const result = await harness.engine.runInjectedTurn({
      prompt: 'relay cron completion',
      sessionId,
      workspacePath,
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      metadataBirthPending: true,
      timeoutMs: 2_000,
      pollMs: 10,
    });

    expect(result).toMatchObject({
      success: true,
      enqueued: true,
      text: 'cron relay ready',
    });
    expect(harness.runtime.sentMessages).toEqual(['relay cron completion']);
    expect(harness.sessionStore.getSessionData(sessionId)).toMatchObject({
      id: sessionId,
      agentDir: workspacePath,
    });
  });

  it('keeps missing Agent Channel metadata fail-closed without Router birth authority', async () => {
    const harness = await createHarness([]);
    const sessionId = 'session-agent-channel-without-birth';
    const workspacePath = join(harness.home, 'workspace');

    const result = await harness.engine.runInjectedTurn({
      prompt: 'must not recreate deleted session',
      sessionId,
      workspacePath,
      scenario: { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      timeoutMs: 2_000,
      pollMs: 10,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: false,
      error: expect.stringContaining('Refusing to create missing metadata'),
    });
    expect(harness.runtime.sentMessages).toEqual([]);
    expect(harness.sessionStore.getSessionData(sessionId)).toBeNull();
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
    expect(result.error).toContain('fake turn failed');
    expect(harness.engine.getLatestAssistantResult().latestResult).not.toContain('fake turn failed');
  });

  it('forwards external failure metrics to the injected-turn terminal observer', async () => {
    const harness = await createHarness([
      {
        kind: 'failure',
        error: 'measured failure',
        usage: { inputTokens: 450, outputTokens: 30 },
      },
    ]);
    const onTerminal = vi.fn();

    await harness.engine.runInjectedTurn({
      prompt: 'failing measured Goal turn',
      sessionId: 'session-measured-failure',
      workspacePath: join(harness.home, 'workspace'),
      scenario: { type: 'desktop', surface: 'chat' },
      timeoutMs: 2_000,
      pollMs: 10,
      turnOwner: { kind: 'goal', id: 'goal-1' },
      onTerminal,
    });

    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      durationMs: expect.any(Number),
      usage: { inputTokens: 450, outputTokens: 30 },
      error: 'measured failure',
    }));
  });

  it('forwards normalized external turn metrics to the injected-turn terminal observer', async () => {
    const harness = await createHarness([
      {
        kind: 'success',
        text: 'measured answer',
        usage: { inputTokens: 900, outputTokens: 120 },
      },
    ]);
    const onTerminal = vi.fn();

    await harness.engine.runInjectedTurn({
      prompt: 'measured Goal turn',
      sessionId: 'session-measured-goal',
      workspacePath: join(harness.home, 'workspace'),
      scenario: { type: 'desktop', surface: 'chat' },
      timeoutMs: 2_000,
      pollMs: 10,
      turnOwner: { kind: 'goal', id: 'goal-1' },
      onTerminal,
    });

    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'complete',
      durationMs: expect.any(Number),
      usage: { inputTokens: 900, outputTokens: 120 },
    }));
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
    let dispatchAccepted = false;
    void second.dispatchAcceptance?.then(() => { dispatchAccepted = true; });
    await Promise.resolve();
    expect(dispatchAccepted).toBe(false);

    await waitFor(() => harness.runtime.sentMessages.includes('second'), 'queued second dispatch');
    await expect(second.dispatchAcceptance).resolves.toEqual({ accepted: true });
    await expect(harness.engine.waitIdle(2_000, 10)).resolves.toBe(true);
    expect(harness.runtime.sentMessages).toEqual(['first', 'second']);
    expect(harness.engine.getLatestAssistantResult().latestResult).toBe('second queued answer');
  });

  it('rejects a stale Goal admission at queued promotion without runtime dispatch', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'first answer', completeDelayMs: 80 },
    ]);
    const sessionId = 'session-goal-gate';
    const workspacePath = join(harness.home, 'workspace');

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'first'));
    await waitFor(() => harness.runtime.sentMessages.includes('first'), 'first dispatch');
    const second = await harness.engine.sendDesktopMessage({
      ...desktopRequest(sessionId, workspacePath, 'stale Goal turn'),
      beforeDispatch: async () => ({ accepted: false, code: 'terminal', error: 'Goal is terminal' }),
    });

    expect(second.queueId).toBeDefined();
    await expect(second.dispatchAcceptance).resolves.toEqual({
      accepted: false,
      error: 'Goal is terminal',
    });
    expect(harness.runtime.sentMessages).toEqual(['first']);
    expect(broadcastEvents.some((item) => (
      item.event === 'queue:started'
        && (item.data as { userMessage?: { content?: string } }).userMessage?.content === 'stale Goal turn'
    ))).toBe(false);
    expect(harness.sessionStore.getSessionData(sessionId)?.messages.filter(
      (message) => message.role === 'user',
    ).map((message) => message.content)).toEqual(['first']);
  });

  it('cancels a queued Goal promotion when Stop wins after guard acceptance', async () => {
    const harness = await createHarness([
      { kind: 'success', text: 'first answer', completeDelayMs: 80 },
    ]);
    const sessionId = 'session-queued-goal-stop';
    const workspacePath = join(harness.home, 'workspace');
    let stopPromise: Promise<unknown> | null = null;
    const beforeDispatch = vi.fn(async () => {
      queueMicrotask(() => {
        stopPromise = harness.engine.stopTurn();
      });
      return { accepted: true };
    });

    await harness.engine.sendDesktopMessage(desktopRequest(sessionId, workspacePath, 'first'));
    await waitFor(() => harness.runtime.sentMessages.includes('first'), 'first dispatch');
    const second = await harness.engine.sendDesktopMessage({
      ...desktopRequest(sessionId, workspacePath, 'queued Goal turn'),
      beforeDispatch,
    });

    await expect(second.dispatchAcceptance).resolves.toEqual({ accepted: false });
    await stopPromise;
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(harness.runtime.sentMessages).toEqual(['first']);
    expect(broadcastEvents.some((item) => (
      item.event === 'queue:started'
        && (item.data as { userMessage?: { content?: string } }).userMessage?.content === 'queued Goal turn'
    ))).toBe(false);
    expect(harness.externalSession.getExternalSessionState()).toBe('idle');
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
      sessionId,
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
