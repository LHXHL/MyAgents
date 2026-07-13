import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitSessionTermination,
  clearAbortFlag,
  getPreWarmFailCount,
  hasMessageResolver,
  incrementPreWarmFailCount,
  isAbortRequested,
  requestAbort,
  resetLifecycleForTest,
  setQuerySession,
  setSessionProcessing,
  setSessionTerminationPromise,
  snapshotLifecycle,
  waitForMessage,
  wakeGenerator,
} from './lifecycle';
import {
  drainQueuedItems,
  findQueuedItemLocation,
  getQueueStatus,
  moveQueuedItemToFront,
  pushMessage,
  pushPendingMidTurn,
  pushTurnBoundary,
  releaseTurnAdmissionTicket,
  removeQueuedItemByQueueId,
  removeQueuedItemByRequestId,
  rescuePendingMidTurnToMessageFront,
  resetQueueForTest,
  setInFlightQueueItem,
  setTurnAdmissionTicket,
  snapshotQueue,
} from './queue';
import {
  beginTurn,
  clearPendingRequests,
  getCurrentTurnIdentity,
  getCurrentTurnText,
  getPendingRequestIds,
  notifyCurrentTurnTerminal,
  notifyQueuedTurnStopped,
  pushPendingRequest,
  replaceCurrentTurnUsage,
  removePendingRequest,
  resetTurnForTest,
  setCurrentTurnSourceItem,
  snapshotTurn,
  terminalCleanup,
  waitForCurrentTurnTerminalObserver,
  appendCurrentTurnTextBlock,
  setAssistantMessagePresent,
} from './turn';
import {
  applyAgentDefinitionsUpdate,
  applyMcpServersUpdate,
  applyModelUpdate,
  applyProviderEnvUpdate,
  consumePendingProviderHistoryBoundaryReset,
  getCurrentAgentDefinitions,
  drainDeferredRestart,
  getModel,
  getPermissionMode,
  hasDeferredRestart,
  resetConfigForTest,
  scheduleDeferredRestart,
  setCurrentMcpServers,
  setModel,
  setPendingProviderHistoryBoundaryReset,
  setPermissionPlanState,
  snapshotConfig,
} from './config';
import {
  addCurrentSessionUuid,
  bindSdkUuidToLatestUnboundUserMessage,
  bindSdkUuidToMessage,
  clearTranscriptState,
  getCurrentSessionUuids,
  getLastPersistedIndex,
  getMessages,
  nextMessageSequence,
  replaceMessages,
  resetTranscriptForTest,
  setLastPersistedIndex,
  snapshotTranscript,
} from './transcript';
import type { MessageQueueItem } from './types';

function queueItem(id: string, requestId = id): MessageQueueItem {
  return {
    id,
    requestId,
    message: { role: 'user', content: 'hello' },
    messageText: `message ${id}`,
    wasQueued: true,
    resolve: vi.fn(),
  };
}

function pendingItem(id: string, requestId = id) {
  return {
    queueId: id,
    userMessage: { id: `u-${id}`, role: 'user' as const, content: `message ${id}`, timestamp: 'now' },
    sourceItem: queueItem(id, requestId),
  };
}

