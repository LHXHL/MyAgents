import type { SessionEngine, InboxAdmissionResult } from "./types";
import type { TaskResultEvent } from "../inbox/session-event";
import { managementApi } from "../utils/management-api-client";

/** Task owns delivery into the target Session, not the model's response or IM
 * transport. Observe native dispatch acceptance without holding the Inbox lease. */
export async function admitTaskNotification(
  engine: SessionEngine,
  event: TaskResultEvent,
  prompt: string,
  workspacePath: string,
): Promise<InboxAdmissionResult> {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID;
  if (!sidecarId || engine.getCurrentSessionContext().sessionId !== event.targetSessionId)
    return { queued: false, error: "Notification target Session mismatch" };
  const identity = { sidecarId, taskId: event.taskId, deliveryId: event.deliveryId, attemptId: event.attemptId };
  let rejection: string | undefined;
  const guard = async () => {
    const response = await managementApi("/api/task/notification/authorize", "POST", identity);
    if (response.accepted === true && response.ok === true) return { accepted: true as const };
    rejection = typeof response.code === "string" ? response.code : "failed";
    return { accepted: false as const, code: rejection, error: String(response.error ?? "Notification no longer authorized") };
  };
  const settle = async (outcome: string, error?: string) => {
    const response = await managementApi("/api/task/notification/terminal", "POST", { ...identity, outcome, error });
    if (response.ok !== true) throw new Error(String(response.error ?? "Notification receipt not committed"));
  };
  const accepted = await guard();
  if (!accepted.accepted) {
    await settle(rejection ?? "failed", accepted.error);
    return { queued: false, error: accepted.error };
  }
  // No self-directed second turn: the originating Session already has the result.
  if (event.sameSession) {
    if (event.statusOnly) await engine.recordNotificationEvent(`task-notification-${event.deliveryId}`, prompt);
    await settle("handed-off");
    return { queued: false };
  }
  let result: InboxAdmissionResult;
  try {
    result = await engine.enqueueInboxMessage({
      text: prompt,
      sessionId: event.targetSessionId,
      workspacePath,
      queueId: event.attemptId,
      analyticsOrigin: { kind: "automation", surface: "task_notification" },
      beforeDispatch: guard,
    });
  } catch (error) {
    await settle("unknown", String(error));
    return { queued: false, error: String(error) };
  }
  if (result.error) {
    await settle(rejection ?? "failed", result.error);
    return result;
  }
  const acceptance: NonNullable<InboxAdmissionResult["dispatchAcceptance"]> =
    result.dispatchAcceptance ?? Promise.resolve({ accepted: true });
  // The ordinary Inbox/Runtime owns the input and any resulting reply. A later
  // provider error cannot retract an already accepted Task result.
  void acceptance.then(async (dispatch) => {
    await settle(dispatch.accepted ? "handed-off" : rejection ?? "failed", dispatch.error);
  }, async (error: unknown) => {
    await settle("unknown", String(error));
  }).catch(() => {
    // TaskStore's existing timeout/restart recovery marks unconfirmed receipts
    // unknown. Never retry an input whose admission may already have succeeded.
    console.warn("[task-notification] Session handoff receipt not committed");
  });
  return result;
}

/** Only admission-owned context may select a default recipient. Never retain
 * caller-supplied provenance, including on an otherwise authorized public CLI. */
export function taskNotificationContext(
  engine: SessionEngine,
  payload: Record<string, unknown>,
  caller: { kind: string },
): Record<string, unknown> {
  const result = { ...payload };
  delete result.notificationContext;
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID;
  if (caller.kind === "external-cli" || !sidecarId) return result;
  const queueId = engine.getExecutionTurnId();
  if (!queueId) return result;
  const turn = engine.getCurrentTurnIdentity();
  result.notificationContext = {
    sidecarId,
    queueId,
    conversation: engine.getNotificationConversation(),
    ...(turn?.owner.kind === "task" ? { taskId: turn.owner.id } : {}),
  };
  return result;
}
