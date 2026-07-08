import { randomUUID } from 'node:crypto';
import {
  cancelQueueItem,
  cancelImRequest as cancelBuiltinImRequest,
  consumeInjectedTurnOutcome,
  discardInjectedTurnOutcome,
  enqueueUserMessage,
  forkSession,
  forceExecuteQueueItem,
  getAndClearLastAgentError,
  getAgents,
  getAgentState,
  getLastBuiltinAssistantText,
  getMcpServers,
  getMessages,
  getPendingInteractiveRequests,
  getQueueStatus,
  getSessionId,
  getSessionModel,
  getSessionPermissionMode,
  getSessionEnabledOfficialToolIds,
  getSessionProviderEnv,
  getSessionProviderId,
  getSessionReasoningEffort,
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
import { getEffectiveOfficialToolIdsForSession, materializeProviderRouteEnv } from '../utils/admin-config';
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
import { getSessionData } from '../SessionStore';
import { getLatestAssistantResultFromMessages, NO_TEXT_RESPONSE } from '../inbox/latest-result';
import { shrinkReplayContentForClient } from '../utils/session-message-preview';
import type { SessionMessage } from '../types/session';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForInjectedTurnOutcome(
  injectedTurnId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<ReturnType<typeof consumeInjectedTurnOutcome>> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    const outcome = consumeInjectedTurnOutcome(injectedTurnId);
    if (outcome) return outcome;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(pollMs, remaining));
  }
  return undefined;
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
    return { providerEnv: 'subscription', model: request.providerRoute.model };
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

function messageWireToSessionMessage(message: MessageWire): SessionMessage {
  return {
    id: message.id,
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : JSON.stringify(stripPlaywrightResults(message.content)),
    timestamp: message.timestamp,
    sdkUuid: message.sdkUuid,
    attachments: message.attachments?.map(a => ({
      id: a.id,
      name: a.name,
      mimeType: a.mimeType,
      path: a.savedPath ?? a.relativePath ?? '',
    })),
    metadata: message.metadata,
    usage: message.usage,
    toolCount: message.toolCount,
    durationMs: message.durationMs,
  };
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
      if (sessionId !== getSessionId()) {
        return { isActive: false };
      }
      return {
        isActive: true,
        runtime: 'builtin',
        inMemoryMessages: getMessages().map(messageWireToSessionMessage),
      };
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
        { allowLazySessionMaterialization: request.metadataBirthPending === true },
      );
      if (result.error) {
        return { success: false, error: result.error, status: 503 };
      }
      return { success: true, queued: result.queued };
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
      );
      if (result.error) {
        return { success: false, error: result.error, status: 503 };
      }
      return { success: true, queued: result.queued };
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

    async runInjectedTurn(request: InjectedTurnRequest): Promise<InjectedTurnResult> {
      await setInteractionScenario(request.scenario);
      getAndClearLastAgentError();
      const injectedTurnId = randomUUID();
      const routed = providerEnvForRouteRequest(request);
      if (routed.error) {
        return { success: false, enqueued: false, error: routed.error, status: routed.status };
      }
      const enqueueResult = await enqueueUserMessage(
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
        { injectedTurnId },
      );
      if (enqueueResult.error) {
        return { success: false, enqueued: false, error: enqueueResult.error, status: 503 };
      }
      const waitStartedAt = Date.now();
      const completed = await waitForSessionIdle(request.timeoutMs, request.pollMs ?? 1000);
      if (!completed) {
        let retainForLateTerminal = true;
        if (enqueueResult.queued && enqueueResult.queueId) {
          const cancelResult = await cancelQueueItem(enqueueResult.queueId);
          retainForLateTerminal = cancelResult.status !== 'cancelled';
        }
        discardInjectedTurnOutcome(injectedTurnId, { retainForLateTerminal });
        return { ...decideBuiltinInjectedTurnResult({ idleCompleted: false }), enqueued: true };
      }
      const outcome = consumeInjectedTurnOutcome(injectedTurnId)
        ?? await waitForInjectedTurnOutcome(
          injectedTurnId,
          Math.max(0, request.timeoutMs - (Date.now() - waitStartedAt)),
          request.pollMs ?? 1000,
        );
      return { ...decideBuiltinInjectedTurnResult({ idleCompleted: true, outcome }), enqueued: true };
    },

    async stopTurn() {
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
