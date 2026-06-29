import { broadcast } from '../sse';
import {
  freezeCurrentSessionMetadataForImDetach,
  getAgentState,
  getSessionId,
  materializeCurrentSessionMetadataForPublishedReset,
  materializePendingDesktopSession as materializeBuiltinPendingDesktopSession,
  resetSession,
} from '../agent-session';
import {
  cancelExternalQueueItem,
  cancelExternalImRequest,
  didLastTurnSucceed,
  awaitExternalSessionStarting,
  enqueueExternalSendForDesktop,
  forceExecuteExternalQueueItem,
  getActiveRuntimeSource,
  getActiveRuntimeType,
  getCurrentBoundSessionId,
  getExternalLiveAssistantMessage,
  getExternalPendingInteractiveRequests,
  getExternalQueueStatus,
  getExternalSessionId,
  getExternalSessionModel,
  getExternalSessionPermissionMode,
  getExternalSessionReasoningEffort,
  getExternalSessionState,
  getExternalSessionWorkspacePath,
  getExternalSystemInitPayload,
  getLastExternalAssistantText,
  isExternalSessionActive,
  popLastUserMessageForRetry,
  prewarmExternalSession,
  respondExternalAskUserQuestion,
  respondExternalPermission,
  restoreExternalSessionState,
  sendExternalMessage,
  setExternalModel,
  setExternalPermissionMode,
  setExternalReasoningEffort,
  stopExternalSession,
  updateExternalRuntimeConfig,
  waitForExternalSessionIdle,
} from '../runtimes/external-session';
import type {
  DesktopAdmissionResult,
  DesktopMessageRequest,
  ImAdmissionResult,
  ImMessageRequest,
  InjectedTurnRequest,
  InjectedTurnResult,
  SessionEngine,
} from './types';
import { decideExternalInjectedTurnResult } from '../session-core/turn-result-policy';
import { getEffectiveOfficialToolIdsForSession } from '../utils/admin-config';
import { getSessionData, updateSessionMetadata } from '../SessionStore';
import { getLatestAssistantResultFromMessages, NO_TEXT_RESPONSE } from '../inbox/latest-result';
import type { SessionMessage } from '../types/session';
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import type { RuntimeBackedProviderIdentity } from '../../shared/providerExecution';

function getRuntimeSessionId(): string {
  return getExternalSessionId() || getCurrentBoundSessionId() || getSessionId();
}

function getRuntimeWorkspacePath(): string {
  return getExternalSessionWorkspacePath() || getAgentState().agentDir || '';
}

function getLatestExternalResult(): string {
  const runtimeSessionId = getRuntimeSessionId();
  let latestResult = getLastExternalAssistantText();
  if (!latestResult.trim()) {
    const data = runtimeSessionId ? getSessionData(runtimeSessionId) : null;
    latestResult = data
      ? getLatestAssistantResultFromMessages(data.messages)
      : NO_TEXT_RESPONSE;
  }
  return latestResult.trim() || NO_TEXT_RESPONSE;
}

function externalLiveMessageToSessionMessage(message: SessionMessage): SessionMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    sdkUuid: message.sdkUuid,
    attachments: message.attachments,
    metadata: message.metadata,
    usage: message.usage,
    toolCount: message.toolCount,
    durationMs: message.durationMs,
  };
}

type ExternalFreezeSnapshotPatch = NonNullable<
  Parameters<typeof freezeCurrentSessionMetadataForImDetach>[0]
>;

function buildExternalFreezeSnapshotPatch(): ExternalFreezeSnapshotPatch {
  const runtime = getActiveRuntimeType();
  const runtimeSource = getActiveRuntimeSource();
  const model = getExternalSessionModel() ?? undefined;
  const permissionMode = getExternalSessionPermissionMode() ?? undefined;
  const reasoningEffort = getExternalSessionReasoningEffort() ?? undefined;
  const patch: ExternalFreezeSnapshotPatch = {
    runtime,
  };
  if (runtime !== 'builtin' && runtimeSource) patch.runtimeSource = runtimeSource;
  if (model) patch.model = model;
  if (permissionMode) patch.permissionMode = permissionMode;
  if (reasoningEffort) patch.reasoningEffort = reasoningEffort;
  if (runtime === 'codex' && runtimeSource === 'managed-provider' && model) {
    patch.providerExecutionIdentity = {
      kind: 'runtime-backed-provider',
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID as RuntimeBackedProviderIdentity['providerId'],
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      model,
    };
  }
  return patch;
}

