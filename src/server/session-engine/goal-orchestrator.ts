import { randomUUID } from "node:crypto";

import {
  GOAL_CONTEXT_TAG,
  GOAL_OBJECTIVE_UPDATED_TAG,
  buildGoalContextReminder,
  buildGoalObjectiveUpdatedReminder,
  parseLeadingSystemReminder,
} from "../../shared/systemReminder";
import { managementApi } from "../utils/management-api-client";
import {
  beginGoalDispatchGuard,
  clearGoalTurnAuthority,
  setGoalTurnAuthority,
} from "./goal-turn-authority";
import type { DispatchGuard } from "../session-core/turn-queue";
import type {
  BackgroundMessageRequest,
  DesktopAdmissionResult,
  DesktopMessageRequest,
  ImAdmissionResult,
  ImMessageRequest,
  SessionEngine,
} from "./types";

export type SessionGoalStatus =
  | "active"
  | "paused"
  | "complete"
  | "blocked"
  | "canceled";

export type SessionGoal = {
  id: string;
  objective: string;
  status: SessionGoalStatus;
  turnCount: number;
  revision: number;
  controlRevision: number;
  aiCanExit: boolean;
  sessionId: string;
  workspacePath: string;
  updatedAt?: string;
};

type ManagementClient = typeof managementApi;

type PreparedGoalIngress = {
  text: string;
  goal: SessionGoal | null;
  shouldAdmit: boolean;
};

type GoalAdmissionReservation = {
  id: string;
  goalId: string;
  revision: number;
  turnNumber: number;
};

export type GoalObjectiveDelivery = "persisted" | "restarted";

export type GoalObjectiveUpdateResult = {
  success: boolean;
  goal?: SessionGoal;
  delivery?: GoalObjectiveDelivery;
  error?: string;
  code?: string;
  status?: number;
};

export type GoalSchedulerRunResult<T> =
  | { success: true; value: T }
  | { success: false; error: string; code?: string; status: number };

type GoalLookupResult = {
  success: boolean;
  goal: SessionGoal | null;
  error?: string;
  code?: string;
};

