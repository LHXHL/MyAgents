import { z } from "zod";
import { buildWatchEvent } from "../inbox/watch-handler";
import { renderSessionEventPrompt } from "../inbox/session-event";
import {
  operationSchema,
  outcomeSchema,
  CANONICAL_UUID,
  parseAgentReference,
  sessionReference,
} from "@myagents/agent-network-protocol";
import {
  isProjectArchived,
  isProjectVisibleToUser,
} from "../../shared/config-types";
import { workspacePathsEqual } from "../../shared/workspacePath";
import { getSessionMetadata, isHistoryVisibleSession } from "../SessionStore";
import {
  handleAgentShow,
  handleSessionGet,
  handleSessionList,
} from "../admin-api";
import { resolvePersistedAgentWorkspaceRegistry } from "../utils/agent-workspace-identity";
import { readSessionActivity, readLatestSessionResult } from '../session-observation';
import { deriveSessionLabel } from '../inbox/derive-label';

const precheckSchema = z.strictObject({
  localAgentId: z.string().min(1).max(256),
  localSessionId: z
    .string()
    .regex(/^[a-zA-Z0-9-]{1,99}$/)
    .optional(),
});

/** Called only by the target's App via a fixed internal route. Resolving a
 * local ID here never re-derives the remote caller from this Global Sidecar. */
