import { randomUUID } from "node:crypto";

import {
  GOAL_CONTEXT_TAG,
  GOAL_OBJECTIVE_UPDATED_TAG,
  buildGoalContextReminder,
  buildGoalObjectiveUpdatedReminder,
  parseLeadingSystemReminder,
} from "../../shared/systemReminder";
import { workspacePathsEqual } from "../../shared/workspacePath";
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

type PreparedGoalIngressResult =
  | { success: true; prepared: PreparedGoalIngress }
  | { success: false; error: string; code?: string };

type GoalAdmissionReservation = {
  id: string;
  goalId: string;
  revision: number;
  turnNumber: number;
};

type GoalAdmissionIdentity = Pick<GoalAdmissionReservation, "id" | "goalId">;

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
  requiresCompensation?: boolean;
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
  const turnCount = value.turnCount;
  const revision = value.revision;
  const controlRevision = value.controlRevision;
  const sessionId =
    typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const workspacePath =
    typeof value.workspacePath === "string" ? value.workspacePath.trim() : "";
  if (
    !id ||
    !objective ||
    !Number.isInteger(turnCount) ||
    (turnCount as number) < 0 ||
    !Number.isInteger(revision) ||
    (revision as number) < 0 ||
    !Number.isInteger(controlRevision) ||
    (controlRevision as number) < 0 ||
    typeof value.aiCanExit !== "boolean" ||
    !sessionId ||
    !workspacePath ||
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
    turnCount: turnCount as number,
    revision: revision as number,
    controlRevision: controlRevision as number,
    aiCanExit: value.aiCanExit,
    sessionId,
    workspacePath,
    updatedAt:
      typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

function normalizeReservation(
  value: unknown,
): GoalAdmissionReservation | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const goalId =
    typeof value.goalId === "string" ? value.goalId.trim() : "";
  if (
    !id ||
    !goalId ||
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Number.isInteger(value.turnNumber) ||
    (value.turnNumber as number) < 1
  ) {
    return null;
  }
  return {
    id,
    goalId,
    revision: value.revision as number,
    turnNumber: value.turnNumber as number,
  };
}

function goalMatchesIdentity(
  goal: SessionGoal | null,
  goalId: string,
  sessionId: string,
  workspacePath: string,
): goal is SessionGoal {
  return Boolean(
    goal
      && goal.id === goalId
      && goal.sessionId === sessionId
      && workspacePathsEqual(goal.workspacePath, workspacePath),
  );
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
  let response: Record<string, unknown>;
  try {
    response = await client(`/api/goal/get?${query.toString()}`);
  } catch (error) {
    return {
      success: false,
      goal: null,
      error: error instanceof Error ? error.message : String(error),
      code: "goal_lookup_unavailable",
    };
  }
  if (response.ok !== true) {
    return {
      success: false,
      goal: normalizeGoal(response.goal),
      error: String(response.error ?? "Goal state lookup failed"),
      code: typeof response.code === "string" ? response.code : undefined,
    };
  }
  if (response.goal == null) return { success: true, goal: null };
  const goal = normalizeGoal(response.goal);
  if (
    !goal ||
    goal.sessionId !== sessionId ||
    !workspacePathsEqual(goal.workspacePath, workspacePath)
  ) {
    return {
      success: false,
      goal: null,
      error: "Management API returned an invalid Goal",
      code: "invalid_goal_payload",
    };
  }
  return { success: true, goal };
}