type GoalAdmissionResult = {
  success: boolean;
  goal?: SessionGoal;
  reservation?: GoalAdmissionReservation;
  error?: string;
  code?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function normalizeGoal(value: unknown): SessionGoal | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const objective =
    typeof value.objective === "string" ? value.objective.trim() : "";
  const status = value.status;
  if (
    !id ||
    !objective ||
    (status !== "active" &&
      status !== "paused" &&
      status !== "complete" &&
      status !== "blocked" &&
      status !== "canceled")
  ) {
    return null;
  }
  return {
    id,
    objective,
    status,
    turnCount:
      typeof value.turnCount === "number" && Number.isFinite(value.turnCount)
        ? Math.max(0, Math.floor(value.turnCount))
        : 0,
    revision:
      typeof value.revision === "number" && Number.isFinite(value.revision)
        ? Math.max(0, Math.floor(value.revision))
        : 0,
    controlRevision:
      typeof value.controlRevision === "number" &&
      Number.isFinite(value.controlRevision)
        ? Math.max(0, Math.floor(value.controlRevision))
        : 0,
    // Old Goal records predate the explicit field and allowed autonomous exit.
    aiCanExit: value.aiCanExit !== false,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
    workspacePath:
      typeof value.workspacePath === "string" ? value.workspacePath : "",
    updatedAt:
      typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

function normalizeReservation(
  value: unknown,
  expectedGoalId: string,
): GoalAdmissionReservation | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const goalId =
    typeof value.goalId === "string" ? value.goalId.trim() : expectedGoalId;
  if (!id || !goalId) return null;
  return {
    id,
    goalId,
    revision:
      typeof value.revision === "number" && Number.isFinite(value.revision)
        ? Math.max(0, Math.floor(value.revision))
        : 0,
    turnNumber:
      typeof value.turnNumber === "number" && Number.isFinite(value.turnNumber)
        ? Math.max(1, Math.floor(value.turnNumber))
        : 1,
  };
}

function isUnfinishedGoal(goal: SessionGoal | null): goal is SessionGoal {
  return goal?.status === "active" || goal?.status === "paused";
}

function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

function isGoalControlReminder(text: string): boolean {
  const parsed = parseLeadingSystemReminder(text);
  return parsed.hasReminder && parsed.kind === GOAL_OBJECTIVE_UPDATED_TAG;
}

async function lookupSessionGoal(
  client: ManagementClient,
  sessionId: string,
  workspacePath: string,
): Promise<GoalLookupResult> {
  const query = new URLSearchParams({ sessionId, workspacePath });
  const response = await client(`/api/goal/get?${query.toString()}`);
  if (response.ok !== true) {
    return {
      success: false,
      goal: normalizeGoal(response.goal),
      error: String(response.error ?? "Goal state lookup failed"),
      code: typeof response.code === "string" ? response.code : undefined,
    };
  }
  return { success: true, goal: normalizeGoal(response.goal) };
}

async function getSessionGoal(
  client: ManagementClient,
  sessionId: string,
  workspacePath: string,
): Promise<SessionGoal | null> {
  const result = await lookupSessionGoal(client, sessionId, workspacePath);
  if (!result.success) {
    console.warn(
      `[goal] state lookup failed for session ${sessionId}: ${result.error ?? "unknown error"}`,
    );
    return null;
  }
  return isUnfinishedGoal(result.goal) ? result.goal : null;
}

async function prepareGoalIngress(
  client: ManagementClient,
  sessionId: string,
  workspacePath: string,
  text: string,
): Promise<PreparedGoalIngress> {
  if (isSlashCommand(text) || isGoalControlReminder(text)) {
    return { text, goal: null, shouldAdmit: false };
  }
  const goal = await getSessionGoal(client, sessionId, workspacePath);
  if (!goal) return { text, goal: null, shouldAdmit: false };

  const parsed = parseLeadingSystemReminder(text);
  if (parsed.hasReminder && parsed.kind === GOAL_CONTEXT_TAG) {
    // Compatibility while older renderer builds still prepare Goal context.
    // Rebuild from the reservation snapshot so stale renderer state cannot leak.
    return { text: parsed.visibleText, goal, shouldAdmit: true };
  }

  return { text, goal, shouldAdmit: true };
}

async function reserveGoalAdmission(
  client: ManagementClient,
  prepared: PreparedGoalIngress,
  sessionId: string,
  workspacePath: string,
  admissionKind: "user_query" | "objective_restart" = "user_query",
): Promise<GoalAdmissionResult> {
  if (!prepared.shouldAdmit || !prepared.goal) return { success: true };
  const admissionId = randomUUID();
  const response = await client("/api/goal/admit", "POST", {
    sessionId,
    workspacePath,
    goalId: prepared.goal.id,
    expectedRevision: prepared.goal.revision,
    expectedObjective: prepared.goal.objective,
    expectedControlRevision: prepared.goal.controlRevision,
    admissionId,
    admissionKind,
  });
  if (response.ok !== true) {
    const error = String(response.error ?? "Goal admission reservation failed");
    console.warn(
      `[goal] admission reservation failed for ${prepared.goal.id}: ${error}`,
    );
    return {
      success: false,
      goal: normalizeGoal(response.goal) ?? undefined,
      error,
      code: typeof response.code === "string" ? response.code : undefined,
    };
  }
  const goal = normalizeGoal(response.goal);
  const reservation = normalizeReservation(
    response.reservation ?? response.admission,
    goal?.id ?? "",
  );
  if (
    !goal ||
    !reservation ||
    reservation.id !== admissionId ||
    reservation.goalId !== goal.id
  ) {
    return {
      success: false,
      error: "Management API returned an invalid Goal admission reservation",
    };
  }
  return { success: true, goal, reservation };
}

async function finalizeGoalAdmission(
  client: ManagementClient,
  sessionId: string,
  workspacePath: string,
  reservation: GoalAdmissionReservation,
  outcome: "accepted" | "aborted",
): Promise<GoalAdmissionResult> {
  const response = await client("/api/goal/admit/finalize", "POST", {
    sessionId,
    workspacePath,
    goalId: reservation.goalId,
    admissionId: reservation.id,
    outcome,
  });
  if (response.ok !== true) {
    const error = String(
      response.error ?? "Goal admission finalization failed",
    );
    console.warn(
      `[goal] admission ${outcome} failed for ${reservation.goalId}: ${error}`,
    );
    return {
      success: false,
      goal: normalizeGoal(response.goal) ?? undefined,
      error,
      code: typeof response.code === "string" ? response.code : undefined,
    };
  }
  const goal = normalizeGoal(response.goal);
  if (!goal)
    return {
      success: false,
      error: "Management API returned an invalid finalized Goal",
    };
  return { success: true, goal };
}

async function claimGoalAdmission(
  client: ManagementClient,
  sessionId: string,
  workspacePath: string,
  reservation: GoalAdmissionReservation,
): Promise<GoalAdmissionResult> {
  const response = await client("/api/goal/admit/claim", "POST", {
    sessionId,
    workspacePath,
    goalId: reservation.goalId,
    admissionId: reservation.id,
  });
  if (response.ok !== true) {
    return {
      success: false,
      goal: normalizeGoal(response.goal) ?? undefined,
      error: String(response.error ?? "Goal admission claim failed"),
      code: typeof response.code === "string" ? response.code : undefined,
    };
  }
  return {
    success: true,
    goal: normalizeGoal(response.goal) ?? undefined,
    reservation,
  };
}

async function releaseGoalAdmissionAfterTurn(
  client: ManagementClient,
  engine: Pick<SessionEngine, "waitIdle">,
  sessionId: string,
  workspacePath: string,
  reservation: GoalAdmissionReservation,
): Promise<void> {
  try {
    // A user turn has no product-level one-hour deadline. Keep the admission
    // authoritative until the runtime actually reaches a boundary instead of
    // silently releasing a still-running long turn after an arbitrary timeout.
    while (!(await engine.waitIdle(3_600_000, 100))) {
      console.warn(
        `[goal] admission ${reservation.id} is still running after one hour; continuing to wait`,
      );
    }
    let retryIndex = 0;
    const retryDelaysMs = [100, 500, 2_000, 10_000, 30_000];
    while (true) {
      try {
        const response = await client("/api/goal/admit/release", "POST", {
          sessionId,
          workspacePath,
          goalId: reservation.goalId,
          admissionId: reservation.id,
        });
        if (response.ok === true) break;
        const code = typeof response.code === "string" ? response.code : "";
        if (code === "goal_changed" || code === "stale_admission") {
          break;
        }
        console.warn(
          `[goal] admission release failed for ${reservation.goalId}; retrying: ${String(response.error ?? "unknown error")}`,
        );
      } catch (error) {
        console.warn(
          `[goal] admission release request failed for ${reservation.goalId}; retrying: ${String(error)}`,
        );
      }
      const delayMs =
        retryDelaysMs[Math.min(retryIndex, retryDelaysMs.length - 1)];
      retryIndex += 1;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
      });
    }
  } finally {
    clearGoalTurnAuthority(sessionId, reservation.id);
  }
}

