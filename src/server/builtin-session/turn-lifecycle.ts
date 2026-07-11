import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { InteractionScenario } from '../system-prompt';
import { trackServer as defaultTrackServer } from '../analytics';
import { isAbortedTerminalReason, shouldTitleCompletedTurn } from '../../shared/terminalReason';
import type { CancelReason } from '../utils/cancellation';
import {
  extractTurnUsageFromSdkResult,
  isEmptySuccessfulSdkResult,
  isRecoveredAssistantMessageError,
  isSuccessfulCompactControlTurn,
} from '../utils/sdk-turn-outcome';
import {
  decideTransientProviderTextRetry,
  type TransientProviderTextError,
  type TransientProviderTextRetryDecision,
} from '../session-core/turn-result-policy';
import { isSdkMissingResumeMessageError } from '../session-core/resume-error-recovery';
import { decideInFlightActionOnResult } from '../utils/inflight-terminal';
import type { InFlightMetadata, ProviderEnv, TurnProviderAnalytics } from './types';
import {
  getCurrentTurnText,
  getCurrentTurnInboxMeta,
  getCurrentTurnAnalyticsSource,
  getCurrentTurnAnalyticsOrigin,
  getCurrentTurnCompactResult,
  getCurrentTurnProviderAnalytics,
  getCurrentTurnStartTime,
  getCurrentTurnToolCount,
  getCurrentTurnUsage,
  getLastAssistantMessageError,
  getPendingRequestIds,
  hadAssistantMessageError,
  hasCurrentTurnImTerminalEmitted,
  hasCurrentTurnOutput,
  markCurrentTurnHasOutput,
  notifyCurrentTurnTerminal,
  replaceCurrentTurnUsage,
  sawCompactBoundary,
  setCurrentTurnImTerminalEmitted,
  setCurrentTurnInboxMeta,
  clearCurrentTurnTextBlocks,
} from './turn';
import { originAnalyticsFields, originFromTurnAttribution } from '../../shared/session-origin';
import {
  getInFlightMetadata,
  getInFlightQueueId,
  getInterruptingInFlightQueueId,
  getForceSurfaceInFlightId,
} from './queue';
import { allocateMessageId, appendMessage, getMessages } from './transcript';
import {
  stampTurnUsageOnPendingAssistant,
} from './transcript-persistence';

export type BuiltinTurnTraceSnapshot = {
  turnId: string;
  startMs: number;
  sessionId: string;
  requestId?: string;
};

export type BuiltinTurnTraceOptions = {
  status?: 'ok' | 'error' | 'timeout' | 'skipped';
  durationMs?: number;
  sizeBytes?: number;
  count?: number;
  detail?: Record<string, string | number | boolean | null | undefined>;
};

export type BuiltinSdkResultMessage = SDKResultMessage & {
  result?: string;
  errors?: string[];
};