async function prepareGoalIngress(
  client: ManagementClient,
  sessionId: string,
  workspacePath: string,
  text: string,
): Promise<PreparedGoalIngressResult> {
  if (isSlashCommand(text) || isGoalControlReminder(text)) {
    return {
      success: true,
      prepared: { text, goal: null, shouldAdmit: false },
    };
  }
  const lookup = await lookupSessionGoal(client, sessionId, workspacePath);
  if (!lookup.success) {
    console.warn(
      `[goal] state lookup failed for session ${sessionId}: ${lookup.error ?? "unknown error"}`,
    );
    return {
      success: false,
      error: lookup.error ?? "Goal state lookup failed",
      code: lookup.code,
    };
  }
  const goal = isUnfinishedGoal(lookup.goal) ? lookup.goal : null;
  if (!goal) {
    return {
      success: true,
      prepared: { text, goal: null, shouldAdmit: false },
    };
  }

  const parsed = parseLeadingSystemReminder(text);
  if (parsed.hasReminder && parsed.kind === GOAL_CONTEXT_TAG) {
    // Compatibility while older renderer builds still prepare Goal context.
    // Rebuild from the reservation snapshot so stale renderer state cannot leak.
    return {
      success: true,
      prepared: { text: parsed.visibleText, goal, shouldAdmit: true },
    };
  }

  return { success: true, prepared: { text, goal, shouldAdmit: true } };
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
  const admissionIdentity: GoalAdmissionIdentity = {
    id: admissionId,
    goalId: prepared.goal.id,
  };
  let response: Record<string, unknown>;
  try {
    response = await client("/api/goal/admit", "POST", {
      sessionId,
      workspacePath,
      goalId: prepared.goal.id,
      expectedRevision: prepared.goal.revision,
      expectedObjective: prepared.goal.objective,
      expectedControlRevision: prepared.goal.controlRevision,
      admissionId,
      admissionKind,
    });
  } catch (error) {
    detachAdmissionLifecycle(
      releaseGoalAdmissionUntilSettled(
        client,
        sessionId,
        workspacePath,
        admissionIdentity,
      ),
      admissionId,
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: "transport_outcome_unknown",
    };
  }
  if (response.ok !== true) {
    const error = String(response.error ?? "Goal admission reservation failed");
    console.warn(
      `[goal] admission reservation failed for ${prepared.goal.id}: ${error}`,
    );
    if (isTransportOutcomeUnknown(response.code)) {
      detachAdmissionLifecycle(
        releaseGoalAdmissionUntilSettled(
          client,
          sessionId,
          workspacePath,
          admissionIdentity,
        ),
        admissionId,
      );
    }
    return {
      success: false,
      goal: normalizeGoal(response.goal) ?? undefined,
      error,
      code: typeof response.code === "string" ? response.code : undefined,
    };
  }
  const goal = normalizeGoal(response.goal);
  const reservation = normalizeReservation(response.reservation ?? response.admission);
  if (
    !goalMatchesIdentity(goal, prepared.goal.id, sessionId, workspacePath) ||
    !isUnfinishedGoal(goal) ||
    !reservation ||
    reservation.id !== admissionId ||
    reservation.goalId !== goal.id ||
    reservation.revision !== goal.revision
  ) {
    detachAdmissionLifecycle(
      releaseGoalAdmissionUntilSettled(
        client,
        sessionId,
        workspacePath,
        admissionIdentity,
      ),
      admissionId,
    );
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
  if (!goalMatchesIdentity(goal, reservation.goalId, sessionId, workspacePath))
    return {
      success: false,
      error: "Management API returned an invalid finalized Goal",
      code: "invalid_goal_payload",
    };
  return { success: true, goal };
}

async function claimGoalAdmission(
  client: ManagementClient,
  sessionId: string,
  workspacePath: string,
  reservation: GoalAdmissionReservation,
): Promise<GoalAdmissionResult> {
  let response: Record<string, unknown>;
  try {
    response = await client("/api/goal/admit/claim", "POST", {
      sessionId,
      workspacePath,
      goalId: reservation.goalId,
      admissionId: reservation.id,
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: "claim_outcome_unknown",
      requiresCompensation: true,
    };
  }
  if (response.ok !== true) {
    return {
      success: false,
      goal: normalizeGoal(response.goal) ?? undefined,
      error: String(response.error ?? "Goal admission claim failed"),
      code: typeof response.code === "string" ? response.code : undefined,
      requiresCompensation: isTransportOutcomeUnknown(response.code),
    };
  }
  const goal = normalizeGoal(response.goal);
  const claimedReservation = normalizeReservation(response.reservation);
  if (
    !goalMatchesIdentity(goal, reservation.goalId, sessionId, workspacePath) ||
    !isUnfinishedGoal(goal) ||
    !claimedReservation ||
    claimedReservation.id !== reservation.id ||
    claimedReservation.goalId !== reservation.goalId ||
    claimedReservation.revision !== reservation.revision ||
    claimedReservation.turnNumber !== reservation.turnNumber
  ) {
    return {
      success: false,
      error: "Management API returned an invalid claimed Goal",
      code: "invalid_goal_payload",
      requiresCompensation: true,
    };
  }
  return {
    success: true,
    goal,
    reservation,
  };
}

function isAdmissionAlreadyGone(code: string | undefined): boolean {
  return code === "goal_changed" || code === "stale_admission";
}

function isTransportOutcomeUnknown(code: unknown): boolean {
  return code === "transport_outcome_unknown";
}

function admissionRetryDelay(retryIndex: number): number {
  const retryDelaysMs = [100, 500, 2_000, 10_000, 30_000];
  return retryDelaysMs[Math.min(retryIndex, retryDelaysMs.length - 1)];
}

async function waitForRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function retryManagementMutationUntilSettled(
  client: ManagementClient,
  path: string,
  body: Record<string, unknown>,
  label: string,
  isAlreadySettled: (code: string | undefined) => boolean,
): Promise<void> {
  let retryIndex = 0;
  while (true) {
    try {
      const response = await client(path, "POST", body);
      const code = typeof response.code === "string" ? response.code : undefined;
      if (response.ok === true || isAlreadySettled(code)) return;
      console.warn(
        `[goal] ${label} failed; retrying: ${String(response.error ?? "unknown error")}`,
      );
    } catch (error) {
      console.warn(`[goal] ${label} request failed; retrying: ${String(error)}`);
    }
    await waitForRetry(admissionRetryDelay(retryIndex));
    retryIndex += 1;
  }
}

async function releaseGoalAdmissionUntilSettled(
  client: ManagementClient,
  sessionId: string,
  workspacePath: string,
  reservation: GoalAdmissionIdentity,
): Promise<void> {
  await retryManagementMutationUntilSettled(
    client,
    "/api/goal/admit/release",
    {
      sessionId,
      workspacePath,
      goalId: reservation.goalId,
      admissionId: reservation.id,
    },
    `admission release for ${reservation.goalId}`,
    isAdmissionAlreadyGone,
  );
  clearGoalTurnAuthority(sessionId, reservation.id);
}

function isSchedulerLeaseAlreadyGone(code: string | undefined): boolean {
  return code === "goal_changed" || code === "stale_lease" || code === "terminal";
}

async function revokeGoalSchedulerLeaseUntilSettled(
  client: ManagementClient,
  request: {
    sessionId: string;
    workspacePath: string;
    goalId: string;
    leaseId: string;
  },
): Promise<void> {
  await retryManagementMutationUntilSettled(
    client,
    "/api/goal/scheduler/revoke",
    request,
    `scheduler lease revoke for ${request.goalId}`,
    isSchedulerLeaseAlreadyGone,
  );
}

async function releaseGoalAdmissionAfterTurn(
  client: ManagementClient,
  engine: Pick<SessionEngine, "waitIdle">,
  sessionId: string,
  workspacePath: string,
  reservation: GoalAdmissionIdentity,
): Promise<void> {
  // A user turn has no product-level one-hour deadline. Keep both durable and
  // in-process authority until the runtime actually reaches a boundary.
  let waitRetryIndex = 0;
  while (true) {
    try {
      if (await engine.waitIdle(3_600_000, 100)) break;
      console.warn(
        `[goal] admission ${reservation.id} is still running after one hour; continuing to wait`,
      );
    } catch (error) {
      console.warn(
        `[goal] admission ${reservation.id} idle check failed; retrying: ${String(error)}`,
      );
      await waitForRetry(admissionRetryDelay(waitRetryIndex));
      waitRetryIndex += 1;
    }
  }
  await releaseGoalAdmissionUntilSettled(
    client,
    sessionId,
    workspacePath,
    reservation,
  );
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
        if (claimed.requiresCompensation) {
          detachAdmissionLifecycle(
            releaseGoalAdmissionUntilSettled(
              client,
              sessionId,
              workspacePath,
              reservation,
            ),
            reservation.id,
          );
        }
        return { accepted: false, error: claimed.error, code: claimed.code };
      }
      if (dispatch.isCanceled()) {
        detachAdmissionLifecycle(
          releaseGoalAdmissionUntilSettled(
            client,
            sessionId,
            workspacePath,
            reservation,
          ),
          reservation.id,
        );
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

type DispatchAcknowledgement = { accepted: boolean; error?: string };
type ResolvedDispatchAcknowledgement = {
  outcome: "accepted" | "rejected" | "unknown";
  error?: string;
};

type GoalAdmissionSettlement = {
  accepted: boolean;
  committed: boolean;
  goal?: SessionGoal;
  error?: string;
  code?: string;
};

async function resolveDispatchAcknowledgement(
  acknowledgement: Promise<DispatchAcknowledgement> | undefined,
): Promise<ResolvedDispatchAcknowledgement> {
  if (!acknowledgement) return { outcome: "accepted" };
  try {
    const resolved = await acknowledgement;
    return {
      outcome: resolved.accepted ? "accepted" : "rejected",
      error: resolved.error,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[goal] dispatch acknowledgement failed: ${message}`);
    return { outcome: "unknown", error: message };
  }
}

function detachAdmissionLifecycle(lifecycle: Promise<void>, reservationId: string): void {
  void lifecycle.catch((error) => {
    // The cleanup loop handles transport failures internally. This catch is a
    // last-resort guard for programmer/runtime errors; authority intentionally
    // remains installed so a later Stop or process restart still fails closed.
    console.error(
      `[goal] admission ${reservationId} cleanup stopped unexpectedly: ${String(error)}`,
    );
  });
}

async function abortGoalAdmission(
  client: ManagementClient,
  engine: Pick<SessionEngine, "waitIdle"> | null,
  sessionId: string,
  workspacePath: string,
  reservation: GoalAdmissionReservation,
  waitForIdle: boolean = false,
): Promise<void> {
  let finalized: GoalAdmissionResult;
  try {
    finalized = await finalizeGoalAdmission(
      client,
      sessionId,
      workspacePath,
      reservation,
      "aborted",
    );
  } catch (error) {
    finalized = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!waitForIdle && (finalized.success || isAdmissionAlreadyGone(finalized.code))) {
    clearGoalTurnAuthority(sessionId, reservation.id);
    return;
  }
  if (waitForIdle && engine) {
    detachAdmissionLifecycle(
      releaseGoalAdmissionAfterTurn(
        client,
        engine,
        sessionId,
        workspacePath,
        reservation,
      ),
      reservation.id,
    );
    return;
  }
  detachAdmissionLifecycle(
    releaseGoalAdmissionUntilSettled(
      client,
      sessionId,
      workspacePath,
      reservation,
    ),
    reservation.id,
  );
}

async function settleGoalAdmission(
  client: ManagementClient,
  engine: Pick<SessionEngine, "stopTurn" | "waitIdle">,
  sessionId: string,
  workspacePath: string,
  reservation: GoalAdmissionReservation,
  acknowledgement: ResolvedDispatchAcknowledgement,
): Promise<GoalAdmissionSettlement> {
  if (acknowledgement.outcome !== "accepted") {
    if (acknowledgement.outcome === "unknown") {
      try {
        const stopped = await engine.stopTurn();
        if (!stopped.success) {
          console.warn(
            `[goal] failed to stop admission ${reservation.id} after unknown dispatch acknowledgement: ${stopped.error ?? "unknown error"}`,
          );
        }
      } catch (error) {
        console.warn(
          `[goal] failed to stop admission ${reservation.id} after unknown dispatch acknowledgement: ${String(error)}`,
        );
      }
    }
    await abortGoalAdmission(
      client,
      acknowledgement.outcome === "unknown" ? engine : null,
      sessionId,
      workspacePath,
      reservation,
      acknowledgement.outcome === "unknown",
    );
    return {
      accepted: false,
      committed: false,
      error: acknowledgement.error,
    };
  }

  let finalized: GoalAdmissionResult;
  try {
    finalized = await finalizeGoalAdmission(
      client,
      sessionId,
      workspacePath,
      reservation,
      "accepted",
    );
  } catch (error) {
    finalized = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!finalized.success) {
    try {
      const stopped = await engine.stopTurn();
      if (!stopped.success) {
        console.warn(
          `[goal] failed to stop uncommitted admission ${reservation.id}: ${stopped.error ?? "unknown error"}`,
        );
      }
    } catch (error) {
      console.warn(
        `[goal] failed to stop uncommitted admission ${reservation.id}: ${String(error)}`,
      );
    }
  }

  // Transport accepted the turn. Even when durable finalization reports the
  // admission already gone, keep in-process authority until the runtime is
  // actually idle; durable absence does not prove the accepted turn stopped.
  detachAdmissionLifecycle(
    releaseGoalAdmissionAfterTurn(
      client,
      engine,
      sessionId,
      workspacePath,
      reservation,
    ),
    reservation.id,
  );

  return {
    accepted: true,
    committed: finalized.success,
    goal: finalized.goal,
    error: finalized.error,
    code: finalized.code,
  };
}

export function createGoalOrchestrator(
  client: ManagementClient = managementApi,
) {
  // A Sidecar owns one session; one chain serializes its lookup+reserve/CAS mutations.
  let admissionMutationQueue: Promise<unknown> = Promise.resolve();

  const withAdmissionLock = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = admissionMutationQueue;
    const current = previous.catch(() => undefined).then(operation);
    admissionMutationQueue = current;
    try {
      return await current;
    } finally {
      if (admissionMutationQueue === current) admissionMutationQueue = Promise.resolve();
    }
  };

  const prepareIngressAdmission = (
    sessionId: string,
    workspacePath: string,
    text: string,
  ) =>
    withAdmissionLock(async () => {
      const preparation = await prepareGoalIngress(
        client,
        sessionId,
        workspacePath,
        text,
      );
      if (!preparation.success) return preparation;
      const prepared = preparation.prepared;
      const admission = prepared.shouldAdmit
        ? await reserveGoalAdmission(client, prepared, sessionId, workspacePath)
        : { success: true };
      return { success: true as const, prepared, admission };
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
          const claimIdentity = {
            sessionId: request.sessionId,
            workspacePath: request.workspacePath,
            goalId: request.goalId,
            leaseId: request.leaseId,
          };
          let response: Record<string, unknown>;
          try {
            response = await client("/api/goal/scheduler/claim", "POST", {
              ...claimIdentity,
              expectedRevision: request.expectedRevision,
            });
          } catch (error) {
            await revokeGoalSchedulerLeaseUntilSettled(client, claimIdentity);
            claimFailure = {
              success: false,
              error: error instanceof Error ? error.message : String(error),
              code: "claim_outcome_unknown",
              status: 503,
            };
            return { accepted: false, error: claimFailure.error, code: claimFailure.code };
          }
          if (response.ok !== true) {
            const outcomeUnknown = isTransportOutcomeUnknown(response.code);
            if (outcomeUnknown) {
              await revokeGoalSchedulerLeaseUntilSettled(client, claimIdentity);
            }
            claimFailure = {
              success: false,
              error: String(
                response.error ?? "Goal scheduler lease claim failed",
              ),
              code:
                typeof response.code === "string" ? response.code : undefined,
              status: outcomeUnknown ? 503 : 409,
            };
            return {
              accepted: false,
              error: claimFailure.error,
              code: claimFailure.code,
            };
          }
          const claimedGoal = normalizeGoal(response.goal);
          const claimedLease = normalizeReservation(response.lease);
          if (
            !goalMatchesIdentity(
              claimedGoal,
              request.goalId,
              request.sessionId,
              request.workspacePath,
            ) ||
            claimedGoal.status !== "active" ||
            !claimedLease ||
            claimedLease.id !== request.leaseId ||
            claimedLease.goalId !== request.goalId ||
            claimedLease.revision !== claimedGoal.revision ||
            claimedLease.turnNumber !== claimedGoal.turnCount + 1
          ) {
            await revokeGoalSchedulerLeaseUntilSettled(client, claimIdentity);
            claimFailure = {
              success: false,
              error: "Management API returned an invalid scheduler claim",
              code: "invalid_goal_payload",
              status: 502,
            };
            return { accepted: false, error: claimFailure.error, code: claimFailure.code };
          }
          if (dispatch.isCanceled()) {
            await revokeGoalSchedulerLeaseUntilSettled(client, claimIdentity);
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
      const ingress = await prepareIngressAdmission(
        request.sessionId,
        request.workspacePath,
        request.text,
      );
      if (!ingress.success) {
        return {
          success: false,
          error: ingress.error,
          status: 503,
        };
      }
      const { prepared, admission } = ingress;
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
          await settleGoalAdmission(
            client,
            engine,
            request.sessionId,
            request.workspacePath,
            admission.reservation,
            {
              outcome: "unknown",
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
        throw error;
      }
      const { dispatchAcceptance, ...publicResult } = result;
      if (!admission.reservation) return publicResult;
      if (!result.success || result.error) {
        await abortGoalAdmission(
          client,
          null,
          request.sessionId,
          request.workspacePath,
          admission.reservation,
        );
        return publicResult;
      }

      const settlement = resolveDispatchAcknowledgement(dispatchAcceptance).then(
        (acknowledgement) =>
          settleGoalAdmission(
            client,
            engine,
            request.sessionId,
            request.workspacePath,
            admission.reservation!,
            acknowledgement,
          ),
      );
      if (dispatchAcceptance) {
        detachAdmissionLifecycle(
          settlement.then(() => undefined),
          admission.reservation.id,
        );
      } else {
        await settlement;
      }
      return publicResult;
    },

    async enqueueImMessage(
      engine: Pick<SessionEngine, "enqueueImMessage" | "stopTurn" | "waitIdle">,
      request: ImMessageRequest,
    ): Promise<ImAdmissionResult> {
      const ingress = await prepareIngressAdmission(
        request.sessionId,
        request.workspacePath,
        request.message,
      );
      if (!ingress.success) {
        return {
          success: false,
          error: ingress.error,
          status: 503,
        };
      }
      const { prepared, admission } = ingress;
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
          await settleGoalAdmission(
            client,
            engine,
            request.sessionId,
            request.workspacePath,
            admission.reservation,
            {
              outcome: "unknown",
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
        throw error;
      }
      if (admission.reservation) {
        const acknowledgement =
          result.success && !result.error
            ? await resolveDispatchAcknowledgement(result.dispatchAcceptance)
            : { outcome: "rejected" as const, error: result.error };
        await settleGoalAdmission(
          client,
          engine,
          request.sessionId,
          request.workspacePath,
          admission.reservation,
          acknowledgement,
        );
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
      return withAdmissionLock(async () => {
        const initial = await lookupSessionGoal(
          client,
          request.sessionId,
          request.workspacePath,
        );
        if (!initial.success) {
          return {
            success: false,
            error: initial.error ?? "Goal state lookup failed",
            code: initial.code,
            status: 503,
          };
        }
        if (!isUnfinishedGoal(initial.goal)) {
          return {
            success: false,
            goal: initial.goal ?? undefined,
            error: "No active Goal in current session",
            code: "goal_changed",
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
        if (!current.success) {
          return {
            success: false,
            goal: initial.goal,
            error: current.error ?? "Goal state lookup failed",
            code: current.code,
            status: 503,
          };
        }
        if (
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

        let response: Record<string, unknown>;
        try {
          response = await client("/api/goal/objective", "POST", {
            sessionId: request.sessionId,
            workspacePath: request.workspacePath,
            objective: request.objective,
            goalId: current.goal.id,
            expectedRevision: current.goal.revision,
          });
        } catch (error) {
          response = {
            ok: false,
            code: "transport_outcome_unknown",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        let goal: SessionGoal | null;
        if (response.ok !== true) {
          if (!isTransportOutcomeUnknown(response.code)) {
            return {
              success: false,
              goal: normalizeGoal(response.goal) ?? undefined,
              error: String(response.error ?? "Failed to update Goal objective"),
              code: typeof response.code === "string" ? response.code : undefined,
              status: 409,
            };
          }
          // The CAS may have committed before the response was lost. Stop any
          // stale-objective turn first, then resolve the outcome from Rust.
          const stopped = await engine.stopTurn();
          if (!stopped.success) {
            return {
              success: false,
              goal: current.goal,
              error: stopped.error ?? "Objective update outcome is unknown and the stale turn could not be stopped",
              code: "transport_outcome_unknown",
              status: 503,
            };
          }
          if (!(await engine.waitIdle(30_000, 100))) {
            return {
              success: false,
              goal: current.goal,
              error: "Objective update outcome is unknown and the stale turn did not stop in time",
              code: "transport_outcome_unknown",
              status: 408,
            };
          }
          const resolved = await lookupSessionGoal(
            client,
            request.sessionId,
            request.workspacePath,
          );
          if (!resolved.success || !resolved.goal) {
            return {
              success: false,
              goal: current.goal,
              error: resolved.error ?? "Could not resolve objective update outcome",
              code: resolved.code ?? "transport_outcome_unknown",
              status: 503,
            };
          }
          goal = resolved.goal;
        } else {
          goal = normalizeGoal(response.goal);
        }
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
        if (!settled.success) {
          return {
            success: false,
            goal,
            error: settled.error ?? "Goal state lookup failed",
            code: settled.code,
            status: 503,
          };
        }
        if (
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
          await settleGoalAdmission(
            client,
            engine,
            request.sessionId,
            request.workspacePath,
            admission.reservation,
            {
              outcome: "unknown",
              error: error instanceof Error ? error.message : String(error),
            },
          );
          throw error;
        }
        const acknowledgement =
          restarted.success && !restarted.error
            ? await resolveDispatchAcknowledgement(restarted.dispatchAcceptance)
            : { outcome: "rejected" as const, error: restarted.error };
        const settlement = await settleGoalAdmission(
          client,
          engine,
          request.sessionId,
          request.workspacePath,
          admission.reservation,
          acknowledgement,
        );
        if (!restarted.success || !settlement.accepted) {
          return {
            success: false,
            goal: admission.goal,
            error:
              restarted.error ??
              settlement.error ??
              "Failed to restart Goal with the updated objective",
            status: restarted.status ?? 503,
          };
        }
        if (!settlement.committed) {
          return {
            success: false,
            goal: settlement.goal ?? admission.goal,
            error:
              settlement.error ??
              "Goal changed after objective restart admission",
            code: settlement.code ?? "stale_revision",
            status: 409,
          };
        }
        return {
          success: true,
          goal: settlement.goal,
          delivery: "restarted",
        };
      });
    },
  };
}

export const goalOrchestrator = createGoalOrchestrator();