export function createExternalSessionEngine(): SessionEngine {
  return {
    kind: 'external',

    isBusy() {
      return isExternalSessionActive();
    },

    getRuntimeIdentity() {
      const boundSessionId = getCurrentBoundSessionId();
      return {
        kind: 'external',
        runtime: getActiveRuntimeType(),
        runtimeSource: getActiveRuntimeSource(),
        sessionId: getRuntimeSessionId(),
        ...(boundSessionId ? { boundSessionId } : {}),
      };
    },

    getLiveSessionState() {
      return {
        sessionState: getExternalSessionState(),
        isBusy: isExternalSessionActive(),
      };
    },

    getLatestAssistantResult() {
      return {
        sessionId: getRuntimeSessionId(),
        latestResult: getLatestExternalResult(),
      };
    },

    getStreamReplaySnapshot() {
      const systemInitPayload = getExternalSystemInitPayload();
      return {
        initState: { ...getAgentState(), sessionState: getExternalSessionState() },
        replayMessages: [],
        systemInitPayload: systemInitPayload ?? undefined,
        pendingInteractiveRequests: getExternalPendingInteractiveRequests(),
      };
    },

    getSessionConfigSnapshot() {
      const runtimeSessionId = getRuntimeSessionId();
      const session = runtimeSessionId ? getSessionData(runtimeSessionId) : null;
      const workspacePath = getRuntimeWorkspacePath();
      return {
        success: true,
        runtime: getActiveRuntimeType(),
        runtimeSource: getActiveRuntimeSource(),
        model: getExternalSessionModel(),
        mcpServerIds: null,
        agentNames: null,
        enabledOfficialToolIds: workspacePath
          ? getEffectiveOfficialToolIdsForSession(workspacePath, session)
          : [],
        permissionMode: getExternalSessionPermissionMode(),
        providerId: session?.providerExecutionIdentity?.providerId ?? null,
        providerRoute: null,
        providerExecutionIdentity: session?.providerExecutionIdentity ?? null,
        reasoningEffort: getExternalSessionReasoningEffort() ?? 'default',
      };
    },

    getCurrentSessionContext() {
      const sessionId = getRuntimeSessionId();
      return {
        runtime: getActiveRuntimeType(),
        sessionId: sessionId || null,
        workspacePath: getRuntimeWorkspacePath() || null,
        sessionMeta: sessionId ? getSessionData(sessionId) : null,
      };
    },

    getHeldImConfigSnapshot() {
      return {
        model: getExternalSessionModel() ?? undefined,
        permissionMode: getExternalSessionPermissionMode() ?? undefined,
        reasoningEffort: getExternalSessionReasoningEffort() ?? undefined,
      };
    },

    getLiveSessionOverlay(sessionId: string) {
      if (sessionId !== getRuntimeSessionId()) {
        return { isActive: false };
      }
      const liveMessage = getExternalLiveAssistantMessage();
      return {
        isActive: true,
        runtime: getActiveRuntimeType(),
        liveStreamingMessage: liveMessage ? externalLiveMessageToSessionMessage(liveMessage) : null,
        liveSessionState: getExternalSessionState(),
      };
    },

    async sendDesktopMessage(request: DesktopMessageRequest): Promise<DesktopAdmissionResult> {
      const sent = enqueueExternalSendForDesktop(
        request.text,
        request.images,
        request.permissionMode,
        request.model,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          analyticsSource: request.analyticsSource,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
        },
      );
      sent.dispatch
        .then((result) => {
          if (!result.queued && result.error) {
            console.error(`[chat] external send failed: ${result.error}`);
            broadcast('chat:agent-error', { message: result.error });
          }
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[chat] external send threw: ${msg}`);
          broadcast('chat:agent-error', { message: msg });
        });
      return {
        success: true,
        queued: sent.queued,
        queueId: sent.queueId,
        isInFlight: sent.isInFlight,
        deliveryMode: sent.deliveryMode,
      };
    },

    async enqueueImMessage(request: ImMessageRequest): Promise<ImAdmissionResult> {
      const result = await sendExternalMessage(
        request.message,
        request.images,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          requestId: request.requestId,
          metadataBirthPending: request.metadataBirthPending === true,
        },
      );
      if (!result.queued) {
        return {
          success: false,
          error: result.error ?? 'Failed to send via external runtime',
          status: 503,
        };
      }
      return { success: true, queued: result.queued };
    },

    cancelImRequest(requestId, reason) {
      return cancelExternalImRequest(requestId, reason);
    },

    async enqueueBackgroundMessage(request) {
      const result = await sendExternalMessage(
        request.text,
        request.images,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
        },
      );
      if (!result.queued) {
        return {
          success: false,
          error: result.error ?? 'Failed to send via external runtime',
          status: 503,
        };
      }
      return { success: true, queued: result.queued };
    },

    enqueueInboxMessage(request) {
      return sendExternalMessage(
        request.text,
        undefined,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: { type: 'desktop' },
          inboxMeta: request.inboxMeta,
          metadataBirthPending: request.allowLazySessionMaterialization === true,
        },
      );
    },

    async runInjectedTurn(request: InjectedTurnRequest): Promise<InjectedTurnResult> {
      const result = await sendExternalMessage(
        request.prompt,
        undefined,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
        },
      );
      if (!result.queued) {
        return {
          success: false,
          enqueued: false,
          error: result.error ?? 'Failed to start external runtime turn',
          status: 503,
        };
      }
      const completed = await waitForExternalSessionIdle(request.timeoutMs, request.pollMs ?? 1000);
      if (!completed) {
        await stopExternalSession();
        return { ...decideExternalInjectedTurnResult({ idleCompleted: false }), enqueued: true };
      }
      const turnSucceeded = didLastTurnSucceed();
      const decision = decideExternalInjectedTurnResult({
        idleCompleted: true,
        turnSucceeded,
        text: turnSucceeded ? getLastExternalAssistantText() : undefined,
      });
      return { ...decision, enqueued: true };
    },

    async stopTurn() {
      if (!isExternalSessionActive()) {
        return { success: true, alreadyStopped: true };
      }
      const stopped = await stopExternalSession();
      return { success: true, alreadyStopped: !stopped };
    },

    async cancelQueuedMessage(queueId) {
      const cancelledText = cancelExternalQueueItem(queueId);
      return cancelledText === null
        ? { status: 'not_found' as const }
        : { status: 'cancelled' as const, cancelledText };
    },

    forceQueuedMessage(queueId) {
      return forceExecuteExternalQueueItem(queueId);
    },

    getQueueStatus: getExternalQueueStatus,

    waitIdle(timeoutMs, pollMs) {
      return waitForExternalSessionIdle(timeoutMs, pollMs);
    },

    updateModel(model, opts) {
      return setExternalModel(model, opts);
    },

    updatePermissionMode(mode) {
      return setExternalPermissionMode(mode);
    },

    updateReasoningEffort(effort) {
      return setExternalReasoningEffort(effort);
    },

    async updateOfficialToolIds(_ids) {
      if (isExternalSessionActive() && getExternalSessionState() !== 'running') {
        await stopExternalSession();
      }
      return { success: true };
    },

    async materializePendingDesktopSession(request) {
      const runtimeSessionIdBefore = getExternalSessionId() || undefined;
      if (request.phase === 'commit' || request.phase === undefined) {
        await awaitExternalSessionStarting();
        if (isExternalSessionActive()) {
          await stopExternalSession();
        }
      }
      const result = await materializeBuiltinPendingDesktopSession({
        phase: request.phase,
        preparedSessionId: request.preparedSessionId,
        snapshotPatch: request.snapshotPatch,
      });
      if ((request.phase === 'commit' || request.phase === undefined) && result.success && result.sessionId) {
        if (runtimeSessionIdBefore && runtimeSessionIdBefore !== result.sessionId) {
          const updated = await updateSessionMetadata(result.sessionId, { runtimeSessionId: runtimeSessionIdBefore });
          if (!updated) {
            console.warn(`[session-engine] external materialize: failed to preserve runtimeSessionId for ${result.sessionId}`);
          }
        }
        restoreExternalSessionState(result.sessionId, request.workspacePath, { type: 'desktop' });
      }
      return result;
    },

    freezeCurrentSessionForImDetach(options) {
      return freezeCurrentSessionMetadataForImDetach(
        buildExternalFreezeSnapshotPatch(),
        {
          allowMissingMetadata: options?.metadataBirthPending === true,
        },
      );
    },

    updateRuntimeConfig(patch, options) {
      return updateExternalRuntimeConfig(patch, { source: options?.source ?? 'runtime-config' });
    },

    async prewarm(options) {
      return prewarmExternalSession({
        sessionId: options.sessionId,
        workspacePath: options.workspacePath,
        scenario: { type: 'desktop' },
        model: options.model,
        permissionMode: options.permissionMode,
      });
    },

    restoreInitialSession(sessionId, workspacePath) {
      restoreExternalSessionState(sessionId, workspacePath, { type: 'desktop' });
      return true;
    },

    async respondPermission(requestId, decision, reason) {
      await respondExternalPermission(requestId, decision, reason);
      return true;
    },

    respondAskUserQuestion(requestId, answers) {
      return respondExternalAskUserQuestion(requestId, answers);
    },

    async rewindToUserMessage() {
      return {
        success: false,
        status: 400,
        error: 'Rewind is not supported for external runtimes (CC/Codex)',
      };
    },

    retryLastExternalUserMessage(userMessageId) {
      return popLastUserMessageForRetry(userMessageId);
    },

    async forkAtAssistantMessage() {
      return {
        success: false,
        status: 400,
        error: 'Fork is not supported for external runtimes (CC/Codex)',
      };
    },

    async updateProviderEnv() {
      return { success: true, skipped: 'external-runtime' };
    },

    async updateMcpServers(servers) {
      return { success: true, servers: servers.map(s => s.id), skipped: 'external-runtime' };
    },

    async updateAgents() {
      return { success: true, skipped: 'external-runtime' };
    },

    async updateDesktopInteractionScenario() {
      return { success: true, skipped: 'external-runtime' };
    },

    async switchToExistingSession(sessionId, workspacePath, getSessionMetadata) {
      if (getCurrentBoundSessionId() === sessionId) {
        return { success: true, sessionId };
      }

      await awaitExternalSessionStarting();

      const meta = getSessionMetadata(sessionId);
      if (!meta) {
        return { success: false, error: 'Session not found.', status: 404 };
      }
      const activeRuntime = getActiveRuntimeType();
      if (meta.runtime && meta.runtime !== activeRuntime) {
        return {
          success: false,
          error: `Session runtime mismatch: persisted=${meta.runtime}, current=${activeRuntime}`,
          status: 409,
        };
      }

      if (isExternalSessionActive()) {
        await stopExternalSession();
      }
      restoreExternalSessionState(sessionId, workspacePath, { type: 'desktop' });
      return { success: true, sessionId };
    },

    async resetForNewDesktopSession(workspacePath) {
      await awaitExternalSessionStarting();
      if (isExternalSessionActive()) {
        await stopExternalSession();
      }
      await resetSession();
      const newSessionId = getSessionId();
      if (newSessionId) {
        restoreExternalSessionState(newSessionId, workspacePath, { type: 'desktop' });
      }
      return { success: true, sessionId: newSessionId };
    },

    async resetForNewImSession(workspacePath, options) {
      await awaitExternalSessionStarting();
      const freeze = await freezeCurrentSessionMetadataForImDetach(
        buildExternalFreezeSnapshotPatch(),
        {
          allowMissingMetadata: options?.metadataBirthPending === true,
        },
      );
      if (!freeze.success) {
        return { success: false, error: freeze.error ?? 'Failed to freeze current IM session before reset' };
      }
      if (isExternalSessionActive()) {
        await stopExternalSession();
      }
      await resetSession();
      await materializeCurrentSessionMetadataForPublishedReset();
      const newSessionId = getSessionId();
      if (newSessionId) {
        restoreExternalSessionState(newSessionId, workspacePath, { type: 'desktop' });
      }
      return { success: true, sessionId: newSessionId };
    },
  };
}