export type BuiltinTurnLifecycleDeps = {
  getSessionId: () => string;
  getCurrentScenario: () => InteractionScenario;
  getProviderEnv: () => ProviderEnv | undefined;
  getCurrentModel: () => string | undefined;
  getIsInterruptingResponse: () => boolean;
  setStreamingMessage: (value: boolean) => void;
  setForceDrainTurnStarting: (value: boolean) => void;
  resetInFlightToolCount: () => void;
  resetWatchdogFired: () => void;
  resolvePostInterruptTurnEnd: () => void;
  terminalEventAppliesToCurrentInFlight: () => boolean;
  dropInFlightQueueItem: (reason: string, imTerminal?: 'cancelled' | 'failed') => string | null;
  preserveInFlightAfterTerminalBoundary: (reason: string) => void;
  surfaceInFlightQueueItem: (
    queueId: string,
    meta: InFlightMetadata | null,
    options: {
      sdkUuid?: string;
      midTurnBreak?: boolean;
      reason: string;
      awaitPersist?: boolean;
      schedulePersist?: boolean;
    },
  ) => Promise<void>;
  schedulePostTerminalQueueDrain: (reason: 'complete' | 'stopped' | 'error' | 'recovery') => void;
  endTurnAbort: (sessionId: string) => void;
  abortTurnAbort: (sessionId: string, reason: CancelReason) => void;
  clearAmbientTurnId: (sessionId: string) => void;
  completeCurrentImRequest: (data?: unknown) => void;
  failCurrentImRequest: (data?: unknown) => void;
  clearMirrorState: () => void;
  clearStreamTurnMaps: () => void;
  clearCronTaskContext: () => void;
  hasQueuedOrInFlightWork: () => boolean;
  setSessionState: (state: 'idle' | 'starting' | 'running' | 'error') => void;
  persistTranscript: (targetMessageCount?: number) => Promise<void>;
  snapshotTrace: () => BuiltinTurnTraceSnapshot | null;
  emitTrace: (
    phase: string,
    options?: BuiltinTurnTraceOptions,
    snapshot?: BuiltinTurnTraceSnapshot | null,
  ) => void;
  emitFirstDeltaTrace: (delta: string) => void;
  clearTrace: (snapshot?: BuiltinTurnTraceSnapshot | null) => void;
  nowMs: () => number;
  elapsedMs: (start: number) => number;
  broadcast: (event: string, data: unknown) => void;
  broadcastBuiltinContextUsage: () => Promise<void>;
  getCurrentTransientProviderRetryAttempt: () => number;
  scheduleTransientProviderRetry: (
    decision: Extract<TransientProviderTextRetryDecision, { retry: true }>,
  ) => boolean;
  retractTransientProviderTextOutput: (resultText: string) => void;
  clearApiRetryStatus: () => void;
  trackServer?: typeof defaultTrackServer;
  firePostTurnTitleHook: (
    sessionId: string,
    runtime: 'builtin',
    model: string | undefined,
    providerEnv: ProviderEnv | undefined,
  ) => Promise<void> | void;
  appendTextChunk: (chunk: string) => boolean;
  localizeImError: (rawError: string) => string;
  setLastAgentError: (error: string) => void;
  buildTurnProviderAnalytics: (providerEnv: ProviderEnv | undefined) => TurnProviderAnalytics;
  probeForkPersistenceIfReady: (resultMessage: BuiltinSdkResultMessage) => void;
  recoverInvalidResumeAnchorError: (rawError: string) => boolean;
  handleTerminalRecovery: (reason: 'image' | 'stale' | undefined) => void;
  applyDeferredRestartIfNeeded: () => void;
};

export type BuiltinTurnLifecycle = {
  handleSdkResult: (resultMessage: BuiltinSdkResultMessage) => void;
  completeTurn: () => void;
  stopTurn: () => void;
  failTurn: (error: string, localizedError?: string) => void;
  getLastTurnEndPersist: () => Promise<unknown>;
};

