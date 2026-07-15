import { randomUUID } from 'node:crypto';
import {
  cancelQueueItem,
  cancelQueuedTurnsByOwner,
  cancelImRequest as cancelBuiltinImRequest,
  applyMcpOverrideAndAwaitReady,
  awaitRequiredMcpReadyForInjectedTurn,
  enqueueUserMessage,
  forkSession,
  forceExecuteQueueItem,
  getAndClearLastAgentError,
  getAgents,
  getAgentState,
  getBuiltinLiveSessionSnapshot,
  getBuiltinSessionCompletionTerminal,
  getLastBuiltinAssistantText,
  getMcpServers,
  getMessages,
  getPendingInteractiveRequests,
  getQueueStatus,
  getCurrentTurnIdentity as getBuiltinCurrentTurnIdentity,
  getDispatchedTurnIdentity as getBuiltinDispatchedTurnIdentity,
  hasQueuedTurnByOwner as hasBuiltinQueuedTurnByOwner,
  getSessionId,
  getSessionModel,
  getSessionPermissionMode,
  getSessionEnabledOfficialToolIds,
  getSessionProviderEnv,
  getSessionProviderId,
  getSessionReasoningEffort,
  isRequiredMcpReadinessLeaseCurrent,
  recoverQueryAfterMcpStatusTimeout,
  getStreamingAssistantId,
  getSystemInitInfo,
  handleAskUserQuestionResponse,
  handlePermissionResponse,
  interruptCurrentResponse,
  isSessionBusy,
  freezeCurrentSessionMetadataForImDetach,
  materializeCurrentSessionMetadataForPublishedReset,
  materializePendingDesktopSession as materializeBuiltinPendingDesktopSession,
  resetSession,
  rewindSession,
  setAgents,
  setBackgroundAgentPermissionMode,
  setInteractionScenario,
  setMcpServers,
  setSessionModel,
  setSessionPermissionMode,
  setSessionEnabledOfficialToolIds,
  setSessionProviderEnv,
  setProxyConfig,
  setSessionReasoningEffort,
  stripPlaywrightResults,
  switchToSession,
  waitForSessionIdle,
} from '../agent-session';
import type { MessageWire, PermissionMode, ProviderEnv } from '../agent-session';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CancelReason } from '../utils/cancellation';
import { createConcreteProviderRoute, isConcreteProviderRoute, type ProviderRoute } from '../../shared/providerRoute';
import { getEffectiveOfficialToolIdsForSession, materializeProviderRouteEnv, resolveSubscriptionAuthKind, resolveWorkspaceConfig } from '../utils/admin-config';
import type {
  DesktopAdmissionResult,
  DesktopMessageRequest,
  ImAdmissionResult,
  ImMessageRequest,
  InjectedTurnRequest,
  InjectedTurnResult,
  SessionEngineReplayMessage,
  SessionEngine,
} from './types';
import { decideBuiltinInjectedTurnResult } from '../session-core/turn-result-policy';
import {
  formatMcpReadinessFailure,
  type McpReadinessFailure,
} from '../session-core/mcp-readiness';
import type { DispatchGuard, TurnTerminalOutcome } from '../session-core/turn-queue';
import { getSessionData } from '../SessionStore';
import { getLatestAssistantResultFromMessages, NO_TEXT_RESPONSE } from '../inbox/latest-result';
import { shrinkReplayContentForClient } from '../utils/session-message-preview';

function waitForDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createMcpReadinessDispatchGuard(params: {
  deadlineAt: number;
  onMcpFailure(failure: McpReadinessFailure): void;
}): DispatchGuard {
  const controller = new AbortController();
  const guard: DispatchGuard = Object.assign(
    async () => {
      if (controller.signal.aborted) {
        return { accepted: false, code: 'dispatch_canceled', error: 'Queue item was cancelled' };
      }

      let readiness;
      try {
        readiness = await awaitRequiredMcpReadyForInjectedTurn(params.deadlineAt, {
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return { accepted: false, code: 'dispatch_canceled', error: 'Queue item was cancelled' };
        }
        throw error;
      }
      if (!readiness.ready) {
        params.onMcpFailure(readiness.failure);
        if (readiness.failure.code === 'mcp_timeout') {
          recoverQueryAfterMcpStatusTimeout();
        }
        return {
          accepted: false,
          code: readiness.failure.code,
          error: formatMcpReadinessFailure(readiness.failure),
        };
      }

      return {
        accepted: true,
        validateAtCommit: () => {
          if (controller.signal.aborted) {
            return { accepted: false, code: 'dispatch_canceled', error: 'Queue item was cancelled' };
          }
          if (isRequiredMcpReadinessLeaseCurrent(readiness.lease)) {
            return { accepted: true };
          }
          const failure: McpReadinessFailure = {
            code: 'query_replaced',
            servers: readiness.lease.requiredServerIds.map(id => ({ id })),
          };
          params.onMcpFailure(failure);
          return {
            accepted: false,
            code: failure.code,
            error: formatMcpReadinessFailure(failure),
          };
        },
      };
    },
    {
      cancel: () => {
        controller.abort();
      },
    },
  );
  return guard;
}

function createInjectedTurnDispatchGuard(params: {
  deadlineAt: number;
  beforeDispatch?: DispatchGuard;
  onMcpFailure(failure: McpReadinessFailure): void;
}): DispatchGuard {
  const mcpReadiness = createMcpReadinessDispatchGuard(params);
  let cancellation: Promise<void> | null = null;
  const guard: DispatchGuard = Object.assign(
    async () => {
      const mcpAcceptance = await mcpReadiness();
      if (!mcpAcceptance.accepted) return mcpAcceptance;

      let domainAcceptance: Awaited<ReturnType<DispatchGuard>> | undefined;
      if (params.beforeDispatch) {
        domainAcceptance = await params.beforeDispatch();
        if (!domainAcceptance.accepted) return domainAcceptance;
      }

      return {
        accepted: true,
        validateAtCommit: () => {
          const mcpCommit = mcpAcceptance.validateAtCommit?.() ?? mcpAcceptance;
          if (!mcpCommit.accepted) {
            // A domain owner (notably Goal) may have durably claimed while its
            // async guard ran. Cancel it when the MCP lease changed before the
            // synchronous commit seam so no orphaned claim survives rejection.
            const rollback = params.beforeDispatch?.cancel?.();
            return {
              ...mcpCommit,
              ...(rollback
                ? { rollbackBeforeReject: Promise.resolve(rollback) }
                : {}),
            };
          }
          return domainAcceptance?.validateAtCommit?.() ?? domainAcceptance ?? { accepted: true };
        },
      };
    },
    {
      cancel: () => {
        cancellation ??= Promise.all([
          Promise.resolve(mcpReadiness.cancel?.()),
          Promise.resolve(params.beforeDispatch?.cancel?.()),
        ]).then(() => undefined);
        return cancellation;
      },
    },
  );
  return guard;
}

function providerEnvForRouteRequest(request: {
  providerRoute?: ProviderRoute;
  providerEnv?: ProviderEnv | 'subscription';
  model?: string;
}): { providerEnv: ProviderEnv | 'subscription' | undefined; model?: string; error?: string; status?: number } {
  if (!request.providerRoute) {
    return { providerEnv: request.providerEnv, model: request.model };
  }
  if (!isConcreteProviderRoute(request.providerRoute)) {
    return {
      providerEnv: undefined,
      error: 'Provider/model selection is incomplete. Select a provider-model pair before sending.',
      status: 409,
    };
  }
  if (request.model && request.model !== request.providerRoute.model) {
    return {
      providerEnv: undefined,
      error: `ProviderRoute/model mismatch: route model "${request.providerRoute.model}" does not match request model "${request.model}".`,
      status: 409,
    };
  }
  if (request.providerRoute.kind === 'subscription') {
    const authKind = resolveSubscriptionAuthKind(request.providerRoute.providerId);
    if (authKind === 'sdk-native') {
      return { providerEnv: 'subscription', model: request.providerRoute.model };
    }
    if (authKind !== 'host-managed-oauth') {
      return {
        providerEnv: undefined,
        error: `Subscription provider '${request.providerRoute.providerId}' cannot execute in builtin runtime`,
        status: 409,
      };
    }
  }
  const providerEnv = materializeProviderRouteEnv(request.providerRoute);
  if (!providerEnv) {
    return {
      providerEnv: undefined,
      error: `Provider "${request.providerRoute.providerId}" is unavailable or missing an API key.`,
      status: 409,
    };
  }
  return { providerEnv, model: request.providerRoute.model };
}

function getLatestBuiltinResult(): string {
  let latestResult = getLastBuiltinAssistantText();
  if (!latestResult.trim()) {
    const data = getSessionData(getSessionId());
    latestResult = data
      ? getLatestAssistantResultFromMessages(data.messages)
      : NO_TEXT_RESPONSE;
  }
  return latestResult.trim() || NO_TEXT_RESPONSE;
}

function getBuiltinWorkspacePath(): string | null {
  const state = getAgentState();
  return typeof state.agentDir === 'string' && state.agentDir.length > 0
    ? state.agentDir
    : null;
}

function messageWireToReplayMessage(message: MessageWire): SessionEngineReplayMessage {
  const strippedContent = typeof message.content !== 'string'
    ? stripPlaywrightResults(message.content)
    : message.content;
  const content = shrinkReplayContentForClient(strippedContent);
  return {
    id: message.id,
    role: message.role,
    content,
    timestamp: message.timestamp,
    sdkUuid: message.sdkUuid,
    attachments: message.attachments,
    metadata: message.metadata,
    usage: message.usage,
    toolCount: message.toolCount,
    durationMs: message.durationMs,
  };
}

export function createBuiltinSessionEngine(): SessionEngine {
  return {
    kind: 'builtin',

    isBusy() {
      return isSessionBusy();
    },

    getRuntimeIdentity() {
      return {
        kind: 'builtin',
        runtime: 'builtin',
        sessionId: getSessionId(),
      };
    },

    getLiveSessionState() {
      return {
        sessionState: getAgentState().sessionState,
        isBusy: isSessionBusy(),
      };
    },

    getLatestAssistantResult() {
      return {
        sessionId: getSessionId(),
        latestResult: getLatestBuiltinResult(),
      };
    },

    getStreamReplaySnapshot() {
      const streamingId = getStreamingAssistantId();
      const replayMessages = getMessages()
        .filter(message => !(streamingId && message.id === streamingId))
        .map(messageWireToReplayMessage);
      const systemInitInfo = getSystemInitInfo();
      return {
        initState: getAgentState(),
        replayMessages,
        systemInitPayload: systemInitInfo ? { info: systemInitInfo } : undefined,
        pendingInteractiveRequests: getPendingInteractiveRequests(),
      };
    },

    getSessionConfigSnapshot() {
      const model = getSessionModel();
      const providerId = getSessionProviderId();
      const mcpServers = getMcpServers();
      const agents = getAgents();
      const sessionId = getSessionId();
      const session = getSessionData(sessionId);
      const workspacePath = getBuiltinWorkspacePath();
      const enabledOfficialToolIds = workspacePath
        ? getEffectiveOfficialToolIdsForSession(
          workspacePath,
          session,
          getSessionEnabledOfficialToolIds(),
        )
        : [];
      return {
        success: true,
        runtime: 'builtin',
        model: model ?? null,
        mcpServerIds: mcpServers?.map(s => s.id) ?? null,
        agentNames: agents ? Object.keys(agents) : null,
        enabledOfficialToolIds,
        permissionMode: getSessionPermissionMode(),
        providerId,
        providerRoute: model && providerId ? createConcreteProviderRoute(providerId, model) : null,
        reasoningEffort: getSessionReasoningEffort() ?? 'default',
      };
    },

    getCurrentSessionContext() {
      const sessionId = getSessionId();
      return {
        runtime: 'builtin',
        sessionId: sessionId || null,
        workspacePath: getBuiltinWorkspacePath(),
        sessionMeta: sessionId ? getSessionData(sessionId) : null,
      };
    },

    getHeldImConfigSnapshot() {
      return {
        model: getSessionModel() ?? undefined,
        permissionMode: getSessionPermissionMode(),
        providerEnv: getSessionProviderEnv(),
        reasoningEffort: getSessionReasoningEffort(),
      };
    },

    getLiveSessionOverlay(sessionId: string) {
      const snapshot = getBuiltinLiveSessionSnapshot(sessionId);
      if (!snapshot) {
        return { isActive: false };
      }
      return {
        isActive: true,
        runtime: 'builtin',
        ...snapshot,
      };
    },

    getCurrentTurnIdentity() {
      return getBuiltinCurrentTurnIdentity();
    },

    getSessionCompletionTerminal() {
      return getBuiltinSessionCompletionTerminal();
    },

    hasQueuedTurnOwnedBy(owner) {
      return hasBuiltinQueuedTurnByOwner(owner);
    },

    async sendDesktopMessage(request: DesktopMessageRequest): Promise<DesktopAdmissionResult> {
      await setInteractionScenario(request.scenario);
      if (request.backgroundAgentPermissionMode) {
        setBackgroundAgentPermissionMode(request.backgroundAgentPermissionMode);
      }
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, error: routed.error, status: routed.status };
      }
      const result = await enqueueUserMessage(
        request.text,
        request.images,
        request.permissionMode,
        routed.model,
        routed.providerEnv,
        request.reasoningEffort,
        { source: 'desktop' },
        undefined,
        undefined,
        request.analyticsSource,
        request.analyticsOrigin,
        {
          fromDesktopChatSend: true,
          sessionBirthOrigin: request.birthOrigin,
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          ...(request.turnBoundaryOnly ? { queueResponseModeOverride: 'turn' as const } : {}),
          beforeDispatch: request.beforeDispatch,
        },
      );
      if (result.error) {
        return { success: false, error: result.error, status: 429 };
      }
      return {
        success: true,
        queued: result.queued,
        queueId: result.queueId,
        isInFlight: result.isInFlight,
        deliveryMode: result.deliveryMode,
        dispatchAcceptance: result.dispatchAcceptance,
      };
    },

    async enqueueImMessage(request: ImMessageRequest): Promise<ImAdmissionResult> {
      await setInteractionScenario(request.scenario);
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, error: routed.error, status: routed.status };
      }
      const result = await enqueueUserMessage(
        request.message,
        request.images,
        request.permissionMode as PermissionMode | undefined,
        routed.model,
        routed.providerEnv,
        request.reasoningEffort,
        request.metadata,
        request.requestId,
        undefined,
        undefined,
        request.analyticsOrigin,
        {
          allowLazySessionMaterialization: request.metadataBirthPending === true,
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          ...(request.turnBoundaryOnly ? { queueResponseModeOverride: 'turn' as const } : {}),
          beforeDispatch: request.beforeDispatch,
        },
      );
      if (result.error) {
        return { success: false, error: result.error, status: 503 };
      }
      return { success: true, queued: result.queued, dispatchAcceptance: result.dispatchAcceptance };
    },

    cancelImRequest(requestId, reason) {
      return cancelBuiltinImRequest(requestId, reason as CancelReason | undefined);
    },

    async enqueueBackgroundMessage(request) {
      await setInteractionScenario(request.scenario);
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, error: routed.error, status: routed.status };
      }
      const result = await enqueueUserMessage(
        request.text,
        request.images,
        request.permissionMode as PermissionMode | undefined,
        routed.model,
        routed.providerEnv,
        request.reasoningEffort,
        request.metadata,
        undefined,
        undefined,
        undefined,
        request.analyticsOrigin,
        {
          ...(request.turnBoundaryOnly ? { queueResponseModeOverride: 'turn' as const } : {}),
          queueId: request.queueId,
          turnOwner: request.turnOwner,
          onTerminal: request.onTerminal,
          beforeDispatch: request.beforeDispatch,
        },
      );
      if (result.error) {
        return { success: false, error: result.error, status: 503 };
      }
      return { success: true, queued: result.queued, dispatchAcceptance: result.dispatchAcceptance };
    },

    async enqueueInboxMessage(request) {
      const scenario = request.scenario ?? { type: 'desktop' as const };
      await setInteractionScenario(scenario);
      return enqueueUserMessage(
        request.text,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { source: 'desktop' },
        undefined,
        request.inboxMeta,
        undefined,
        request.analyticsOrigin,
        { allowLazySessionMaterialization: request.allowLazySessionMaterialization === true },
      );
    },

    async ensureGoalSessionConfig() {
      if (getMcpServers() !== null) return { success: true };
      const sessionId = getSessionId();
      const workspacePath = getBuiltinWorkspacePath();
      if (!workspacePath) {
        return { success: false, error: 'Goal session has no workspace path' };
      }
      const resolved = resolveWorkspaceConfig(
        workspacePath,
        sessionId ? getSessionData(sessionId) : null,
        { includeMcp: true },
      );
      await applyMcpOverrideAndAwaitReady(resolved.mcpServers);
      return { success: true };
    },

    async runInjectedTurn(request: InjectedTurnRequest): Promise<InjectedTurnResult> {
      const deadline = Date.now() + request.timeoutMs;
      const mcpReadinessDeadline = Math.min(deadline, Date.now() + 30_000);
      await setInteractionScenario(request.scenario);
      getAndClearLastAgentError();
      const queueId = request.queueId ?? randomUUID();
      let observedOutcome: TurnTerminalOutcome | undefined;
      let resolveTerminal!: (outcome: TurnTerminalOutcome) => void;
      const terminal = new Promise<TurnTerminalOutcome>((resolve) => {
        resolveTerminal = resolve;
      });
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, enqueued: false, error: routed.error, status: routed.status };
      }
      let mcpReadinessFailure: McpReadinessFailure | undefined;
      const beforeUserPersistence = createMcpReadinessDispatchGuard({
        deadlineAt: mcpReadinessDeadline,
        onMcpFailure: (failure) => {
          mcpReadinessFailure = failure;
        },
      });
      const beforeDispatch = createInjectedTurnDispatchGuard({
        deadlineAt: mcpReadinessDeadline,
        beforeDispatch: request.beforeDispatch,
        onMcpFailure: (failure) => {
          mcpReadinessFailure = failure;
        },
      });
      const enqueueAttempt = enqueueUserMessage(
        request.prompt,
        [],
        request.permissionMode as PermissionMode | undefined,
        routed.model,
        routed.providerEnv,
        request.reasoningEffort,
        request.metadata,
        undefined,
        undefined,
        undefined,
        request.analyticsOrigin,
        {
          allowLazySessionMaterialization: request.metadataBirthPending === true,
          queueId,
          turnOwner: request.turnOwner,
          onTerminal: async (outcome) => {
            observedOutcome = outcome;
            try {
              await request.onTerminal?.(outcome);
            } finally {
              resolveTerminal(outcome);
            }
          },
          queueResponseModeOverride: 'turn',
          beforeUserPersistence,
          beforeDispatch,
        },
      );
      const enqueueResult = await waitForDeadline(
        enqueueAttempt,
        Math.max(0, deadline - Date.now()),
      );
      if (!enqueueResult) {
        beforeUserPersistence.cancel?.();
        beforeDispatch.cancel?.();
        await cancelQueueItem(queueId);
        return {
          success: false,
          enqueued: false,
          error: 'Builtin injected turn timed out before enqueue admission',
          status: 408,
        };
      }
      if (enqueueResult.error) {
        beforeUserPersistence.cancel?.();
        beforeDispatch.cancel?.();
        if (mcpReadinessFailure) {
          return {
            success: false,
            enqueued: false,
            error: formatMcpReadinessFailure(mcpReadinessFailure),
            status: mcpReadinessFailure.code === 'mcp_timeout' ? 408 : 503,
            detail: mcpReadinessFailure,
          };
        }
        return { success: false, enqueued: false, error: enqueueResult.error, status: 503 };
      }
      const dispatchAcceptance = enqueueResult.dispatchAcceptance
        ? await waitForDeadline(enqueueResult.dispatchAcceptance, Math.max(0, deadline - Date.now()))
        : null;
      if (!dispatchAcceptance) {
        // Cancellation can race an in-flight durable domain claim. Start the
        // rollback synchronously, but do not publish rejection until the
        // domain owner acknowledges it. cancelQueueItem centralizes the same
        // guarantee for user-initiated cancellation; keeping this exact
        // promise also covers mocked/alternate queue implementations.
        const rollback = beforeDispatch.cancel?.();
        const cancelResult = await cancelQueueItem(queueId);
        await rollback;
        const dispatchAccepted = getBuiltinDispatchedTurnIdentity()?.queueId === queueId;
        const terminationUnconfirmed = dispatchAccepted
          && cancelResult.status !== 'cancelled'
          && !await interruptCurrentResponse('timeout');
        return {
          success: false,
          enqueued: dispatchAccepted,
          ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
          error: dispatchAccepted
            ? 'Builtin injected turn timed out during dispatch admission'
            : 'Builtin injected turn timed out before dispatch',
          status: 408,
        };
      }
      if (!dispatchAcceptance.accepted) {
        if (mcpReadinessFailure) {
          return {
            success: false,
            enqueued: false,
            error: formatMcpReadinessFailure(mcpReadinessFailure),
            status: mcpReadinessFailure.code === 'mcp_timeout' ? 408 : 503,
            detail: mcpReadinessFailure,
          };
        }
        return {
          success: false,
          enqueued: false,
          error: dispatchAcceptance.error ?? 'Injected turn was rejected before dispatch',
          status: 409,
        };
      }
      const outcome = await waitForDeadline(terminal, Math.max(0, deadline - Date.now()));
      if (!outcome) {
        const cancelResult = await cancelQueueItem(queueId);
        if (observedOutcome) {
          const settledOutcome = await terminal;
          return {
            ...decideBuiltinInjectedTurnResult({ idleCompleted: true, outcome: settledOutcome }),
            enqueued: true,
          };
        }
        let terminationUnconfirmed = false;
        if (cancelResult.status !== 'cancelled') {
          if (getBuiltinDispatchedTurnIdentity()?.queueId === queueId) {
            terminationUnconfirmed = !await interruptCurrentResponse('timeout');
          } else if (cancelResult.status !== 'not_found') {
            terminationUnconfirmed = true;
          }
        }
        return {
          ...decideBuiltinInjectedTurnResult({ idleCompleted: false }),
          enqueued: true,
          ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
        };
      }
      return { ...decideBuiltinInjectedTurnResult({ idleCompleted: true, outcome }), enqueued: true };
    },

    async stopTurn() {
      const stopped = await interruptCurrentResponse();
      return stopped ? { success: true } : { success: true, alreadyStopped: true };
    },

    async stopOwnedTurn(owner) {
      const canceled = await cancelQueuedTurnsByOwner(owner);
      const current = getBuiltinCurrentTurnIdentity();
      if (!current || current.owner.kind !== owner.kind || current.owner.id !== owner.id) {
        return { success: true, alreadyStopped: canceled === 0 };
      }
      const stopped = await interruptCurrentResponse();
      return stopped ? { success: true } : { success: true, alreadyStopped: true };
    },

    cancelQueuedMessage(queueId) {
      return cancelQueueItem(queueId);
    },

    forceQueuedMessage(queueId) {
      return forceExecuteQueueItem(queueId);
    },

    getQueueStatus,

    waitIdle(timeoutMs, pollMs) {
      return waitForSessionIdle(timeoutMs, pollMs);
    },

    async updateModel(model, opts) {
      setSessionModel(model, opts);
      return { success: true };
    },

    async updatePermissionMode(mode) {
      setSessionPermissionMode(mode as PermissionMode);
      return { success: true };
    },

    async updateReasoningEffort(effort) {
      setSessionReasoningEffort(effort);
      return { success: true };
    },

    async updateOfficialToolIds(ids) {
      setSessionEnabledOfficialToolIds(ids);
      return { success: true };
    },

    async updateProxyConfig(proxySettings) {
      await setProxyConfig(proxySettings);
      return { success: true };
    },

    materializePendingDesktopSession(request) {
      return materializeBuiltinPendingDesktopSession({
        phase: request.phase,
        preparedSessionId: request.preparedSessionId,
        snapshotPatch: request.snapshotPatch,
        origin: request.origin,
      });
    },

    freezeCurrentSessionForImDetach(options) {
      return freezeCurrentSessionMetadataForImDetach(undefined, {
        allowMissingMetadata: options?.metadataBirthPending === true || options?.metadataIndexed === false,
      });
    },

    async updateRuntimeConfig() {
      return {
        success: false,
        error: 'Runtime config endpoint is only for external runtimes',
      };
    },

    async prewarm() {
      return { success: false, error: 'Pre-warm is only for external runtimes' };
    },

    restoreInitialSession() {
      return false;
    },

    async respondPermission(requestId, decision) {
      return handlePermissionResponse(requestId, decision);
    },

    async respondAskUserQuestion(requestId, answers) {
      return handleAskUserQuestionResponse(requestId, answers);
    },

    rewindToUserMessage(userMessageId) {
      return rewindSession(userMessageId);
    },

    async retryLastExternalUserMessage() {
      return {
        success: false,
        status: 400,
        error: 'external-retry is only for external runtimes; builtin uses /chat/rewind',
      };
    },

    forkAtAssistantMessage(messageId) {
      return forkSession(messageId);
    },

    async updateProviderEnv(providerEnv) {
      setSessionProviderEnv(providerEnv);
      return { success: true };
    },

    async updateMcpServers(servers) {
      setMcpServers(servers);
      return { success: true, servers: servers.map(s => s.id) };
    },

    async updateAgents(agents) {
      setAgents(agents as Record<string, AgentDefinition>);
      return { success: true };
    },

    async updateDesktopInteractionScenario(scenario) {
      await setInteractionScenario(scenario);
      return { success: true };
    },

    async switchToExistingSession(sessionId) {
      const success = await switchToSession(sessionId);
      return success
        ? { success: true, sessionId }
        : { success: false, error: 'Session not found.', status: 404 };
    },

    async resetForNewDesktopSession() {
      await resetSession();
      return { success: true, sessionId: getSessionId() };
    },

    async resetForNewImSession(_workspacePath, options) {
      const freeze = await freezeCurrentSessionMetadataForImDetach(undefined, {
        allowMissingMetadata: options?.metadataBirthPending === true || options?.metadataIndexed === false,
      });
      if (!freeze.success) {
        return { success: false, error: freeze.error ?? 'Failed to freeze current IM session before reset' };
      }
      await resetSession();
      await materializeCurrentSessionMetadataForPublishedReset();
      return { success: true, sessionId: getSessionId() };
    },
  };
}