describe('builtin-session owners', () => {
  beforeEach(() => {
    resetLifecycleForTest();
    resetQueueForTest();
    resetTurnForTest();
    resetConfigForTest();
    resetTranscriptForTest();
  });

  it('lifecycle owns abort flag and wakes the persistent generator', async () => {
    const pending = waitForMessage(() => undefined);
    expect(hasMessageResolver()).toBe(true);

    wakeGenerator(queueItem('q1'));
    await expect(pending).resolves.toMatchObject({ id: 'q1' });
    expect(hasMessageResolver()).toBe(false);

    requestAbort();
    await expect(waitForMessage(() => undefined)).resolves.toBeNull();
    expect(isAbortRequested()).toBe(true);

    clearAbortFlag();
    expect(isAbortRequested()).toBe(false);
  });

  it('lifecycle awaitSessionTermination force-cleans process state on timeout', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    setQuerySession({ close } as never);
    setSessionProcessing(true);
    setSessionTerminationPromise(new Promise(() => undefined));

    const cleanup = vi.fn();
    const result = awaitSessionTermination({
      timeoutMs: 10,
      label: 'unit',
      onTimeoutForceCleanup: cleanup,
    });

    await vi.advanceTimersByTimeAsync(10);
    await result;

    const snapshot = snapshotLifecycle();
    expect(snapshot.querySession).toBeNull();
    expect(snapshot.isProcessing).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('queue owner covers queued pending turn-boundary and in-flight locations', () => {
    pushMessage(queueItem('q1', 'r1'));
    pushPendingMidTurn(pendingItem('q2', 'r2'));
    pushTurnBoundary({ queueId: 'q3', ready: true, messageText: 'turn', requestId: 'r3' });
    setInFlightQueueItem('q4', { messageText: 'flight', requestId: 'r4' });

    expect(findQueuedItemLocation('q1')?.location).toBe('message');
    expect(findQueuedItemLocation('q2')?.location).toBe('pending-mid-turn');
    expect(findQueuedItemLocation('q3')?.location).toBe('turn-boundary');
    expect(findQueuedItemLocation('q4')?.location).toBe('in-flight');

    expect(removeQueuedItemByRequestId('r2').location).toBe('pending-mid-turn');
    expect(removeQueuedItemByQueueId('q3').location).toBe('turn-boundary');
    expect(removeQueuedItemByRequestId('r4').location).toBe('in-flight');
  });

  it('queue owner drains/rescues and keeps admission ticket scoped', () => {
    pushMessage(queueItem('q1'));
    pushPendingMidTurn(pendingItem('q2'));
    pushTurnBoundary({ queueId: 'q3', ready: true, messageText: 'turn' });
    setTurnAdmissionTicket({
      queueId: 'q3',
      createdAt: 1,
      messageText: 'third',
      canceled: false,
    });

    expect(rescuePendingMidTurnToMessageFront()).toBe(1);
    expect(snapshotQueue().messageQueue.map(item => item.id)).toEqual(['q2', 'q1']);
    releaseTurnAdmissionTicket('other');
    expect(snapshotQueue().turnAdmissionTicket?.queueId).toBe('q3');
    releaseTurnAdmissionTicket('q3');
    expect(snapshotQueue().turnAdmissionTicket).toBeNull();

    const drained = drainQueuedItems();
    expect(drained.messages.map(item => item.id)).toEqual(['q2', 'q1']);
    expect(drained.turnBoundary.map(item => item.queueId)).toEqual(['q3']);
    expect(getQueueStatus()).toEqual([]);
  });

  it('queue owner force-start reorders non-in-flight locations', () => {
    pushMessage(queueItem('q1'));
    pushMessage(queueItem('q2'));

    expect(moveQueuedItemToFront('q2')).toEqual({ found: true, isInFlight: false });
    expect(snapshotQueue().messageQueue.map(item => item.id)).toEqual(['q2', 'q1']);
  });

  it('turn owner keeps pending request FIFO and notifies the current queue item once', () => {
    pushPendingRequest('r1');
    pushPendingRequest('r2');
    expect(getPendingRequestIds()).toEqual(['r1', 'r2']);
    expect(removePendingRequest('r2')).toBe(true);
    expect(clearPendingRequests()).toEqual(['r1']);

    const onTerminal = vi.fn();
    const item = queueItem('turn-a');
    item.turnOwner = { kind: 'goal', id: 'goal-1' };
    item.onTerminal = onTerminal;
    beginTurn({ startedAt: 100 });
    replaceCurrentTurnUsage({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    setCurrentTurnSourceItem(item);
    appendCurrentTurnTextBlock('hello');
    setAssistantMessagePresent(true);
    expect(getCurrentTurnIdentity()).toEqual({
      queueId: 'turn-a',
      owner: { kind: 'goal', id: 'goal-1' },
    });
    notifyCurrentTurnTerminal('complete', { durationMs: 3_500 });
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'complete',
      text: 'hello',
      assistantMessagePresent: true,
      durationMs: 3_500,
      usage: { inputTokens: 120, outputTokens: 30 },
    }));
    notifyCurrentTurnTerminal('complete');
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('keeps the terminal boundary closed until an async observer settles', async () => {
    let release!: () => void;
    const item = queueItem('turn-a');
    item.onTerminal = () => new Promise<void>((resolve) => {
      release = resolve;
    });
    setCurrentTurnSourceItem(item);

    notifyCurrentTurnTerminal('complete');
    let settled = false;
    void waitForCurrentTurnTerminalObserver().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await waitForCurrentTurnTerminalObserver();
    expect(settled).toBe(true);
  });

  it('settles a pre-dispatch cancellation exactly once and awaits its observer', async () => {
    let release!: () => void;
    const onTerminal = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const item = queueItem('queued-goal');
    item.onTerminal = onTerminal;

    let settled = false;
    const first = notifyQueuedTurnStopped(item).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith({
      status: 'stopped',
      text: '',
      assistantMessagePresent: false,
      error: 'Queue item was cancelled before dispatch',
    });

    await notifyQueuedTurnStopped(item);
    expect(onTerminal).toHaveBeenCalledOnce();

    release();
    await first;
    expect(settled).toBe(true);
  });

  it('turn owner keeps terminal inbox cleanup local to the active turn', () => {
    beginTurn({
      startedAt: 100,
      inboxMeta: {
        fromSessionId: 's1',
        fromLabel: 'source',
        originalMessageId: 'm1',
        originalSnippet: 'late',
        replyBack: true,
      },
    });
    appendCurrentTurnTextBlock('late');

    expect(getCurrentTurnText()).toBe('late');
    const cleanup = terminalCleanup();
    expect(cleanup.replyText).toBe('late');
    expect(cleanup.inboxMeta?.fromSessionId).toBe('s1');
    expect(snapshotTurn().currentTurnTextBlocks).toEqual([]);
  });

  it('config owner drains deferred restarts and consumes provider boundary once', () => {
    scheduleDeferredRestart('mcp');
    scheduleDeferredRestart('agents');
    expect(hasDeferredRestart()).toBe(true);
    expect(drainDeferredRestart()).toBe('mcp,agents');
    expect(hasDeferredRestart()).toBe(false);

    setModel('claude-test');
    setPermissionPlanState({ permissionMode: 'plan', prePlanPermissionMode: 'auto' });
    setPendingProviderHistoryBoundaryReset(true);
    expect(getModel()).toBe('claude-test');
    expect(getPermissionMode()).toBe('plan');
    expect(snapshotConfig().prePlanPermissionMode).toBe('auto');
    expect(consumePendingProviderHistoryBoundaryReset()).toBe(true);
    expect(consumePendingProviderHistoryBoundaryReset()).toBe(false);
  });

  it('config owner applies policy decisions before state mutation', () => {
    setCurrentMcpServers([{ id: 'old', name: 'old', command: 'node', args: [], type: 'stdio', isBuiltin: false }]);
    const skippedMcp = applyMcpServersUpdate(
      [{ id: 'new', name: 'new', command: 'node', args: [], type: 'stdio', isBuiltin: false }],
      { hasQuerySession: true, isSnapshotted: true },
    );
    expect(skippedMcp).toMatchObject({
      applied: false,
      changed: true,
      shouldRestart: false,
      reason: 'snapshot-authoritative',
    });
    expect(snapshotConfig().mcpServers?.map(server => server.id)).toEqual(['old']);

    const skippedModel = applyModelUpdate('im-model', { source: 'im-sync', isSnapshotted: true });
    expect(skippedModel).toMatchObject({ applied: false, reason: 'snapshot-authoritative' });
    expect(getModel()).toBeUndefined();

    const appliedModel = applyModelUpdate('desktop-model', { source: 'desktop', isSnapshotted: true });
    expect(appliedModel).toMatchObject({ applied: true, oldModel: undefined, newModel: 'desktop-model' });
    expect(getModel()).toBe('desktop-model');

    const skippedProvider = applyProviderEnvUpdate(
      { baseUrl: 'https://channel.example.com', apiKey: 'k' },
      { source: 'im-sync', isSnapshotted: true },
    );
    expect(skippedProvider).toMatchObject({ applied: false, reason: 'snapshot-authoritative' });
    expect(snapshotConfig().providerEnv).toBeUndefined();

    const initialAgents = {
      existing: {
        description: 'existing',
        prompt: 'existing prompt',
        tools: [],
      },
    };
    const nextAgents = {
      changed: {
        description: 'changed',
        prompt: 'changed prompt',
        tools: [],
      },
    };
    expect(applyAgentDefinitionsUpdate(initialAgents, { hasQuerySession: false, isSnapshotted: false }))
      .toMatchObject({ applied: true, reason: 'no-active-session' });
    expect(Object.keys(getCurrentAgentDefinitions() ?? {})).toEqual(['existing']);

    const skippedAgents = applyAgentDefinitionsUpdate(nextAgents, {
      hasQuerySession: true,
      isSnapshotted: true,
    });
    expect(skippedAgents).toMatchObject({
      applied: false,
      changed: true,
      shouldRestart: false,
      reason: 'snapshot-authoritative',
    });
    expect(Object.keys(getCurrentAgentDefinitions() ?? {})).toEqual(['existing']);
  });

  it('transcript owner owns sequence cursor and uuid freshness', () => {
    expect(nextMessageSequence()).toBe(1);
    const assistant = { id: 'm2', role: 'assistant' as const, content: 'hi', timestamp: 'now' };
    replaceMessages([
      { id: 'm1', role: 'user', content: 'hello', timestamp: 'now' },
      assistant,
    ]);
    setLastPersistedIndex(1);
    addCurrentSessionUuid('uuid-1');

    expect(bindSdkUuidToLatestUnboundUserMessage('user-uuid')).toBe('m1');
    expect(bindSdkUuidToMessage(assistant, 'assistant-uuid')).toBe('m2');
    expect(getMessages()).toHaveLength(2);
    expect(getMessages().map(message => message.sdkUuid)).toEqual(['user-uuid', 'assistant-uuid']);
    expect(getLastPersistedIndex()).toBe(1);
    expect(getCurrentSessionUuids().has('uuid-1')).toBe(true);

    clearTranscriptState();
    expect(snapshotTranscript()).toMatchObject({
      messages: [],
      messageSequence: 0,
      lastPersistedIndex: 0,
    });
  });

  it('prewarm fail count is owned by lifecycle', () => {
    expect(getPreWarmFailCount()).toBe(0);
    expect(incrementPreWarmFailCount()).toBe(1);
  });
});