function createAdmissionDispatchGuard(
  client: ManagementClient,
  sessionId: string,
  workspacePath: string,
  reservation: GoalAdmissionReservation,
) {
  return async () => {
    const dispatch = beginGoalDispatchGuard(sessionId, reservation.id);
    try {
      const claimed = await claimGoalAdmission(
        client,
        sessionId,
        workspacePath,
        reservation,
      );
      if (!claimed.success) {
        return { accepted: false, error: claimed.error, code: claimed.code };
      }
      if (dispatch.isCanceled()) {
        await client("/api/goal/admit/release", "POST", {
          sessionId,
          workspacePath,
          goalId: reservation.goalId,
          admissionId: reservation.id,
        });
        return {
          accepted: false,
          error: "Goal dispatch was canceled before runtime promotion",
          code: "dispatch_canceled",
        };
      }
      setGoalTurnAuthority({
        sessionId,
        goalId: reservation.goalId,
        admissionId: reservation.id,
      });
      return { accepted: true };
    } finally {
      dispatch.settle();
    }
  };
}

function buildReservedGoalContext(
  prepared: PreparedGoalIngress,
  admission: GoalAdmissionResult,
): string {
  const goal = admission.goal;
  const reservation = admission.reservation;
  if (!goal || !reservation) return prepared.text;
  return buildGoalContextReminder({
    objective: goal.objective,
    goalId: goal.id,
    goalStatus: goal.status === "paused" ? "active" : goal.status,
    turnNumber: reservation.turnNumber,
    aiCanExit: goal.aiCanExit,
    visibleUserMessage: prepared.text,
  });
}