async function resolveTarget(input: z.infer<typeof precheckSchema>) {
  const registry = await resolvePersistedAgentWorkspaceRegistry();
  if (
    registry.diagnostics.some((item) =>
      item.agentIds.includes(input.localAgentId),
    )
  ) {
    throw new Error("AGENT_IDENTITY_CONFLICT");
  }
  const identity = registry.agentProjections.find(
    (item) => item.agentId === input.localAgentId,
  );
  if (
    !identity ||
    !identity.project ||
    !isProjectVisibleToUser(identity.project) ||
    isProjectArchived(identity.project)
  ) {
    throw new Error("AGENT_NOT_AVAILABLE");
  }
  if (input.localSessionId) {
    const metadata = getSessionMetadata(input.localSessionId);
    if (
      !metadata ||
      !isHistoryVisibleSession(metadata) ||
      !workspacePathsEqual(metadata.agentDir, identity.workspacePath)
    ) {
      throw new Error("SESSION_NOT_FOUND");
    }
  }
  return identity;
}
function failure(error: unknown) {
  const raw = error instanceof Error ? error.message : "";
  const code = [
    "AGENT_IDENTITY_CONFLICT",
    "AGENT_NOT_AVAILABLE",
    "SESSION_NOT_FOUND",
  ].includes(raw)
    ? raw
    : error instanceof z.ZodError
      ? "TARGET_PROJECTION_INVALID"
      : "TARGET_OWNER_UNAVAILABLE";
  // Never log exception messages/input: validation errors may embed business
  // text, paths or runtime configuration. Codes and paths are sufficient.
  console.warn('[agent-network] target failure', {
    stage: 'target-projection', code,
    ...(error instanceof z.ZodError
      ? { issues: error.issues.map(issue => ({ code: issue.code, path: issue.path.join('.') })) }
      : {}),
  });
  return { success: false, code, error: code };
}
export async function handleNetworkTargetPrecheck(
  payload: unknown,
): Promise<Record<string, unknown>> {
  try {
    const input = precheckSchema.parse(payload);
    const identity = await resolveTarget(input);
    return {
      success: true,
      data: {
        localAgentId: identity.agentId,
        workspacePath: identity.workspacePath,
        ...(input.localSessionId
          ? { localSessionId: input.localSessionId }
          : {}),
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/** This projection is for the three read operations only. Network invocation
 * permission has already been checked by Rust; local ownership is rechecked
 * here immediately before using the original business handlers. */
export async function handleNetworkTargetRead(
  payload: unknown,
): Promise<Record<string, unknown>> {
  try {
    const operation = operationSchema.parse(payload);
    if (
      operation.method !== "agent.show" &&
      operation.method !== "session.list" &&
      operation.method !== "session.get"
      && operation.method !== 'session.state'
    ) {
      return {
        success: false,
        code: "READ_OPERATION_REQUIRED",
        error: "READ_OPERATION_REQUIRED",
      };
    }
    await resolveTarget({
      localAgentId: operation.params.localAgentId,
      ...(operation.method === "session.get" || operation.method === 'session.state'
        ? { localSessionId: operation.params.localSessionId }
        : {}),
    });
    let result: unknown;
    if (operation.method === "agent.show") {
      const response = await handleAgentShow({
        agentId: operation.params.localAgentId,
      });
      if (!response.success)
        return {
          success: false,
          code: "AGENT_NOT_AVAILABLE",
          error: "AGENT_NOT_AVAILABLE",
        };
      const data = response.data as Record<string, unknown>;
      // Existing show intentionally exposes local paths and arbitrary runtime
      // configuration. Only these documented non-secret fields cross devices.
      const defaults = data.effectiveDefaults as Record<string, unknown>;
      result = {
        agentId: data.agentId, name: data.name, enabled: data.enabled,
        projectId: data.projectId, archived: data.archived, archivedAt: data.archivedAt,
        association: data.association, channelCount: data.channelCount, isCurrent: false,
        effectiveDefaults: {
          runtime: defaults.runtime,
          ...(defaults.runtimeSource ? { runtimeSource: defaults.runtimeSource } : {}),
          model: defaults.model, permissionMode: defaults.permissionMode,
          providerId: defaults.providerId, mcpEnabledServers: defaults.mcpEnabledServers,
          enabledPluginIds: defaults.enabledPluginIds,
          enabledOfficialToolIds: defaults.enabledOfficialToolIds,
        },
      };
    } else if (operation.method === "session.list") {
      const response = await handleSessionList({
        agentId: operation.params.localAgentId,
        limit: operation.params.limit,
      });
      if (!response.success)
        return {
          success: false,
          code: "AGENT_NOT_AVAILABLE",
          error: "AGENT_NOT_AVAILABLE",
        };
      result = response.data;
    } else if (operation.method === 'session.state') {
      result = await readSessionActivity(operation.params.localSessionId);
    } else {
      const response = await handleSessionGet({
        sessionId: operation.params.localSessionId,
        limit: operation.params.limit,
        before: operation.params.before,
      });
      if (!response.success)
        return {
          success: false,
          code: "SESSION_READ_FAILED",
          error: "SESSION_READ_FAILED",
        };
      result = response.session;
    }
    return {
      success: true,
      data: outcomeSchema.parse({ method: operation.method, result }),
    };
  } catch (error) {
    return failure(error);
  }
}

const watchProjectionSchema = z.strictObject({
  localAgentId: z.string().min(1).max(256),
  localSessionId: z.string().regex(/^[a-zA-Z0-9-]{1,99}$/),
  sourceSessionId: z.string().regex(/^[a-zA-Z0-9-]{1,99}$/),
  targetReference: z.string().max(256),
  result: z.strictObject({
    watchId: z.string().regex(CANONICAL_UUID),
    targetSessionId: z.string(),
    targetStateAtRegistration: z.string(),
    delivery: z.enum(["registered", "already_idle", "error", "not_found"]),
    finalState: z.string().optional(),
    terminalReason: z.string().optional(),
    latestResult: z.string().optional(),
    turnId: z.string().optional(),
    terminalStatus: z.enum(['complete', 'stopped', 'error']).optional(),
    coalesced: z.boolean().optional(),
  }),
});

/** The original watch owner has already observed or registered this target.
 * Reuse its Session Event formatter rather than creating a Rust prompt format. */
export async function handleNetworkWatchProjection(
  payload: unknown,
): Promise<Record<string, unknown>> {
  try {
    const input = watchProjectionSchema.parse(payload);
    await resolveTarget(input);
    if (input.localSessionId !== input.result.targetSessionId)
      throw new Error("SESSION_NOT_FOUND");
    const targetAgent = parseAgentReference(input.targetReference);
    const observed = input.result;
    const targetLabel = deriveSessionLabel(getSessionMetadata(input.localSessionId) ?? null);
    const latestResult = observed.delivery === 'already_idle' || observed.delivery === 'error'
      ? await readLatestSessionResult(input.localSessionId, observed) : undefined;
    const event =
      observed.delivery === "already_idle" || observed.delivery === "error"
        ? buildWatchEvent({
            type:
              observed.delivery === "already_idle"
                ? "watch.already_idle"
                : "watch.error",
            watchId: observed.watchId,
            targetSessionId: sessionReference({
              ...targetAgent,
              localSessionId: input.localSessionId,
            }),
            targetLabel,
            watcherSessionId: input.sourceSessionId,
            targetStateAtRegistration: observed.targetStateAtRegistration,
            finalState: observed.finalState,
            terminalReason: observed.terminalReason,
            latestResult: latestResult?.text ?? (latestResult?.source === 'unavailable'
              ? '(latest result unavailable)' : '(no text response)'),
            turnId: latestResult?.turnId,
            terminalStatus: latestResult?.terminalStatus,
            resultSource: latestResult?.source,
            resultScope: 'latest-session-result',
          })
        : undefined;
    const result = {
      watched:
        observed.delivery === "registered" ||
        observed.delivery === "already_idle",
      watchId: observed.watchId,
      targetSessionId: input.localSessionId,
      targetStateAtRegistration: observed.targetStateAtRegistration,
      ...(observed.turnId ? { turnId: observed.turnId } : {}),
      ...(observed.coalesced !== undefined ? { coalesced: observed.coalesced } : {}),
      ...(latestResult ? { latestResult } : {}),
      ...(observed.delivery === "not_found"
        ? {
            error: {
              code: "SESSION_NOT_FOUND",
              message: "Target session is unavailable",
            },
          }
        : { delivery: observed.delivery }),
      ...(event ? { eventPrompt: renderSessionEventPrompt(event) } : {}),
    };
    return {
      success: true,
      data: {
        outcome: outcomeSchema.parse({ method: "session.watch", result }),
      },
    };
  } catch (error) {
    return failure(error);
  }
}