export function createBuiltinTurnLifecycle(deps: BuiltinTurnLifecycleDeps): BuiltinTurnLifecycle {
  let lastTurnEndPersist: Promise<unknown> = Promise.resolve();
  const track = deps.trackServer ?? defaultTrackServer;

  const commonTerminalCleanup = (terminal: 'complete' | 'stopped' | 'error'): void => {
    deps.schedulePostTerminalQueueDrain(terminal);
    const sid = deps.getSessionId();
    if (sid) {
      if (terminal === 'error') {
        deps.abortTurnAbort(sid, 'error');
      } else {
        deps.endTurnAbort(sid);
      }
      deps.clearAmbientTurnId(sid);
    }
    deps.clearMirrorState();
    deps.clearStreamTurnMaps();
    deps.clearCronTaskContext();
    if (!deps.hasQueuedOrInFlightWork()) {
      deps.setSessionState('idle');
    }
  };

  const completeTurn = (): void => {
    deps.setStreamingMessage(false);
    notifyCurrentTurnTerminal('complete');
    let confirmedQueueTurnKeepStreaming = false;

    const inFlightQueueId = getInFlightQueueId();
    if (inFlightQueueId !== null) {
      const stale = inFlightQueueId;
      const meta = getInFlightMetadata();
      const interruptTargetMismatch = deps.getIsInterruptingResponse()
        && getInterruptingInFlightQueueId() !== stale;
      if (interruptTargetMismatch) {
        deps.preserveInFlightAfterTerminalBoundary(`interrupt result targets ${getInterruptingInFlightQueueId() ?? 'none'}`);
      } else {
        const forced = getForceSurfaceInFlightId() === stale;
        const inFlightAction = decideInFlightActionOnResult({
          isInterrupting: deps.getIsInterruptingResponse(),
          forced,
          hasMeta: !!meta,
        });
        if (inFlightAction === 'drop') {
          deps.dropInFlightQueueItem('graceful interrupt result before SDK consumption confirmation', 'cancelled');
        } else if (inFlightAction === 'surface' && meta) {
          if (forced) deps.setForceDrainTurnStarting(true);
          void deps.surfaceInFlightQueueItem(stale, meta, {
            sdkUuid: stale,
            reason: forced ? 'force-send #289' : 'confirmed result handoff',
            awaitPersist: false,
          }).catch((error) => {
            console.error(`[agent] Failed to surface in-flight queue item ${stale} at result boundary:`, error);
          });
          confirmedQueueTurnKeepStreaming = true;
        } else if (inFlightAction === 'await-replay') {
          deps.preserveInFlightAfterTerminalBoundary('natural result');
        }
      }
    }

    commonTerminalCleanup('complete');
    if (!hasCurrentTurnImTerminalEmitted()) {
      deps.completeCurrentImRequest('');
    }
    setCurrentTurnImTerminalEmitted(false);
    forceCloseOrphanThinkingBlocks('handleMessageComplete');

    const turnStartTime = getCurrentTurnStartTime();
    const durationMs = turnStartTime ? Date.now() - turnStartTime : undefined;
    const turnUsage = getCurrentTurnUsage();
    const turnToolCount = getCurrentTurnToolCount();
    stampTurnUsageOnPendingAssistant({
      usage: turnUsage,
      toolCount: turnToolCount,
      durationMs,
    });

    const persistTrace = deps.snapshotTrace();
    const persistTraceStarted = deps.nowMs();
    const persistTraceToolCount = turnToolCount;
    const persistTraceMessageCount = getMessages().length;
    lastTurnEndPersist = deps.persistTranscript()
      .then(() => {
        deps.emitTrace('persist_done', {
          durationMs: deps.elapsedMs(persistTraceStarted),
          status: 'ok',
          count: persistTraceMessageCount,
          detail: { toolCount: persistTraceToolCount },
        }, persistTrace);
        deps.clearTrace(persistTrace);
      })
      .catch(err => {
        deps.emitTrace('persist_done', {
          durationMs: deps.elapsedMs(persistTraceStarted),
          status: 'error',
          count: persistTraceMessageCount,
          detail: { toolCount: persistTraceToolCount },
        }, persistTrace);
        deps.clearTrace(persistTrace);
        console.error('[agent] persistMessagesToStorage failed:', err);
        throw err;
      });
    void lastTurnEndPersist.catch(() => undefined);

    if (confirmedQueueTurnKeepStreaming) {
      deps.setStreamingMessage(true);
    }
  };

  const stopTurn = (): void => {
    deps.setStreamingMessage(false);
    notifyCurrentTurnTerminal('stopped', 'Execution stopped');
    const stoppedTrace = deps.snapshotTrace();
    deps.emitTrace('final', {
      status: 'error',
      detail: { source: 'message_stopped' },
    }, stoppedTrace);
    if (getInFlightQueueId() !== null) {
      if (deps.terminalEventAppliesToCurrentInFlight()) {
        deps.dropInFlightQueueItem('message stopped before SDK consumption confirmation', 'cancelled');
      } else {
        deps.preserveInFlightAfterTerminalBoundary(`stop targets ${getInterruptingInFlightQueueId() ?? 'none'}`);
      }
    }
    commonTerminalCleanup('stopped');
    deps.completeCurrentImRequest('');
    setCurrentTurnImTerminalEmitted(false);
    forceCloseOrphanThinkingBlocks('handleMessageStopped');
    void deps.persistTranscript().catch(err => console.error('[agent] persistMessagesToStorage failed:', err));
    deps.clearTrace(stoppedTrace);
  };

  const failTurn = (error: string, localizedError?: string): void => {
    deps.setStreamingMessage(false);
    notifyCurrentTurnTerminal('error', localizedError ?? error);
    const errorTrace = deps.snapshotTrace();
    deps.emitTrace('final', {
      status: 'error',
      detail: { source: 'message_error', error },
    }, errorTrace);
    if (getInFlightQueueId() !== null) {
      if (deps.terminalEventAppliesToCurrentInFlight()) {
        deps.dropInFlightQueueItem('message error before SDK consumption confirmation', 'failed');
      } else {
        deps.preserveInFlightAfterTerminalBoundary(`error targets ${getInterruptingInFlightQueueId() ?? 'none'}`);
      }
    }
    commonTerminalCleanup('error');
    if (!hasCurrentTurnImTerminalEmitted()) {
      deps.failCurrentImRequest(localizedError ?? deps.localizeImError(error));
    }
    setCurrentTurnImTerminalEmitted(false);

    const isExpectedTermination =
      error.includes('SIGTERM') ||
      error.includes('SIGKILL') ||
      error.includes('SIGINT') ||
      error.includes('process terminated') ||
      error.includes('AbortError');

    if (isExpectedTermination) {
      console.log('[agent] Skipping error persistence for expected termination:', error);
      deps.clearTrace(errorTrace);
      return;
    }

    appendMessage({
      id: allocateMessageId(),
      role: 'assistant',
      content: `Error: ${error}`,
      timestamp: new Date().toISOString(),
    });
    void deps.persistTranscript().catch(err => console.error('[agent] persistMessagesToStorage failed:', err));
    deps.clearTrace(errorTrace);
  };

  const handleSdkResult = (resultMessage: BuiltinSdkResultMessage): void => {
    deps.resetInFlightToolCount();
    deps.resetWatchdogFired();
    deps.resolvePostInterruptTurnEnd();

    const resultText = resultMessage.result || '';
    const isAbortResult =
      isAbortedTerminalReason(resultMessage.terminal_reason) || deps.getIsInterruptingResponse();
    let terminalRecoveryReason: 'image' | 'stale' | undefined;

    const transientRetryDecision = decideTransientProviderTextRetry({
      resultText,
      isError: resultMessage.is_error,
      isAbortResult,
      apiErrorStatus: 'api_error_status' in resultMessage ? resultMessage.api_error_status ?? null : null,
      toolUseCount: getCurrentTurnToolCount(),
      currentAttempt: deps.getCurrentTransientProviderRetryAttempt(),
    });
    let terminalTransientProviderError: TransientProviderTextError | null = null;
    let terminalTransientProviderRetryExhausted = false;
    let terminalTransientProviderMaxRetries = transientRetryDecision.maxRetries;
    if (transientRetryDecision.retry) {
      deps.retractTransientProviderTextOutput(resultText);
      if (deps.scheduleTransientProviderRetry(transientRetryDecision)) {
        console.warn(
          `[agent][transient-provider-text] ${transientRetryDecision.error.kind}; ` +
          `auto-retry ${transientRetryDecision.attempt}/${transientRetryDecision.maxRetries} ` +
          `in ${transientRetryDecision.delayMs}ms`,
        );
        return;
      }
      console.warn('[agent][transient-provider-text] retry requested but no safe current turn source was available');
      terminalTransientProviderError = transientRetryDecision.error;
    }
    if (!transientRetryDecision.retry) {
      deps.clearApiRetryStatus();
      terminalTransientProviderError = transientRetryDecision.error;
      terminalTransientProviderRetryExhausted = transientRetryDecision.exhausted;
      terminalTransientProviderMaxRetries = transientRetryDecision.maxRetries;
    }

    if (terminalTransientProviderError) {
      deps.retractTransientProviderTextOutput(resultText);
      const retrySuffix = terminalTransientProviderRetryExhausted
        ? `已自动重试 ${terminalTransientProviderMaxRetries} 次仍失败。`
        : '当前会话无法安全自动重试。';
      const finalError =
        `${terminalTransientProviderError.userMessage}${retrySuffix}` +
        '请稍后再试、减少并发，或切换 Provider。' +
        `\n\n原始错误：${terminalTransientProviderError.rawText}`;
      deps.setLastAgentError(finalError);
      deps.broadcast('chat:agent-error', { message: finalError });
      deps.broadcast('chat:message-error', finalError);
      failTurn(finalError);
      deps.handleTerminalRecovery(undefined);
      deps.applyDeferredRestartIfNeeded();
      return;
    }

    if (resultMessage.is_error) {
      const rawError = resultText || resultMessage.errors?.join('; ') || getLastAssistantMessageError() || '';
      if (isSdkMissingResumeMessageError(rawError) && deps.recoverInvalidResumeAnchorError(rawError)) {
        console.warn('[agent] SDK result rejected resumeSessionAt anchor; cleared stale anchor and restarting without surfacing user error');
        deps.clearApiRetryStatus();
        commonTerminalCleanup('error');
        return;
      }
      if (
        (rawError.includes('unknown variant') && rawError.includes('image')) ||
        (rawError.includes('image') && rawError.includes('exceed') && rawError.includes('max allowed size'))
      ) {
        terminalRecoveryReason = 'image';
      }
      if (rawError.includes('No conversation found')) {
        terminalRecoveryReason = 'stale';
      }
      if (getPendingRequestIds().length > 0 && !isAbortResult) {
        const errorText = deps.localizeImError(rawError);
        console.warn('[agent] SDK result is_error, forwarding to IM bus:', errorText);
        deps.failCurrentImRequest(errorText);
      } else if (getPendingRequestIds().length > 0 && isAbortResult) {
        console.log('[agent] Suppressing IM error forward for aborted turn (handleMessageComplete will finalize)');
      }
    }

    const turnUsage = extractTurnUsageFromSdkResult(resultMessage);
    replaceCurrentTurnUsage(turnUsage);
    if (!resultMessage.modelUsage && !resultMessage.usage) {
      console.warn('[agent] Result message has no usage data, token statistics may be incomplete');
    }

    const turnStartTime = getCurrentTurnStartTime();
    const durationMs = turnStartTime ? Date.now() - turnStartTime : 0;
    const currentTurnUsage = getCurrentTurnUsage();
    const providerAnalytics = getCurrentTurnProviderAnalytics() ?? deps.buildTurnProviderAnalytics(deps.getProviderEnv());
    const currentTurnToolCount = getCurrentTurnToolCount();
    stampTurnUsageOnPendingAssistant({
      usage: currentTurnUsage,
      toolCount: currentTurnToolCount,
      durationMs: durationMs || undefined,
      providerId: providerAnalytics.provider_id ?? undefined,
    });

    const hasResultText = resultText.trim().length > 0;
    const resultErrorText = (hasResultText ? resultText : '')
      || resultMessage.errors?.join('; ')
      || getLastAssistantMessageError()
      || '';
    const noOutputResultText = resultMessage.is_error ? resultErrorText : (hasResultText ? resultText : '');
    if (noOutputResultText && !hasCurrentTurnOutput() && !getCurrentTurnToolCount() && !isAbortResult) {
      let shouldCompleteNoOutputImRequest = false;
      if (resultMessage.is_error) {
        console.warn('[agent] SDK error result with no streamed output, showing as agent-error:', resultErrorText);
        deps.setLastAgentError(resultErrorText);
        deps.broadcast('chat:agent-error', { message: resultErrorText });
        shouldCompleteNoOutputImRequest = true;
      } else if (resultText) {
        console.warn('[agent] SDK non-error result with no streamed output, showing as message:', resultText);
        deps.emitFirstDeltaTrace(resultText);
        if (deps.appendTextChunk(resultText)) {
          deps.broadcast('chat:message-chunk', resultText);
          markCurrentTurnHasOutput();
          shouldCompleteNoOutputImRequest = true;
        }
      }
      if (shouldCompleteNoOutputImRequest && !hasCurrentTurnImTerminalEmitted()) {
        deps.completeCurrentImRequest(noOutputResultText);
      }
    }

    const finalTurnUsage = getCurrentTurnUsage();
    const finalTurnToolCount = getCurrentTurnToolCount();
    const finalTurnHasOutput = hasCurrentTurnOutput();
    const emptySuccessfulResult = isEmptySuccessfulSdkResult({
      isError: resultMessage.is_error,
      result: resultText,
      terminalReason: resultMessage.terminal_reason,
      hasVisibleOutput: finalTurnHasOutput,
      toolCount: finalTurnToolCount,
      outputTokens: finalTurnUsage.outputTokens,
    });
    const successfulCompactControlTurn = isSuccessfulCompactControlTurn({
      emptySuccessfulResult,
      compactResult: getCurrentTurnCompactResult(),
      sawCompactBoundary: sawCompactBoundary(),
    });
    const recoveredAssistantMessageError = isRecoveredAssistantMessageError({
      hadAssistantMessageError: hadAssistantMessageError(),
      isError: resultMessage.is_error,
      terminalReason: resultMessage.terminal_reason,
      emptySuccessfulResult: emptySuccessfulResult && !successfulCompactControlTurn,
    });

    const lastAssistantMessageError = getLastAssistantMessageError();
    if (recoveredAssistantMessageError && lastAssistantMessageError) {
      console.log('[agent] SDK assistant message error recovered by successful result:', lastAssistantMessageError);
    }
    if (resultMessage.is_error && !isAbortResult) {
      notifyCurrentTurnTerminal('error', resultErrorText || resultText || 'turn ended with error');
    }
    deps.emitTrace('final', {
      status: resultMessage.is_error || (emptySuccessfulResult && !successfulCompactControlTurn) ? 'error' : 'ok',
      durationMs,
      count: finalTurnToolCount,
      detail: {
        terminalReason: resultMessage.terminal_reason ?? 'completed',
        hasOutput: finalTurnHasOutput,
        emptySuccessfulResult,
        successfulCompactControlTurn,
      },
    });

    const messages = getMessages();
    const lastMessage = messages[messages.length - 1];
    const lastAssistant = lastMessage?.role === 'assistant' ? lastMessage : null;

    if (resultMessage.terminal_reason && resultMessage.terminal_reason !== 'completed') {
      const scenario = deps.getCurrentScenario();
      console.log(`[agent][terminal_reason] ${resultMessage.terminal_reason} scenario=${scenario.type} model=${finalTurnUsage.model ?? 'unknown'} duration_ms=${durationMs} tool_count=${finalTurnToolCount}`);
    }

    if (emptySuccessfulResult && !successfulCompactControlTurn) {
      const emptyResultError = 'AI 未返回任何内容，但 SDK 将本轮标记为完成。请在当前会话重试；如果使用第三方兼容供应商，建议切换模型、减少上下文或压缩后重试。';
      console.warn(`[agent][empty_result] model=${finalTurnUsage.model ?? 'unknown'} terminal_reason=${resultMessage.terminal_reason ?? 'none'} input=${finalTurnUsage.inputTokens} output=${finalTurnUsage.outputTokens} duration_ms=${durationMs} provisional_error=${lastAssistantMessageError ?? 'none'}`);
      deps.setLastAgentError(emptyResultError);
      deps.broadcast('chat:message-error', emptyResultError);
      failTurn(emptyResultError);
      const replyText = getCurrentTurnText();
      const replyMeta = getCurrentTurnInboxMeta();
      if (replyMeta) {
        setCurrentTurnInboxMeta(undefined);
        void import('../inbox/reply-deliver').then(({ deliverInboxReply }) =>
          deliverInboxReply(deps.getSessionId(), replyMeta, {
            text: replyText,
            error: {
              code: 'turn_failed',
              message: emptyResultError,
            },
          }),
        ).catch((err) =>
          console.error('[inbox] empty-result reply pushback failed:', err),
        );
      }
      clearCurrentTurnTextBlocks();
      void import('../inbox/watch-deliver').then(({ deliverSessionWatchEvents }) =>
        deliverSessionWatchEvents(deps.getSessionId(), {
          text: replyText,
          error: {
            code: 'turn_failed',
            message: emptyResultError,
          },
        }),
      ).catch((err) =>
        console.error('[session-watch] empty-result watch push failed:', err),
      );
    } else {
      console.log('[agent][sdk] Broadcasting chat:message-complete');
      deps.broadcast('chat:message-complete', {
        model: finalTurnUsage.model,
        input_tokens: finalTurnUsage.inputTokens,
        output_tokens: finalTurnUsage.outputTokens,
        cache_read_tokens: finalTurnUsage.cacheReadTokens,
        cache_creation_tokens: finalTurnUsage.cacheCreationTokens,
        tool_count: finalTurnToolCount,
        duration_ms: durationMs,
        terminal_reason: resultMessage.terminal_reason,
        assistant_sdk_uuid: lastAssistant?.sdkUuid,
        assistant_message_id: lastAssistant?.id,
        compact_result: successfulCompactControlTurn ? 'success' : undefined,
      });

      void deps.broadcastBuiltinContextUsage();

      const scenario = deps.getCurrentScenario();
      const turnAnalyticsSource = getCurrentTurnAnalyticsSource() ?? scenario.type;
      const turnOrigin = getCurrentTurnAnalyticsOrigin()
        ?? originFromTurnAttribution({
          source: turnAnalyticsSource,
          scenarioType: scenario.type,
          desktopSurface: scenario.type === 'desktop' ? scenario.surface : undefined,
        });
      track('ai_turn_complete', {
        source: turnAnalyticsSource,
        ...originAnalyticsFields(turnOrigin),
        session_id: deps.getSessionId(),
        platform: scenario.type === 'im' ? scenario.platform : null,
        runtime: 'builtin',
        runtime_source: null,
        model: finalTurnUsage.model ?? null,
        ...providerAnalytics,
        input_tokens: finalTurnUsage.inputTokens,
        output_tokens: finalTurnUsage.outputTokens,
        cache_read_tokens: finalTurnUsage.cacheReadTokens,
        cache_creation_tokens: finalTurnUsage.cacheCreationTokens,
        tool_count: finalTurnToolCount,
        duration_ms: durationMs,
      });

      completeTurn();

      if (shouldTitleCompletedTurn(resultMessage.is_error === true, resultMessage.terminal_reason)) {
        const titleSid = deps.getSessionId();
        const titleModel = deps.getCurrentModel();
        const titleProviderEnv = deps.getProviderEnv();
        void lastTurnEndPersist.then(
          () => deps.firePostTurnTitleHook(titleSid, 'builtin', titleModel, titleProviderEnv),
          () => undefined,
        );
      }

      const sessionEventText = getCurrentTurnText();
      const sessionEventError = resultMessage.is_error
        ? {
            code: 'turn_failed',
            message:
              resultMessage.result ||
              (resultMessage.errors?.join('; ') ?? 'turn ended with error'),
          }
        : undefined;
      const replyMeta = getCurrentTurnInboxMeta();
      if (replyMeta) {
        setCurrentTurnInboxMeta(undefined);
        void import('../inbox/reply-deliver').then(({ deliverInboxReply }) =>
          deliverInboxReply(deps.getSessionId(), replyMeta, {
            text: sessionEventText,
            error: sessionEventError,
          }),
        ).catch((err) =>
          console.error('[inbox] result-handler reply pushback failed:', err),
        );
      }
      clearCurrentTurnTextBlocks();
      void import('../inbox/watch-deliver').then(({ deliverSessionWatchEvents }) =>
        deliverSessionWatchEvents(deps.getSessionId(), {
          text: sessionEventText,
          error: sessionEventError,
        }),
      ).catch((err) =>
        console.error('[session-watch] result-handler watch push failed:', err),
      );
    }

    deps.probeForkPersistenceIfReady(resultMessage);
    deps.handleTerminalRecovery(terminalRecoveryReason);
    deps.applyDeferredRestartIfNeeded();
  };

  return {
    handleSdkResult,
    completeTurn,
    stopTurn,
    failTurn,
    getLastTurnEndPersist: () => lastTurnEndPersist,
  };
}

function forceCloseOrphanThinkingBlocks(source: string): void {
  const messages = getMessages();
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'assistant' || typeof lastMsg.content === 'string') return;
  let patched = false;
  lastMsg.content = lastMsg.content.map((block) => {
    if (block.type === 'thinking' && !block.isComplete) {
      patched = true;
      return {
        ...block,
        isComplete: true,
        thinkingDurationMs: block.thinkingStartedAt ? Date.now() - block.thinkingStartedAt : undefined,
      };
    }
    return block;
  });
  if (patched && source === 'handleMessageComplete') {
    console.warn('[agent] Force-closed orphaned thinking block(s) in handleMessageComplete');
  }
}