export function createGoalOrchestrator(
  client: ManagementClient = managementApi,
) {
  const admissionQueueBySession = new Map<string, Promise<unknown>>();

  const withAdmissionLock = async <T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous =
      admissionQueueBySession.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    admissionQueueBySession.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (admissionQueueBySession.get(sessionId) === current) {
        admissionQueueBySession.delete(sessionId);
      }
    }
  };

  const prepareIngressAdmission = (
    sessionId: string,
    workspacePath: string,
    text: string,
  ) =>
    withAdmissionLock(sessionId, async () => {
      const prepared = await prepareGoalIngress(
        client,
        sessionId,
        workspacePath,
        text,
      );
      const admission = prepared.shouldAdmit
        ? await reserveGoalAdmission(client, prepared, sessionId, workspacePath)
        : { success: true };
      return { prepared, admission };
    });

  return {
    async runClaimedSchedulerTurn<T>(
      engine: Pick<SessionEngine, "waitIdle" | "getQueueStatus">,
      request: {
        sessionId: string;
        workspacePath: string;
        goalId: string;
        leaseId: string;
        expectedRevision: number;
        timeoutMs: number;
        pollMs?: number;
      },
      run: (beforeDispatch: DispatchGuard) => Promise<T>,
    ): Promise<GoalSchedulerRunResult<T>> {
      const startedAt = Date.now();
      const pollMs = request.pollMs ?? 100;
      while (true) {
        const remainingMs = request.timeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0 || !(await engine.waitIdle(remainingMs, pollMs))) {
          return {
            success: false,
            error: "Timed out waiting for the active turn before Goal claim",
            status: 408,
          };
        }
        if (engine.getQueueStatus().length === 0) break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(pollMs, remainingMs)),
        );
      }
      let claimFailure: Extract<
        GoalSchedulerRunResult<never>,
        { success: false }
      > | null = null;
      const beforeDispatch: DispatchGuard = async () => {
        const dispatch = beginGoalDispatchGuard(
          request.sessionId,
          request.leaseId,
        );
        try {
          const response = await client("/api/goal/scheduler/claim", "POST", {
            sessionId: request.sessionId,
            workspacePath: request.workspacePath,
            goalId: request.goalId,
            leaseId: request.leaseId,
            expectedRevision: request.expectedRevision,
          });
          if (response.ok !== true) {
            claimFailure = {
              success: false,
              error: String(
                response.error ?? "Goal scheduler lease claim failed",
              ),
              code:
                typeof response.code === "string" ? response.code : undefined,
              status: 409,
            };
            return {
              accepted: false,
              error: claimFailure.error,
              code: claimFailure.code,
            };
          }
          if (dispatch.isCanceled()) {
            await client("/api/goal/scheduler/revoke", "POST", {
              sessionId: request.sessionId,
              workspacePath: request.workspacePath,
              goalId: request.goalId,
              leaseId: request.leaseId,
            });
            claimFailure = {
              success: false,
              error: "Goal scheduler dispatch was canceled before runtime promotion",
              code: "dispatch_canceled",
              status: 409,
            };
            return {
              accepted: false,
              error: claimFailure.error,
              code: claimFailure.code,
            };
          }
          setGoalTurnAuthority({
            sessionId: request.sessionId,
            goalId: request.goalId,
            leaseId: request.leaseId,
          });
          return { accepted: true };
        } finally {
          dispatch.settle();
        }
      };
      try {
        const value = await run(beforeDispatch);
        if (claimFailure) return claimFailure;
        return { success: true, value };
      } finally {
        clearGoalTurnAuthority(request.sessionId, request.leaseId);
      }
    },

    async sendDesktopMessage(
      engine: Pick<
        SessionEngine,
        "sendDesktopMessage" | "stopTurn" | "waitIdle"
      >,
      request: DesktopMessageRequest,
    ): Promise<DesktopAdmissionResult> {
      const { prepared, admission } = await prepareIngressAdmission(
        request.sessionId,
        request.workspacePath,
        request.text,
      );
      if (
        prepared.shouldAdmit &&
        (!admission.success || !admission.reservation)
      ) {
        return {
          success: false,
          error: admission.error ?? "Goal admission conflict",
          status: 409,
        };
      }
      const text =
        admission.success && admission.reservation
          ? buildReservedGoalContext(prepared, admission)
          : prepared.text;
      let result: DesktopAdmissionResult;
      try {
        result = await engine.sendDesktopMessage({
          ...request,
          text,
          beforeDispatch: admission.reservation
            ? createAdmissionDispatchGuard(
                client,
                request.sessionId,
                request.workspacePath,
                admission.reservation,
              )
            : undefined,
        });
      } catch (error) {
        if (admission.reservation) {
          await finalizeGoalAdmission(
            client,
            request.sessionId,
            request.workspacePath,
            admission.reservation,
            "aborted",
          );
          clearGoalTurnAuthority(request.sessionId, admission.reservation.id);
        }
        throw error;
      }
      const { dispatchAcceptance, ...publicResult } = result;
      if (!admission.reservation) return publicResult;
      if (!result.success || result.error) {
        await finalizeGoalAdmission(
          client,
          request.sessionId,
          request.workspacePath,
          admission.reservation,
          "aborted",
        );
        clearGoalTurnAuthority(request.sessionId, admission.reservation.id);
        return publicResult;
      }

      const settle = async (accepted: boolean) => {
        const finalized = await finalizeGoalAdmission(
          client,
          request.sessionId,
          request.workspacePath,
          admission.reservation!,
          accepted ? "accepted" : "aborted",
        );
        if (accepted && !finalized.success) {
          await engine.stopTurn();
        }
        if (accepted) {
          void releaseGoalAdmissionAfterTurn(
            client,
            engine,
            request.sessionId,
            request.workspacePath,
            admission.reservation!,
          );
        } else {
          clearGoalTurnAuthority(request.sessionId, admission.reservation!.id);
        }
      };
      if (dispatchAcceptance) {
        void dispatchAcceptance
          .then((result) => settle(result.accepted))
          .catch(async (error) => {
            console.warn(
              `[goal] dispatch acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            await settle(false);
          });
      } else {
        await settle(true);
      }
      return publicResult;
    },

    async enqueueImMessage(
      engine: Pick<SessionEngine, "enqueueImMessage" | "stopTurn" | "waitIdle">,
      request: ImMessageRequest,
    ): Promise<ImAdmissionResult> {
      const { prepared, admission } = await prepareIngressAdmission(
        request.sessionId,
        request.workspacePath,
        request.message,
      );
      if (
        prepared.shouldAdmit &&
        (!admission.success || !admission.reservation)
      ) {
        return {
          success: false,
          error: admission.error ?? "Goal admission conflict",
          status: 409,
        };
      }
      const message =
        admission.success && admission.reservation
          ? buildReservedGoalContext(prepared, admission)
          : prepared.text;
      let result: ImAdmissionResult;
      try {
        result = await engine.enqueueImMessage({
          ...request,
          message,
          beforeDispatch: admission.reservation
            ? createAdmissionDispatchGuard(
                client,
                request.sessionId,
                request.workspacePath,
                admission.reservation,
              )
            : undefined,
        });
      } catch (error) {
        if (admission.reservation) {
          await finalizeGoalAdmission(
            client,
            request.sessionId,
            request.workspacePath,
            admission.reservation,
            "aborted",
          );
          clearGoalTurnAuthority(request.sessionId, admission.reservation.id);
        }
        throw error;
      }
      if (admission.reservation) {
        const dispatchAccepted =
          result.success && !result.error
            ? await (result.dispatchAcceptance ??
                Promise.resolve({ accepted: true }))
            : { accepted: false };
        const finalized = await finalizeGoalAdmission(
          client,
          request.sessionId,
          request.workspacePath,
          admission.reservation,
          dispatchAccepted.accepted ? "accepted" : "aborted",
        );
        if (dispatchAccepted.accepted && !finalized.success) {
          await engine.stopTurn();
        }
        if (dispatchAccepted.accepted) {
          void releaseGoalAdmissionAfterTurn(
            client,
            engine,
            request.sessionId,
            request.workspacePath,
            admission.reservation,
          );
        } else {
          clearGoalTurnAuthority(request.sessionId, admission.reservation.id);
        }
      }
      const { dispatchAcceptance: _dispatchAcceptance, ...publicResult } =
        result;
      return publicResult;
    },

    async updateObjective(
      engine: Pick<
        SessionEngine,
        | "isBusy"
        | "stopTurn"
        | "waitIdle"
        | "enqueueBackgroundMessage"
        | "getQueueStatus"
      >,
      request: {
        sessionId: string;
        workspacePath: string;
        objective: string;
        turnRequest: Omit<
          BackgroundMessageRequest,
          "text" | "sessionId" | "workspacePath"
        >;
      },
    ): Promise<GoalObjectiveUpdateResult> {
      return withAdmissionLock(request.sessionId, async () => {
        const initial = await lookupSessionGoal(
          client,
          request.sessionId,
          request.workspacePath,
        );
        if (!initial.success || !isUnfinishedGoal(initial.goal)) {
          return {
            success: false,
            goal: initial.goal ?? undefined,
            error: initial.error ?? "No active Goal in current session",
            code: initial.code ?? "goal_changed",
            status: 409,
          };
        }
        const queuedMessages = engine.getQueueStatus();
        if (queuedMessages.length > 0) {
          return {
            success: false,
            goal: initial.goal,
            error:
              "Wait for queued user messages to finish or cancel them before editing the Goal objective.",
            code: "queue_conflict",
            status: 409,
          };
        }
        if (engine.isBusy()) {
          const stopped = await engine.stopTurn();
          if (!stopped.success) {
            return {
              success: false,
              goal: initial.goal,
              error: stopped.error ?? "Failed to stop active Goal turn",
              status: 503,
            };
          }
          const idle = await engine.waitIdle(30_000, 100);
          if (!idle) {
            return {
              success: false,
              goal: initial.goal,
              error: "Timed out waiting for Goal turn to stop",
              status: 408,
            };
          }
        }

        const current = await lookupSessionGoal(
          client,
          request.sessionId,
          request.workspacePath,
        );
        if (
          !current.success ||
          !isUnfinishedGoal(current.goal) ||
          current.goal.id !== initial.goal.id ||
          current.goal.objective !== initial.goal.objective
        ) {
          return {
            success: false,
            goal: current.goal ?? initial.goal,
            error:
              current.error ??
              "Goal changed or became terminal before objective update",
            code: current.code ?? "goal_changed",
            status: 409,
          };
        }

        const response = await client("/api/goal/objective", "POST", {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          objective: request.objective,
          goalId: current.goal.id,
          expectedRevision: current.goal.revision,
        });
        if (response.ok !== true) {
          return {
            success: false,
            goal: normalizeGoal(response.goal) ?? undefined,
            error: String(response.error ?? "Failed to update Goal objective"),
            code: typeof response.code === "string" ? response.code : undefined,
            status: 409,
          };
        }
        const goal = normalizeGoal(response.goal);
        if (!goal) {
          return {
            success: false,
            error: "Management API returned an invalid Goal",
            status: 502,
          };
        }
        if (
          goal.id !== current.goal.id ||
          goal.objective !== request.objective ||
          goal.revision <= current.goal.revision
        ) {
          return {
            success: false,
            goal,
            error: "Goal changed during objective update",
            code: "goal_changed",
            status: 409,
          };
        }

        // Close the claim-after-isBusy TOCTOU window. A scheduler/user turn may
        // have promoted while the revision CAS was in flight; the CAS revoked
        // its authority, and this stop prevents the stale prompt from reaching
        // tools before we enqueue the updated objective.
        const stoppedAfterUpdate = await engine.stopTurn();
        if (!stoppedAfterUpdate.success) {
          return {
            success: false,
            goal,
            error:
              stoppedAfterUpdate.error ??
              "Goal objective updated, but the stale turn could not be stopped",
            status: 503,
          };
        }
        if (!(await engine.waitIdle(30_000, 100))) {
          return {
            success: false,
            goal,
            error:
              "Goal objective updated, but the stale turn did not stop in time",
            status: 408,
          };
        }
        const settled = await lookupSessionGoal(
          client,
          request.sessionId,
          request.workspacePath,
        );
        if (
          !settled.success ||
          !isUnfinishedGoal(settled.goal) ||
          settled.goal.id !== goal.id ||
          settled.goal.objective !== goal.objective
        ) {
          return {
            success: false,
            goal: settled.goal ?? goal,
            error:
              settled.error ??
              "Goal changed or became terminal after objective update",
            code: settled.code ?? "goal_changed",
            status: 409,
          };
        }
        if (
          settled.goal.status === "paused" ||
          settled.goal.revision > goal.revision
        ) {
          return { success: true, goal: settled.goal, delivery: "persisted" };
        }

        const admission = await reserveGoalAdmission(
          client,
          { text: "", goal: settled.goal, shouldAdmit: true },
          request.sessionId,
          request.workspacePath,
          "objective_restart",
        );
        if (!admission.success || !admission.goal || !admission.reservation) {
          if (admission.code === "lease_conflict") {
            // The scheduler already owns the next turn under this objective
            // revision, so a second manual restart would duplicate work.
            return {
              success: true,
              goal: admission.goal ?? settled.goal,
              delivery: "persisted",
            };
          }
          return {
            success: false,
            goal: admission.goal ?? settled.goal,
            error:
              admission.error ?? "Failed to reserve the updated Goal restart",
            code: admission.code ?? "stale_revision",
            status: 409,
          };
        }

        const reminder = buildGoalObjectiveUpdatedReminder({
          objective: admission.goal.objective,
          goalId: admission.goal.id,
          goalStatus: admission.goal.status,
          turnNumber: admission.reservation.turnNumber,
          aiCanExit: admission.goal.aiCanExit,
        });
        const turnRequest: BackgroundMessageRequest = {
          ...request.turnRequest,
          text: reminder,
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          beforeDispatch: createAdmissionDispatchGuard(
            client,
            request.sessionId,
            request.workspacePath,
            admission.reservation,
          ),
        };
        let restarted: ImAdmissionResult;
        try {
          restarted = await engine.enqueueBackgroundMessage(turnRequest);
        } catch (error) {
          await finalizeGoalAdmission(
            client,
            request.sessionId,
            request.workspacePath,
            admission.reservation,
            "aborted",
          );
          clearGoalTurnAuthority(request.sessionId, admission.reservation.id);
          throw error;
        }
        const dispatchAccepted =
          restarted.success && !restarted.error
            ? await (restarted.dispatchAcceptance ??
                Promise.resolve({ accepted: true }))
            : { accepted: false };
        if (!restarted.success || !dispatchAccepted.accepted) {
          await finalizeGoalAdmission(
            client,
            request.sessionId,
            request.workspacePath,
            admission.reservation,
            "aborted",
          );
          clearGoalTurnAuthority(request.sessionId, admission.reservation.id);
          return {
            success: false,
            goal: admission.goal,
            error:
              restarted.error ??
              "Failed to restart Goal with the updated objective",
            status: restarted.status ?? 503,
          };
        }
        const committed = await finalizeGoalAdmission(
          client,
          request.sessionId,
          request.workspacePath,
          admission.reservation,
          "accepted",
        );
        if (!committed.success) {
          await engine.stopTurn();
          void releaseGoalAdmissionAfterTurn(
            client,
            engine,
            request.sessionId,
            request.workspacePath,
            admission.reservation,
          );
          return {
            success: false,
            goal: committed.goal ?? admission.goal,
            error:
              committed.error ??
              "Goal changed after objective restart admission",
            code: committed.code ?? "stale_revision",
            status: 409,
          };
        }
        void releaseGoalAdmissionAfterTurn(
          client,
          engine,
          request.sessionId,
          request.workspacePath,
          admission.reservation,
        );
        return { success: true, goal: committed.goal, delivery: "restarted" };
      });
    },
  };
}

export const goalOrchestrator = createGoalOrchestrator();
